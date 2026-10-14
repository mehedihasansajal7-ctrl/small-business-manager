import { randomUUID } from 'node:crypto';
import { classifyRevision, type OutboxEvent } from '@sbm/domain';
import type { Caller, Repository } from './repository.js';
import { HttpError } from './http.js';

/**
 * Offline-first synchronisation.
 *
 * The server is the authority: each outbox event is applied exactly once, inside
 * a transaction, keyed by its idempotency key. Retrying the same event never
 * duplicates a sale, payment, stock movement or journal posting.
 */

export interface PushResult {
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly status: 'SYNCED' | 'CONFLICT' | 'REJECTED' | 'NEEDS_ATTENTION';
  readonly serverRevision?: number;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly result?: unknown;
  readonly message?: string;
}

/** Events that must never be applied from an offline queue without review. */
const ONLINE_ONLY_EVENTS = new Set(['member.role_change', 'member.invite', 'business.transfer_ownership', 'opening_balance.set']);

/** Aggregate tables that carry a `revision` column for conflict detection. */
const REVISION_TABLES: Record<string, { table: string; idColumn: string }> = {
  product: { table: 'products', idColumn: 'id' },
  customer: { table: 'customers', idColumn: 'id' },
  supplier: { table: 'suppliers', idColumn: 'id' },
  production_cycle: { table: 'production_cycles', idColumn: 'id' },
};

export class SyncService {
  constructor(private readonly repo: Repository) {}

  push(caller: Caller, events: readonly OutboxEvent[]): PushResult[] {
    const results: PushResult[] = [];
    for (const event of events) {
      results.push(this.applyOne(caller, event));
    }
    return results;
  }

