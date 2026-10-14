-- =============================================================================
-- 0006_sync_ai_attachments.sql
-- Ports SQLite `processed_events`, `sync_conflicts`, `ai_conversations`,
-- `ai_messages`, `ai_saved_plans`, `ai_feedback`, `ai_research_cache`,
-- `ai_usage` (db.ts v5) and adds `sync_events`, the server mirror of a client's
-- offline outbox (packages/domain/src/sync.ts).
--
-- Idempotency: every outbox event carries an idempotency key. `processed_events`
-- is keyed by that key, so replaying an event can never post twice. The
-- transactional functions in ../functions/ all consult this table first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sync_events — server-side mirror of a device's outbox, so a partner can see
-- what is still pending from another device and support can explain a conflict.
-- -----------------------------------------------------------------------------
create table if not exists public.sync_events (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  local_id        text not null,
  event_id        text not null,
  idempotency_key text not null,
  device_id       uuid references public.devices(id) on delete set null,
  actor_id        uuid references public.profiles(id) on delete set null,
  aggregate_type  text not null,
  aggregate_id    text not null,
  event_type      text not null,
  schema_version  integer not null default 1,
  risk            text not null default 'LOW',
  status          text not null default 'PENDING',
  attempts        integer not null default 0,
  base_revision   integer,
  payload_hash    text not null,
  payload         jsonb not null default '{}'::jsonb,
  occurred_at     timestamptz not null,
  last_attempt_at timestamptz,
  synced_at       timestamptz,
  created_at      timestamptz not null default now(),
  constraint sync_events_business_event_unique unique (business_id, event_id),
  constraint sync_events_business_idempotency_unique unique (business_id, idempotency_key),
  constraint sync_events_risk_check check (risk in ('LOW', 'HIGH')),
  constraint sync_events_status_check check (status in
    ('PENDING', 'SYNCING', 'SYNCED', 'NEEDS_ATTENTION', 'CONFLICT', 'REJECTED')),
  constraint sync_events_attempts_check check (attempts >= 0),
  constraint sync_events_schema_version_check check (schema_version >= 1),
  constraint sync_events_payload_object check (jsonb_typeof(payload) = 'object')
);

-- -----------------------------------------------------------------------------
-- processed_events — the idempotency ledger. `idempotency_key` is the PRIMARY
-- KEY, so "apply exactly once" is a database guarantee, not application hope.
-- Append-only: no UPDATE/DELETE policy in 0007.
-- -----------------------------------------------------------------------------
create table if not exists public.processed_events (
  idempotency_key text primary key,
  business_id     uuid not null references public.businesses(id) on delete cascade,
  event_id        text not null,
  event_type      text not null,
  aggregate_type  text not null,
  aggregate_id    text not null,
  payload_hash    text not null,
  server_revision integer not null default 0,
  result          jsonb not null default '{}'::jsonb,
  processed_at    timestamptz not null default now(),
  constraint processed_events_result_object check (jsonb_typeof(result) = 'object'),
  constraint processed_events_revision_check check (server_revision >= 0)
);

-- -----------------------------------------------------------------------------
-- sync_conflicts — a record that another partner changed the same aggregate.
-- -----------------------------------------------------------------------------
create table if not exists public.sync_conflicts (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  aggregate_type   text not null,
  aggregate_id     text not null,
  event_id         text not null,
  device_id        uuid references public.devices(id) on delete set null,
  actor_id         uuid references public.profiles(id) on delete set null,
  base_revision    integer,
  server_revision  integer not null,
  differing_fields jsonb not null default '[]'::jsonb,
  auto_mergeable   boolean not null default false,
  detail           jsonb not null default '{}'::jsonb,
  status           text not null default 'OPEN',
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      uuid references public.profiles(id) on delete set null,
  constraint sync_conflicts_status_check check (status in
    ('OPEN', 'LOCAL_WINS', 'SERVER_WINS', 'MERGED', 'DISMISSED')),
  constraint sync_conflicts_differing_fields_array check (jsonb_typeof(differing_fields) = 'array'),
  constraint sync_conflicts_detail_object check (jsonb_typeof(detail) = 'object'),
  constraint sync_conflicts_resolution_fields check ((status = 'OPEN') = (resolved_at is null))
);

-- -----------------------------------------------------------------------------
-- AI agent: conversations, messages, saved plans, feedback, research cache,
-- usage metering. The AI is advisory: messages record their mode/provider so a
-- fallback (no external provider, zero cost) answer is never mistaken for a
-- model answer, and plans are always reviewed by a human before posting.
-- -----------------------------------------------------------------------------
create table if not exists public.ai_conversations (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  title         text not null,
  language      text not null default 'bn',
  context_scope text not null default 'business',
  fields_shared jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint ai_conversations_language_check check (language in ('bn', 'en')),
  constraint ai_conversations_scope_check check (context_scope in ('business', 'cycle', 'document', 'none')),
  constraint ai_conversations_fields_shared_array check (jsonb_typeof(fields_shared) = 'array')
);

create table if not exists public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role            text not null,
  content         text not null,
  mode            text not null default 'fallback',
  provider        text not null default 'none',
  citations       jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  constraint ai_messages_role_check check (role in ('user', 'assistant', 'system')),
  constraint ai_messages_mode_check check (mode in ('fallback', 'provider', 'cached', 'manual')),
  constraint ai_messages_citations_array check (jsonb_typeof(citations) = 'array')
);

create table if not exists public.ai_saved_plans (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null default 'PLAN',
  title       text not null,
  content     text not null,
  status      text not null default 'DRAFT',
  created_at  timestamptz not null default now(),
  constraint ai_saved_plans_kind_check check (kind in ('PLAN', 'CHECKLIST', 'NOTE', 'RESEARCH')),
  constraint ai_saved_plans_status_check check (status in ('DRAFT', 'REVIEWED', 'APPLIED', 'DISCARDED'))
);

create table if not exists public.ai_feedback (
  id         uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  message_id uuid not null references public.ai_messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  helpful    boolean not null,
  comment    text,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_research_cache (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  query_hash  text not null,
  query       text not null,
  provider    text not null,
  sources     jsonb not null default '[]'::jsonb,
  fetched_at  timestamptz not null default now(),
  accessed_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  constraint ai_research_cache_business_query_unique unique (business_id, query_hash),
  constraint ai_research_cache_sources_array check (jsonb_typeof(sources) = 'array'),
  constraint ai_research_cache_expiry_check check (expires_at > fetched_at)
);

create table if not exists public.ai_usage (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id     uuid references public.profiles(id) on delete set null,
  provider    text not null,
  mode        text not null,
  tokens_in   integer not null default 0,
  tokens_out  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint ai_usage_tokens_check check (tokens_in >= 0 and tokens_out >= 0)
);
