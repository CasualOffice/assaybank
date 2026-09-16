-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0006_staff_identity — the rows Better Auth needs, and the one lookup that
-- routes an unauthenticated login to a tenant.
--
-- P1 step 3. `docs/hiring_platform_schema.sql` models the product and stops
-- short of modelling how a staff member proves who they are, because that is
-- a library's concern and the library (docs/14 T-014: Better Auth) was chosen
-- afterwards. Better Auth has four models. Two of them become tables here,
-- one is folded into the existing `users`, and one is deliberately not a
-- table at all:
--
--   user          -> users, plus the three columns added below
--   account       -> staff_accounts       (password hash, OIDC link)
--   verification  -> staff_verifications  (OIDC state and PKCE, in flight)
--   session       -> Valkey, not Postgres (see below)
--
-- WHY SESSIONS ARE NOT HERE. Every tenant policy is
-- `org_id = app_current_org()`, and `app.current_org` comes from the session.
-- A session table would have to be read before the organisation is known, in
-- order to discover the organisation — and the only ways to read it are a
-- request-path role that bypasses row-level security, or a session table with
-- no policy. Both are worse than keeping sessions in Valkey keyed by their own
-- token, where resolving a cookie to an organisation touches no tenant row at
-- all. See packages/db/src/schema/staff-identity.ts.
--
-- EXPAND-CONTRACT. Every column added to `users` is nullable or has a default,
-- so a running API that has never heard of them keeps inserting rows
-- successfully. There is no contract step: nothing is dropped and nothing is
-- renamed.
--
-- Forward-only, and re-running is a no-op: every statement is guarded.
-- ============================================================

-- ------------------------------------------------------------
-- users — the three columns Better Auth's user model expects
-- ------------------------------------------------------------
-- email_verified defaults to true because there is no self-service staff
-- sign-up to verify against: an administrator or an identity provider created
-- the row, and that act is the verification. Nothing gates on the column today
-- (requireEmailVerification is off); it exists because the model has it, and a
-- model field with no column is an insert that fails on a login rather than at
-- boot.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true;
--> statement-breakpoint

ALTER TABLE users ADD COLUMN IF NOT EXISTS image text;
--> statement-breakpoint

ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint

COMMENT ON COLUMN users.password_hash IS
    'Legacy of docs/hiring_platform_schema.sql. Staff passwords live in '
    'staff_accounts.password, which is Better Auth''s account model. Two places to rotate '
    'a password is one place to forget, so this column is not maintained in parallel.';
--> statement-breakpoint

-- ------------------------------------------------------------
-- staff_accounts — Better Auth's `account` model
-- ------------------------------------------------------------
-- org_id DEFAULT public.app_current_org() is load-bearing. Better Auth does
-- not know this system is multi-tenant and will never supply the column, so
-- the value comes from the transaction the insert runs in — the same
-- transaction whose WITH CHECK clause then verifies it. An insert attempted
-- outside withOrg() gets NULL and fails the NOT NULL, which is the correct
-- outcome rather than a row belonging to nobody.
CREATE TABLE IF NOT EXISTS staff_accounts (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                      uuid NOT NULL DEFAULT public.app_current_org()
                                    REFERENCES organizations(id) ON DELETE CASCADE,
    user_id                     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id                  text NOT NULL,
    provider_id                 text NOT NULL,
    password                    text,
    access_token                text,
    refresh_token               text,
    id_token                    text,
    access_token_expires_at     timestamptz,
    refresh_token_expires_at    timestamptz,
    scope                       text,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_accounts_provider_id_account_id_key UNIQUE (provider_id, account_id)
);
--> statement-breakpoint

-- Global rather than per-organisation, and that is the point of it: an IdP
-- subject identifies one human at one identity provider, so letting the same
-- (provider, subject) pair map to staff rows in two organisations would mean
-- one federated identity quietly holding two sets of permissions — the
-- multi-tenant shape of docs/14 T-015.
CREATE INDEX IF NOT EXISTS staff_accounts_user_id_idx ON staff_accounts (user_id);
--> statement-breakpoint

COMMENT ON TABLE staff_accounts IS
    'Better Auth''s account model. provider_id = ''credential'' carries the Argon2id '
    'password hash; a federated account carries the IdP subject and tokens instead.';
--> statement-breakpoint

