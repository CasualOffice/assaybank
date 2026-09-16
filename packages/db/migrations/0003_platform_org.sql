-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0003_platform_org — reserve the nil UUID as the platform organisation.
--
-- Two places already treat 00000000-0000-0000-0000-000000000000 as an
-- organisation that owns no rows:
--
--   apps/api          the readiness probe runs withOrg() as the nil org, so
--                     the probe exercises the real request path without any
--                     chance of reading a tenant row.
--   packages/db       withElevated() writes its audit_log row against the nil
--                     org when the job acts for no single tenant — a deadline
--                     sweep, a retention pass, a queue drain.
--
-- Both are only sound while no organisation can actually have that id. Until
-- this migration that was a convention: true today, and quietly false the
-- first time someone seeds a fixture with an all-zero UUID or a customer
-- imports one. A convention protecting an isolation boundary is not a
-- protection, so it becomes a CHECK.
--
-- What the CHECK buys, concretely:
--
--   * The readiness probe cannot be made to read a real row by creating the
--     wrong organisation.
--   * `org_id = public.app_current_org()` is false on every platform audit
--     row for every tenant, so those rows are invisible to all of them —
--     which is the right visibility for a row describing the platform. No
--     policy change is needed to get it, and audit_log.org_id can stay
--     NOT NULL. A nullable tenant key on an isolation-critical table is a
--     NULL that some future policy admits by accident.
--
-- Expand-contract (docs/17 §4): NOT VALID first, VALIDATE second. On a fresh
-- database the two steps are indistinguishable from adding the constraint
-- outright; on a populated one the split is what keeps the table readable and
-- writable while the scan runs, and doing it the cheap way here would teach
-- the wrong habit for the migration where it matters.
--
-- Forward-only, and re-running is a no-op: both steps are guarded.
-- ============================================================

DO $expand$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'organizations_id_not_platform'
           AND conrelid = 'public.organizations'::regclass
    ) THEN
        ALTER TABLE organizations
            ADD CONSTRAINT organizations_id_not_platform
            CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid)
            NOT VALID;
    END IF;
END
$expand$;
--> statement-breakpoint

DO $validate$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'organizations_id_not_platform'
           AND conrelid = 'public.organizations'::regclass
           AND NOT convalidated
    ) THEN
        ALTER TABLE organizations VALIDATE CONSTRAINT organizations_id_not_platform;
    END IF;
END
$validate$;
--> statement-breakpoint

COMMENT ON CONSTRAINT organizations_id_not_platform ON organizations IS
    'The nil UUID is reserved for the platform itself: the API readiness probe and the '
    'audit row written by withElevated() for cross-tenant work. No organisation may hold '
    'it, so neither can ever reach a real tenant row.';
