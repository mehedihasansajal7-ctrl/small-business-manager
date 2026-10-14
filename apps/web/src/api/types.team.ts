/** Response shapes for this area of the API. */
export interface MemberRow {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
  readonly grants: readonly string[];
  readonly denials: readonly string[];
  readonly joinedAt: string;
  readonly lastActiveAt: string | null;
}
export interface InviteRow {
  readonly id: string;
  readonly email: string | null;
  readonly role: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly uses: number;
  readonly maxUses: number;
  readonly codePrefix: string;
}
export interface CreatedInvite {
  readonly code: string;
  readonly invite: {
    readonly id: string;
    readonly role: string;
    readonly email: string | null;
    readonly expiresAt: string;
    readonly codePrefix: string;
  };
}
export interface AuditRow {
  readonly id: string;
  readonly actor: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly detail: Record<string, unknown>;
  readonly at: string;
}
export interface ConflictRow {
  readonly id: string;
  readonly business_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_id: string;
  readonly device_id: string | null;
  readonly actor_id: string | null;
  readonly base_revision: number | null;
  readonly server_revision: number | null;
  readonly differing_fields: string;
  readonly auto_mergeable: number;
  readonly detail: string;
  readonly status: string;
  readonly created_at: string;
  readonly resolved_at?: string | null;
}
/** `POST /api/sync/push` result for one event. */
export interface PushResultRow {
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly status: 'SYNCED' | 'CONFLICT' | 'REJECTED' | 'NEEDS_ATTENTION';
  readonly serverRevision?: number;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly result?: unknown;
  readonly message?: string;
}