-- ------------------------------------------------------------
-- staff_verifications — Better Auth's `verification` model
-- ------------------------------------------------------------
-- Rows live for minutes and are consumed exactly once: Better Auth deletes the
-- row while validating the callback, which is what makes a replayed `code`
-- fail with a state mismatch rather than logging somebody in twice
-- (docs/14 H-124).
--
-- It carries a tenant key even though it is written before anyone has
-- authenticated, because POST /auth/oidc/start has already resolved which
-- organisation the sign-in is for. The organisation is known even when the
-- person is not, and scoping the row means one tenant's OIDC flow cannot
-- consume another's state.
CREATE TABLE IF NOT EXISTS staff_verifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL DEFAULT public.app_current_org()
                        REFERENCES organizations(id) ON DELETE CASCADE,
    identifier      text NOT NULL,
    value           text NOT NULL,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS staff_verifications_identifier_idx
    ON staff_verifications (identifier);
--> statement-breakpoint

-- The sweep that deletes expired rows reads this. Without it the cleanup is a
-- sequential scan of a table that only ever grows between sweeps.
CREATE INDEX IF NOT EXISTS staff_verifications_expires_at_idx
    ON staff_verifications (expires_at);
--> statement-breakpoint

COMMENT ON TABLE staff_verifications IS
    'Better Auth''s verification model: OIDC state and PKCE material, in flight. '
    'Consumed exactly once and expired within minutes.';
--> statement-breakpoint

-- ------------------------------------------------------------
-- Row-level security on both new tables (ADR-010)
-- ------------------------------------------------------------
-- Same predicate as every Group A table in 0002. src/rls-tables.ts derives
-- TENANT_TABLES from the Drizzle schema by looking for a column named org_id,
-- so both of these are already in the generated isolation suite; the policies
-- below are what make that suite pass.
ALTER TABLE staff_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON staff_accounts;
CREATE POLICY org_isolation ON staff_accounts
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE staff_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON staff_verifications;
CREATE POLICY org_isolation ON staff_verifications
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

-- 0002 set ALTER DEFAULT PRIVILEGES for tables created after it, so the two
-- tables above are already granted to both application roles. This block is
-- the belt to that braces: default privileges apply only to objects created by
-- the role that set them, and a migration run by a different owner would
-- silently produce two tables the API cannot read.
DO $grants$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiring_app')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiring_job') THEN
        RAISE NOTICE 'Application roles absent; skipping grants on the staff identity tables.';
        RETURN;
    END IF;

    GRANT SELECT, INSERT, UPDATE, DELETE ON staff_accounts, staff_verifications
        TO hiring_app, hiring_job;
END
$grants$;
--> statement-breakpoint

-- ============================================================
-- Tenant routing for a login, which arrives with no tenant
-- ============================================================
-- `POST /auth/login` is the staff twin of the problem 0005 solved for
-- candidates: the request carries a credential and no organisation, and
-- `app_current_org()` returns NULL when nothing has been set, which denies
-- rather than admits. So `users` cannot be read by email to discover the
-- organisation, because the organisation must already be known to read
-- anything.
--
-- Two functions, each returning exactly one uuid and nothing else.
--
-- WHO MAY CALL THEM. EXECUTE is revoked from PUBLIC and granted to
-- `hiring_app` and `hiring_job` — both, explicitly, because `withElevated()`
-- runs the lookup on the job role and a grant that arrived only from 0002's
-- ALTER DEFAULT PRIVILEGES would be one edit away from breaking every login.
-- Granting the job role nothing it did not already have: it holds BYPASSRLS
-- (ADR-010) and can read `users` directly, so the function widens no
-- privilege — it narrows one, by being the only shape in which the app role
-- can ask.
--
-- WHAT THEY DISCLOSE, STATED PLAINLY. `staff_login_org_for_email` returns an
-- organisation id when exactly one non-archived staff row holds that address,
-- so a caller holding EXECUTE learns whether an address has an account. The
-- disclosure is bounded by who holds it — no unauthenticated party does — and
-- the one endpoint that calls it answers identically whether the result was an
-- organisation or NULL: same status, same code, same body, and the same Argon2
-- work burned either way (packages/auth verifyPasswordAgainstNothing, and
-- hashForBetterAuth in apps/api/src/auth/better-auth.ts for the branch where
-- the address resolves and the credential does not). Real at the SQL level and
-- unobservable at the HTTP level, which is the trade docs/14 H-118 asks for.
--
-- AMBIGUITY IS NOT AN ERROR, IT IS NULL. `users` is unique on (org_id, email),
-- so the same address may legitimately exist in two organisations. Picking one
-- would be picking whose password to check. Returning NULL sends the caller
-- down the identical failure path, and the client disambiguates by naming a
-- slug — which is what `staff_login_org_for_slug` is for.
--
-- STABLE so the planner evaluates them once per statement, and an explicit
-- search_path so the body cannot be captured by an object planted earlier on
-- someone's path — the standard requirement for SECURITY DEFINER, and the
-- reason most of them are quietly wrong.