  private applyOne(caller: Caller, event: OutboxEvent): PushResult {
    if (event.businessId !== caller.business.id) {
      throw HttpError.forbidden('All queued events must belong to the active business');
    }
    const already = this.repo.db.get<{ result: string; server_revision: number }>('SELECT result, server_revision FROM processed_events WHERE idempotency_key = ?', [event.idempotencyKey]);
    if (already) {
      return {
        idempotencyKey: event.idempotencyKey,
        eventId: event.eventId,
        status: 'SYNCED',
        serverRevision: already.server_revision,
        result: safeParse(already.result),
        message: 'Already applied earlier (idempotent replay)',
      };
    }

    if (ONLINE_ONLY_EVENTS.has(event.eventType)) {
      this.repo.db.run(
        `INSERT INTO processed_events (idempotency_key, business_id, event_id, event_type, aggregate_type, aggregate_id, payload_hash, server_revision, result, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, '{}', ?)`,
        [event.idempotencyKey, caller.business.id, event.eventId, event.eventType, event.aggregateType, event.aggregateId, event.payloadHash, new Date().toISOString()],
      );
      return {
        idempotencyKey: event.idempotencyKey,
        eventId: event.eventId,
        status: 'NEEDS_ATTENTION',
        message: 'This action must be completed online because it changes access or ownership.',
      };
    }

    // Revision-based conflict detection for editable master data.
    const revisionTarget = REVISION_TABLES[event.aggregateType];
    if (revisionTarget && event.baseRevision !== null) {
      const row = this.repo.db.get<{ revision: number }>(`SELECT revision FROM ${revisionTarget.table} WHERE ${revisionTarget.idColumn} = ? AND business_id = ?`, [event.aggregateId, caller.business.id]);
      if (row) {
        const verdict = classifyRevision(event.baseRevision, row.revision);
        if (verdict === 'CONFLICT') {
          const detail = { local: event.payload, serverRevision: row.revision, baseRevision: event.baseRevision };
          this.repo.db.run(
            `INSERT INTO sync_conflicts (id, business_id, aggregate_type, aggregate_id, event_id, device_id, actor_id, base_revision, server_revision, differing_fields, auto_mergeable, detail, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '["unknown"]', 0, ?, 'OPEN', ?)`,
            [
              randomUUID(),
              caller.business.id,
              event.aggregateType,
              event.aggregateId,
              event.eventId,
              event.deviceId,
              caller.user.id,
              event.baseRevision,
              row.revision,
              JSON.stringify(detail),
              new Date().toISOString(),
            ],
          );
          return {
            idempotencyKey: event.idempotencyKey,
            eventId: event.eventId,
            status: 'CONFLICT',
            serverRevision: row.revision,
            message: 'Another partner changed this record after you loaded it. Review and re-submit.',
          };
        }
      }
    }

    try {
      const result = this.repo.db.transaction(() => {
        const applied = this.applyEvent(caller, event);
        const revision = this.nextRevision(caller.business.id);
        this.repo.db.run(
          `INSERT INTO processed_events (idempotency_key, business_id, event_id, event_type, aggregate_type, aggregate_id, payload_hash, server_revision, result, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            event.idempotencyKey,
            caller.business.id,
            event.eventId,
            event.eventType,
            event.aggregateType,
            event.aggregateId,
            event.payloadHash,
            revision,
            JSON.stringify(applied ?? {}),
            new Date().toISOString(),
          ],
        );
        return { applied, revision };
      });
      return {
        idempotencyKey: event.idempotencyKey,
        eventId: event.eventId,
        status: 'SYNCED',
        serverRevision: result.revision,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        result: result.applied,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const permanent = error instanceof HttpError && error.status >= 400 && error.status < 500;
      if (permanent) {
        // Record the rejection so a retry does not loop forever.
        this.repo.db.run(
          `INSERT OR IGNORE INTO processed_events (idempotency_key, business_id, event_id, event_type, aggregate_type, aggregate_id, payload_hash, server_revision, result, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [event.idempotencyKey, caller.business.id, event.eventId, event.eventType, event.aggregateType, event.aggregateId, event.payloadHash, JSON.stringify({ rejected: message }), new Date().toISOString()],
        );
      }
      return {
        idempotencyKey: event.idempotencyKey,
        eventId: event.eventId,
        status: permanent ? 'REJECTED' : 'NEEDS_ATTENTION',
        message,
      };
    }
  }

  private nextRevision(businessId: string): number {
    const row = this.repo.db.get<{ revision: number }>('SELECT revision FROM businesses WHERE id = ?', [businessId]);
    const next = (row?.revision ?? 1) + 1;
    this.repo.db.run('UPDATE businesses SET revision = ? WHERE id = ?', [next, businessId]);
    return next;
  }

  /** Map an outbox event onto the same business operation the online API uses. */
  private applyEvent(caller: Caller, event: OutboxEvent): unknown {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.eventType) {
      case 'sale.post':
        return this.repo.createSale(caller, payload);
      case 'purchase.receive':
        return this.repo.createPurchase(caller, payload);
      case 'receipt.post':
        return this.repo.recordCustomerReceipt(caller, payload);
      case 'payment.post':
        return this.repo.recordSupplierPayment(caller, payload);
      case 'income.post':
        return this.repo.recordIncomeExpense(caller, { ...payload, kind: 'INCOME' });
      case 'expense.post':
        return this.repo.recordIncomeExpense(caller, { ...payload, kind: 'EXPENSE' });
      case 'transfer.post':
        return this.repo.recordTransfer(caller, payload);
      case 'capital.contribution':
        return this.repo.recordPartnerCapital(caller, { ...payload, kind: 'CONTRIBUTION' });
      case 'capital.withdrawal':
        return this.repo.recordPartnerCapital(caller, { ...payload, kind: 'WITHDRAWAL' });
      case 'farming.input_issue':
        return this.repo.recordFarmingEvent(caller, { ...payload, eventType: 'INPUT_ISSUE' });
      case 'farming.cost':
        return this.repo.recordFarmingEvent(caller, payload);
      case 'farming.observe':
        return this.repo.recordFarmingEvent(caller, { ...payload, eventType: 'OBSERVATION' });
      case 'farming.mortality':
        return this.repo.recordFarmingEvent(caller, { ...payload, eventType: 'MORTALITY' });
      case 'harvest.post':
        return this.repo.recordHarvest(caller, payload);
      case 'cycle.create':
        return this.repo.createCycle(caller, payload);
      case 'cycle.close':
        return this.repo.closeCycle(caller, String(payload.cycleId ?? ''), payload);
      case 'cost.allocate':
        return this.repo.allocateSharedCost(caller, payload);
      case 'product.upsert':
        return payload.id ? this.repo.updateProduct(caller, String(payload.id), payload) : this.repo.createProduct(caller, payload);
      case 'customer.upsert':
        return this.repo.createCustomer(caller, payload);
      case 'supplier.upsert':
        return this.repo.createSupplier(caller, payload);
      default:
        throw HttpError.badRequest('UNKNOWN_EVENT', `Unsupported sync event type: ${event.eventType}`);
    }
  }

  /**
   * Pull everything the device is missing. `since` is an ISO timestamp; the
   * caller always receives only their own business's rows.
   *
   * Permission-aware redaction matters here: a pull is the whole dataset, so a
   * cashier (who has no `purchase.cost.view`) must not receive unit costs, COGS
   * or purchase prices, and a role without `financial_reports.view` must not
   * receive the journal (which would expose partner capital and full margins).
   */
  pull(caller: Caller, since: string): Record<string, unknown> {
    const businessId = caller.business.id;
    const sinceIso = since || '1970-01-01T00:00:00.000Z';
    const permissions = this.repo.permissions(caller);
    const canSeeCosts = permissions.has('purchase.cost.view');
    // COGS reveals margin, so it is gated on financial visibility, not merely on
    // purchase-cost visibility.
    const canSeeMargins = permissions.has('financial_reports.view');
    const canSeeFarmingCosts = permissions.has('farming.cost.view');
    const canSeeCapital = permissions.has('partner_capital.view');

    /** Copy rows without the fields this caller must not see. */
    const without = (rows: Record<string, unknown>[], fields: readonly string[]): Record<string, unknown>[] =>
      rows.map((row) => {
        const clone = { ...row };
        for (const field of fields) delete clone[field];
        return clone;
      });

    const rows = <T>(sql: string, params: readonly unknown[]) => this.repo.db.all<T>(sql, params);
    const costFields = ['unit_cost', 'cogs', 'purchase_price', 'tax_rate', 'subtotal', 'cost_basis', 'value'];

    let products = rows<Record<string, unknown>>('SELECT * FROM products WHERE business_id = ? AND updated_at > ?', [businessId, sinceIso]);
    if (!canSeeCosts) products = without(products, ['purchase_price', 'tax_rate']);

    let sales = rows<Record<string, unknown>>('SELECT * FROM sales WHERE business_id = ? AND updated_at > ?', [businessId, sinceIso]);
    if (!canSeeMargins) sales = without(sales, ['cogs']);

    let purchases = rows<Record<string, unknown>>('SELECT * FROM purchases WHERE business_id = ? AND updated_at > ?', [businessId, sinceIso]);
    if (!canSeeCosts) purchases = without(purchases, ['subtotal', 'tax']);

    let saleLines = rows<Record<string, unknown>>('SELECT l.* FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE l.business_id = ? AND s.updated_at > ?', [businessId, sinceIso]);
    if (!canSeeCosts) saleLines = without(saleLines, ['unit_cost']);

    let purchaseLines = rows<Record<string, unknown>>('SELECT l.* FROM purchase_lines l JOIN purchases p ON p.id = l.purchase_id WHERE l.business_id = ? AND p.updated_at > ?', [businessId, sinceIso]);
    if (!canSeeCosts) purchaseLines = without(purchaseLines, ['unit_cost']);

    let stockMovements = rows<Record<string, unknown>>('SELECT * FROM stock_movements WHERE business_id = ? AND created_at > ?', [businessId, sinceIso]);
    if (!canSeeCosts) stockMovements = without(stockMovements, ['unit_cost']);

    let harvests = rows<Record<string, unknown>>('SELECT * FROM harvests WHERE business_id = ? AND created_at > ?', [businessId, sinceIso]);
    if (!canSeeFarmingCosts) harvests = without(harvests, ['cost_basis', 'unit_cost']);

    // The journal and cost allocations are withheld entirely, not just trimmed:
    // a line-level view cannot be redacted usefully.
    const journalEntries = canSeeMargins ? rows<Record<string, unknown>>('SELECT * FROM journal_entries WHERE business_id = ? AND created_at > ?', [businessId, sinceIso]) : [];
    let journalLines = canSeeMargins
      ? rows<Record<string, unknown>>('SELECT l.* FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.business_id = ? AND e.created_at > ?', [businessId, sinceIso])
      : [];
    if (!canSeeCapital) journalLines = without(journalLines, ['partner_id']);
    const costAllocations = canSeeFarmingCosts ? rows<Record<string, unknown>>('SELECT * FROM cost_allocations WHERE business_id = ? AND created_at > ?', [businessId, sinceIso]) : [];

    // A conflict's `detail` carries the raw payloads, so only roles that may see
    // margins get the body; everybody still sees that a conflict needs resolving.
    let conflicts = rows<Record<string, unknown>>(`SELECT * FROM sync_conflicts WHERE business_id = ? AND status = 'OPEN'`, [businessId]);
    if (!canSeeMargins) conflicts = without(conflicts, ['detail']);

    void costFields;

    return {
      since,
      serverTime: new Date().toISOString(),
      serverTimeIso: new Date().toISOString(),
      businessRevision: this.repo.getBusiness(businessId).revision,
      costVisibility: { unitCosts: canSeeCosts, cogsAndMargins: canSeeMargins, financialReports: canSeeMargins, farmingCosts: canSeeFarmingCosts, partnerCapital: canSeeCapital },
      business: (() => {
        const b = this.repo.getBusiness(businessId);
        return { id: b.id, name: b.name, currency: b.currency, timezone: b.timezone, locale: b.locale, farmingTypes: JSON.parse(b.farming_types || '[]'), revision: b.revision };
      })(),
      products,
      customers: rows('SELECT * FROM customers WHERE business_id = ? AND updated_at > ?', [businessId, sinceIso]),
      suppliers: rows('SELECT * FROM suppliers WHERE business_id = ? AND updated_at > ?', [businessId, sinceIso]),
      locations: rows('SELECT * FROM locations WHERE business_id = ? AND created_at > ?', [businessId, sinceIso]),
      sales,
      saleLines,
      purchases,
      purchaseLines,
      stockMovements,
      journalEntries,
      journalLines,
      farms: rows('SELECT * FROM farms WHERE business_id = ? AND updated_at > ?', [businessId, sinceIso]),
      farmUnits: rows('SELECT * FROM farm_units WHERE business_id = ? AND created_at > ?', [businessId, sinceIso]),
      cycles: rows('SELECT * FROM production_cycles WHERE business_id = ? AND updated_at > ?', [businessId, sinceIso]),
      farmingEvents: rows('SELECT * FROM farming_events WHERE business_id = ? AND created_at > ?', [businessId, sinceIso]),
      harvests,
      costAllocations,
      conflicts,
    };
  }

  listConflicts(caller: Caller): unknown[] {
    return this.repo.db.all('SELECT * FROM sync_conflicts WHERE business_id = ? ORDER BY created_at DESC LIMIT 200', [caller.business.id]);
  }

  resolveConflict(caller: Caller, conflictId: string, resolution: 'LOCAL_WINS' | 'SERVER_WINS'): void {
    const changed = this.repo.db.run(`UPDATE sync_conflicts SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND business_id = ? AND status = 'OPEN'`, [
      resolution,
      new Date().toISOString(),
      caller.user.id,
      conflictId,
      caller.business.id,
    ]).changes;
    if (changed === 0) throw HttpError.notFound('Open conflict not found');
    this.repo.audit({ businessId: caller.business.id, actorId: caller.user.id, action: 'conflict.resolve', entityType: 'sync_conflict', entityId: conflictId, detail: { resolution } });
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
