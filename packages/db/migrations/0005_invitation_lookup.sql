-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0005_invitation_lookup — resolve an invitation token to its tenant.
--
-- P1 step 6. `POST /candidate/redeem` is the one request in the system that
-- arrives with a credential and **no organisation**: the candidate has no
-- account, no session and no cookie, and the only thing they present is an
-- invitation token. ADR-010 makes every tenant read depend on
-- `app.current_org`, and `app_current_org()` returns NULL when nothing has
-- been set, which denies rather than admits. That is the correct default and
-- it is exactly what makes this one lookup impossible: the API cannot read
-- `invitations` to discover the org, because it must already know the org to
-- read anything.
--
-- The chicken-and-egg is resolved here, once, in the narrowest function that
-- can do it:
--
--     invitation_org_for_token(token_hash) -> uuid
--
-- SECURITY DEFINER, so it runs as the schema owner and therefore sees every
-- tenant's invitations. Three properties keep that from being a hole in
-- ADR-010:
--
--   1. **It takes a hash, not a token.** The argument is
--      `hashToken(plaintext, TOKEN_PEPPER)` — the same peppered HMAC stored
--      in `invitations.token_hash`. A caller who does not already hold a live
--      256-bit invitation token cannot produce an argument that matches a
--      row, and one who does is about to be told the org anyway.
--   2. **It returns one column: `org_id`.** Not the row, not the assessment,
--      not the candidate. Everything the redemption actually reads and writes
--      happens afterwards, inside `withOrg(org)`, under the ordinary
--      policies, where a bug returns zero rows in the usual way.
--   3. **It is granted to `hiring_app` alone**, and revoked from PUBLIC, so
--      it is reachable only by the role that serves the redemption endpoint.
--      `hiring_job` already bypasses RLS and has no use for it.
--
-- Why a function rather than a policy on `invitations`: a policy admitting
-- rows on a session variable would widen the table for the whole transaction
-- and for every column, and it would have to be remembered by every future
-- policy author. A function is one grant, one column, one statement, and it
-- shows up in `\df` next to `app_current_org()` where a reviewer will find
-- it.
--
-- Exact equality only. No prefix match, no `LIKE`, no `ILIKE`: the argument
-- is a fixed-length digest, and an operator that could match more than one
-- row is an operator that could route a redemption to the wrong tenant.
--
-- `STABLE` so the planner evaluates it once per statement, and an explicit
-- `search_path` so the body cannot be captured by an object planted in a
-- schema earlier on someone's path — the standard requirement for any
-- SECURITY DEFINER function, and the reason most of them are quietly wrong.
--
-- Forward-only, and re-running is a no-op.
-- ============================================================

CREATE OR REPLACE FUNCTION public.invitation_org_for_token(p_token_hash text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
    SELECT i.org_id
      FROM public.invitations AS i
     WHERE i.token_hash = p_token_hash
$fn$;
--> statement-breakpoint

COMMENT ON FUNCTION public.invitation_org_for_token(text) IS
    'Tenant routing for candidate redemption: maps a peppered invitation token hash to its '
    'organisation, and nothing else. SECURITY DEFINER because the caller has no '
    'app.current_org yet — that is the whole point of the redemption request. Everything '
    'the redemption reads or writes happens afterwards inside withOrg().';
--> statement-breakpoint

DO $grants$
BEGIN
    REVOKE ALL ON FUNCTION public.invitation_org_for_token(text) FROM PUBLIC;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiring_app') THEN
        GRANT EXECUTE ON FUNCTION public.invitation_org_for_token(text) TO hiring_app;
    ELSE
        RAISE NOTICE 'Role hiring_app absent; skipping the grant on invitation_org_for_token.';
    END IF;
END
$grants$;
--> statement-breakpoint

-- Redemption counts the sittings already taken against invitations.max_attempts, in
-- the transaction that creates the attempt (docs/14 H-165). Without this index that
-- count is a scan of the tenant's attempts on every redemption; with it, it is an
-- index lookup on a handful of rows. attempts.invitation_id is nullable — an attempt
-- created by staff has none — so the index is partial and stays small.
CREATE INDEX IF NOT EXISTS attempts_invitation_id_idx
    ON attempts (invitation_id)
    WHERE invitation_id IS NOT NULL;
