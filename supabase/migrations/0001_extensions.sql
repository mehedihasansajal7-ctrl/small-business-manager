-- =============================================================================
-- 0001_extensions.sql
-- Small Business Manager — shared-cloud (PostgreSQL / Supabase) schema.
--
-- This schema is the same domain model as `apps/api/src/db.ts` (embedded SQLite,
-- migrations v1..v6) ported to PostgreSQL. Table and column names match the
-- SQLite names so the two stores stay interchangeable for the same domain
-- logic, with three deliberate upgrades:
--
--   * money / quantity  -> numeric(20,6)   (exact, never float/real)
--   * booleans          -> boolean         (SQLite used 0/1)
--   * JSON text columns -> jsonb
--   * timestamps        -> timestamptz, dates -> date
--   * ids               -> uuid with gen_random_uuid()
--
-- Every tenant-owned table carries `business_id uuid not null references
-- businesses(id) on delete cascade`; row level security (0007) is the tenant
-- boundary. Migrations are ordered and are meant to be applied once by the
-- Supabase migration runner (`supabase db push`); most statements are also
-- written to be safe to re-run by hand.
-- =============================================================================

-- gen_random_uuid() is in core PostgreSQL >= 13; pgcrypto keeps older servers
-- and plain PostgreSQL installs working. sha256() (used for invite hashes) is
-- a core function in PostgreSQL >= 11, so no extension is needed for it.
create extension if not exists pgcrypto;

-- Internal helpers (trigger functions, guards). Not exposed over the API.
create schema if not exists app;

comment on schema app is
  'Internal helpers for Small Business Manager: audit triggers, integrity guards. Not part of the public API surface.';

-- -----------------------------------------------------------------------------
-- Identity of the current caller
--
-- On Supabase a request carries a JWT and `auth.uid()` returns the
-- authenticated user id (equal to `public.profiles.id`). On a plain PostgreSQL
-- server there is no `auth` schema and the JWT claims are simply absent, in
-- which case this returns NULL. NULL deliberately means "no end-user context"
-- (migrations, seeds, trusted server-side jobs) — trusted code is exempt from
-- the member-level guards, while every request that carries a JWT is checked.
-- -----------------------------------------------------------------------------
create or replace function public.current_profile_id()
returns uuid
language plpgsql
stable
as $fn$
declare
  v_claim text;
  v_uid uuid;
begin
  -- Supabase sets request.jwt.claims (json) / request.jwt.claim.sub.
  begin
    v_claim := nullif(current_setting('request.jwt.claim.sub', true), '');
    if v_claim is not null then
      v_uid := v_claim::uuid;
    end if;
  exception when others then
    v_uid := null;
  end;

  if v_uid is null then
    begin
      v_claim := current_setting('request.jwt.claims', true);
      if v_claim is not null and v_claim <> '' then
        v_uid := nullif(v_claim::jsonb ->> 'sub', '')::uuid;
      end if;
    exception when others then
      v_uid := null;
    end;
  end if;

  if v_uid is null then
    begin
      -- Present on Supabase only; the `auth` schema does not exist elsewhere.
      v_uid := auth.uid();
    exception when others then
      v_uid := null;
    end;
  end if;

  return v_uid;
end;
$fn$;

comment on function public.current_profile_id() is
  'Authenticated profile id from the request JWT (Supabase auth.uid()); NULL for trusted server-side/seed/migration contexts.';
