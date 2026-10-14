import { describe, expect, it } from 'vitest';
import { permissionsFor, ROLE_PERMISSIONS, type Permission } from '@sbm/domain';
import {
  canViewCost,
  canViewFarmingCost,
  canViewFinancialReports,
  canViewPartnerCapital,
  visibleColumns,
  redactCycleCost,
  redactFields,
  redactInventoryCost,
  redactProductCost,
  redactPurchaseCost,
  redactSaleCost,
} from '../src/api/permissions';

/** Permissions exactly as `GET /api/businesses/current` returns them. */
const owner = [...permissionsFor('owner')] as Permission[];
const cashier = [...permissionsFor('cashier')] as Permission[];
const viewer = [...permissionsFor('viewer')] as Permission[];
const farmManager = [...permissionsFor('farm_manager')] as Permission[];

describe('permission gating', () => {
  it('knows who may see cost, financial and capital figures', () => {
    expect(canViewCost(owner)).toBe(true);
    expect(canViewCost(cashier)).toBe(false);
    expect(canViewFinancialReports(owner)).toBe(true);
    expect(canViewFinancialReports(cashier)).toBe(false);
    expect(canViewPartnerCapital(owner)).toBe(true);
    expect(canViewPartnerCapital(cashier)).toBe(false);
    expect(canViewFarmingCost(farmManager)).toBe(true);
    expect(canViewFarmingCost(viewer)).toBe(false);
  });

  it('honours the owner’s visibility settings for non-privileged roles', () => {
    const widened = [...permissionsFor('cashier', {}, { partnerCanSeeCosts: true, partnerCanSeeFinancialReports: true })];
    expect(canViewCost(widened)).toBe(true);
    expect(canViewFinancialReports(widened)).toBe(true);
  });

  it('hides a column whose permission the caller lacks', () => {
    const columns = [
      { id: 'name' },
      { id: 'cogs', permission: 'purchase.cost.view' },
      { id: 'net', permission: 'sale.view' },
    ];
    expect(visibleColumns(columns, cashier).map((column) => column.id)).toEqual(['name', 'net']);
    expect(visibleColumns(columns, owner).map((column) => column.id)).toEqual(['name', 'cogs', 'net']);
  });

  it('supports columns that need several permissions at once', () => {
    const columns = [{ id: 'margin', permissions: ['sale.view', 'purchase.cost.view'] }, { id: 'plain' }];
    expect(visibleColumns(columns, ROLE_PERMISSIONS.cashier).map((column) => column.id)).toEqual(['plain']);
    expect(visibleColumns(columns, ROLE_PERMISSIONS.owner).map((column) => column.id)).toEqual(['margin', 'plain']);
  });
});

describe('field redaction for a role without cost visibility', () => {
  const product = { id: 'p1', name: 'Rice', salePrice: '68', purchasePrice: '58', taxRate: '5' };
  const sale = { id: 's1', reference: 'SAL-1', net: '3300', cogs: '2900', grossProfit: '400' };
  const inventory = { itemId: 'p1', onHand: '50', unitCost: '58', value: '2900' };
  const purchase = { id: 'pu1', total: '5800', subtotal: '5800', tax: '0' };
  const cycle = { id: 'c1', title: 'Batch 1', costToDate: '9000', revenue: '87500', cogs: '4500', grossProfit: '83000' };

  it('strips cost fields and keeps everything else', () => {
    expect(redactProductCost(product, cashier)).toEqual({ id: 'p1', name: 'Rice', salePrice: '68' });
    expect(redactSaleCost(sale, cashier)).toEqual({ id: 's1', reference: 'SAL-1', net: '3300' });
    expect(redactInventoryCost(inventory, cashier)).toEqual({ itemId: 'p1', onHand: '50' });
    expect(redactPurchaseCost(purchase, cashier)).toEqual({ id: 'pu1', total: '5800' });
  });

  it('redacts farm cost separately from purchase cost', () => {
    expect(redactCycleCost(cycle, viewer)).toEqual({ id: 'c1', title: 'Batch 1' });
    expect(redactCycleCost(cycle, farmManager)).toEqual(cycle);
  });

  it('returns the row untouched when the caller is allowed', () => {
    expect(redactProductCost(product, owner)).toBe(product);
    expect(redactSaleCost(sale, owner)).toBe(sale);
  });

  it('never mutates the original row', () => {
    const original = { ...product };
    redactProductCost(product, cashier);
    expect(product).toEqual(original);
  });

  it('is a no-op for an allowed role and removes every listed field for a denied one', () => {
    expect(redactFields(product, ['secret'], true)).toBe(product);
    const redacted = redactFields(product, ['secret', 'purchasePrice'], false);
    expect('secret' in redacted).toBe(false);
    expect('purchasePrice' in redacted).toBe(false);
  });
});
