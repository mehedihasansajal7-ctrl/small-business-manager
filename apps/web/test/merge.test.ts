import { describe, expect, it } from 'vitest';
import { normalizeRows } from '../src/offline/normalize';
import { markPending, overlayPending, planMerge, stripLocalMarkers, type PullPayload } from '../src/offline/merge';

const pull: PullPayload = {
  since: '2026-04-01T00:00:00.000Z',
  serverTime: '2026-04-10T12:00:00.000Z',
  businessRevision: 12,
  business: { id: 'biz-1', name: 'Shop', currency: 'BDT', timezone: 'Asia/Dhaka', locale: 'bn-BD', farmingTypes: ['POULTRY'], revision: 12 },
  products: [{ id: 'p1', name: 'Rice', unit: 'kg', updated_at: '2026-04-09T00:00:00.000Z' }],
  sales: [{ id: 's1', reference: 'SAL-1', net: '3300.00', cash_received: '3000.00', receivable: '300.00', document_date: '2026-04-05', currency: 'BDT' }],
  customers: [],
  stockMovements: [{ id: 'm1', item_id: 'p1', direction: 'OUT', quantity: '50' }],
  conflicts: [{ id: 'c1', status: 'OPEN' }],
};

describe('pull merge planning', () => {
  it('plans one upsert per non-empty collection and keeps the server clock', () => {
    const plan = planMerge(pull);
    const stores = plan.upserts.map((row) => row.store).sort();
    expect(stores).toEqual(['products', 'sales', 'stockMovements']);
    expect(plan.rowCount).toBe(3);
    expect(plan.serverTime).toBe('2026-04-10T12:00:00.000Z');
    expect(plan.business?.id).toBe('biz-1');
    expect(plan.conflicts).toHaveLength(1);
  });

  it('skips empty collections entirely, so nothing is needlessly written', () => {
    const plan = planMerge(pull);
    expect(plan.upserts.some((row) => row.store === 'customers')).toBe(false);
  });

  it('tolerates a malformed payload instead of throwing', () => {
    const plan = planMerge({ products: 'not-an-array' as unknown as never, serverTime: 42 as unknown as string });
    expect(plan.upserts).toEqual([]);
    expect(plan.serverTime).toBeNull();
    expect(plan.business).toBeNull();
  });
});

describe('local drafts survive a pull', () => {
  it('lets an unsynced local draft win over the server copy', () => {
    const server = [
      { id: 'p1', name: 'Rice (server)' },
      { id: 'p2', name: 'Feed' },
    ];
    const pending = [{ id: 'p1', name: 'Rice (my edit)' }];
    const merged = overlayPending(server, pending, 'id');
    expect(merged.find((row) => row.id === 'p1')?.name).toBe('Rice (my edit)');
    expect(merged.find((row) => row.id === 'p2')?.name).toBe('Feed');
  });

  it('keeps a draft the server does not know about yet', () => {
    const merged = overlayPending([{ id: 'p1', name: 'Rice' }], [{ id: 'local-9', name: 'New item' }], 'id');
    expect(merged.map((row) => row.id)).toEqual(['p1', 'local-9']);
  });

  it('returns the server rows untouched when there is nothing pending', () => {
    const server = [{ id: 'p1', name: 'Rice' }];
    expect(overlayPending(server, [], 'id')).toEqual(server);
  });

  it('marks and then strips the local markers used by the screens', () => {
    const marked = markPending({ id: 'local-1', name: 'Draft' }, 'evt-1');
    expect(marked.__pending).toBe(true);
    expect(marked.__eventId).toBe('evt-1');
    const clean = stripLocalMarkers(marked);
    expect('__pending' in clean).toBe(false);
    expect('__eventId' in clean).toBe(false);
  });
});

describe('normalising raw sync rows', () => {
  it('turns snake_case product columns into the shape the screens use', () => {
    const [row] = normalizeRows('products', [
      { id: 'b', item_id: 'ignored', name: 'Rice', name_bn: 'চাল', unit: 'kg', sale_price: '68.00', purchase_price: '58.00', reorder_level: '10', is_active: 1, track_lots: 0, revision: 3 },
    ]);
    expect(row).toMatchObject({ id: 'b', name: 'Rice', nameBn: 'চাল', salePrice: '68.00', purchasePrice: '58.00', reorderLevel: '10', isActive: true, trackLots: false, revision: 3 });
  });

  it('normalises sale totals and keeps them as exact strings', () => {
    const [row] = normalizeRows('sales', [{ id: 's1', reference: 'SAL-1', net: '3300.00', cash_received: '3000.00', receivable: '300.00', cogs: '2900.00' }]);
    expect(row).toMatchObject({ id: 's1', net: '3300.00', cashReceived: '3000.00', receivable: '300.00', cogs: '2900.00' });
  });

  it('keys inventory rows by itemId', () => {
    const [row] = normalizeRows('inventory', [{ itemId: 'p1', name: 'Rice', unit: 'kg', onHand: '50', belowReorder: true }]);
    expect(row).toMatchObject({ itemId: 'p1', onHand: '50', belowReorder: true });
  });

  it('leaves collections without a normaliser untouched', () => {
    const rows = [{ id: 'j1', business_id: 'biz-1', entry_date: '2026-04-01' }];
    expect(normalizeRows('journalEntries', rows)).toEqual(rows);
  });
});