CREATE OR REPLACE FUNCTION public.staff_login_org_for_email(p_email citext)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
    -- count(*) = 1 rather than LIMIT 1: exactly one match, or nothing. An
    -- aggregate over an empty set is one row of NULLs, so a nonexistent
    -- address and an ambiguous one produce the same answer by construction
    -- rather than by two branches that could drift apart.
    SELECT CASE WHEN count(*) = 1 THEN (array_agg(u.org_id))[1] END
      FROM public.users AS u
     WHERE u.email = p_email
       AND u.archived_at IS NULL
$fn$;
--> statement-breakpoint

COMMENT ON FUNCTION public.staff_login_org_for_email(citext) IS
    'Tenant routing for staff login: maps an email address to the one organisation whose '
    'active staff includes it, or NULL when there is no such row or more than one. '
    'SECURITY DEFINER because the caller has no app.current_org yet. Returns an id and '
    'nothing else; everything the login then reads happens inside withOrg().';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.staff_login_org_for_slug(p_slug text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
    SELECT o.id
      FROM public.organizations AS o
     WHERE o.slug = p_slug
$fn$;
--> statement-breakpoint

COMMENT ON FUNCTION public.staff_login_org_for_slug(text) IS
    'Tenant routing for a login or an OIDC start that names its organisation explicitly. '
    'Discloses only whether a slug exists, which a login page that renders the slug in its '
    'own URL has already disclosed.';
--> statement-breakpoint

-- The third case: a deployment with exactly one organisation, which is what
-- self-hosting usually means. docs/03 §1 documents `POST /auth/oidc/start`
-- as taking `{provider}` alone, with no organisation anywhere in it, and that
-- call has no address to route by either. Rather than making the documented
-- request impossible, the sole organisation answers it — and a deployment with
-- two organisations gets NULL, so the caller must say which, exactly as the
-- email lookup behaves when an address is held twice.
CREATE OR REPLACE FUNCTION public.staff_login_sole_org()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
    SELECT CASE WHEN count(*) = 1 THEN (array_agg(o.id))[1] END
      FROM public.organizations AS o
$fn$;
--> statement-breakpoint

COMMENT ON FUNCTION public.staff_login_sole_org() IS
    'The one organisation, when a deployment has exactly one, and NULL otherwise. Lets '
    'POST /auth/oidc/start take {provider} as docs/03 §1 documents it, without the caller '
    'having to know a slug that a single-tenant install does not use.';
--> statement-breakpoint

DO $grants$
BEGIN
    REVOKE ALL ON FUNCTION public.staff_login_org_for_email(citext) FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.staff_login_org_for_slug(text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.staff_login_sole_org() FROM PUBLIC;

    -- Both roles, named rather than inherited. The app role calls nothing here
    -- directly; `withElevated()` opens the lookup on the *job* role, so an
    -- omission would take out `POST /auth/login` entirely rather than degrade
    -- something. `hiring_app` is granted too because the caller is one line
    -- away from being `withOrg` on a future path, and a lookup that works for
    -- one role and not the other is the kind of asymmetry nobody finds twice.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiring_app') THEN
        GRANT EXECUTE ON FUNCTION public.staff_login_org_for_email(citext) TO hiring_app;
        GRANT EXECUTE ON FUNCTION public.staff_login_org_for_slug(text) TO hiring_app;
        GRANT EXECUTE ON FUNCTION public.staff_login_sole_org() TO hiring_app;
    ELSE
        RAISE NOTICE 'Role hiring_app absent; skipping the grants on the staff login lookups.';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiring_job') THEN
        GRANT EXECUTE ON FUNCTION public.staff_login_org_for_email(citext) TO hiring_job;
        GRANT EXECUTE ON FUNCTION public.staff_login_org_for_slug(text) TO hiring_job;
        GRANT EXECUTE ON FUNCTION public.staff_login_sole_org() TO hiring_job;
    ELSE
        RAISE NOTICE 'Role hiring_job absent; skipping the grants on the staff login lookups.';
    END IF;
END
$grants$;
