-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0004_audit_append_only — the audit log is evidence, so the
-- database refuses to rewrite it, and refuses to record the actions
-- that require a reason without one.
--
-- Migration 0002 already revoked UPDATE and DELETE on audit_log from
-- hiring_app and hiring_job, which means neither application can
-- express a rewrite. That is most of the protection and it is not all
-- of it: a grant binds a role, and the owner — which every migration,
-- every psql session and every restore runs as — is not bound by it.
-- "History that can be rewritten is not a record" (docs/17 §9) has to
-- hold for the owner too, or the seven-year retention promise in
-- docs/12 §9 is a promise about who we trust rather than about what
-- the database will do.
--
-- So two things are added here.
--
--   1. A trigger that rejects UPDATE, DELETE and TRUNCATE on
--      audit_log from every role, including the owner and a
--      superuser.
--   2. A CHECK that refuses to store a voiding, a score override, a
--      re-grade or an elevated background access with no reason
--      (FR-21, FR-25, ADR-010).
--
-- Neither replaces the grants. They are different layers: the grant
-- stops the application from trying, the trigger stops anyone from
-- succeeding, and the CHECK stops a row that is present but says
-- nothing. A row that is present and says nothing is the worst of the
-- three outcomes, because it looks like a record.
--
-- Forward-only, and re-running is a no-op: every statement is guarded
-- or written CREATE OR REPLACE / DROP IF EXISTS.
-- ============================================================

-- ------------------------------------------------------------
-- The refusal
-- ------------------------------------------------------------
-- SQLSTATE 42501, insufficient_privilege, deliberately: it is what
-- the REVOKE in 0002 already raises for the application roles, so
-- "the audit log refused to be rewritten" is one condition for a
-- caller to recognise rather than two that depend on which role
-- happened to ask. packages/db/test/postgres-fixture.ts's
-- isInsufficientPrivilege() is that recogniser, and it needs no
-- change to cover this path.
--
-- The message names no organisation, no actor and no row. It reaches
-- logs, and — through a handler that was not paying attention — a
-- response body; an error that quoted the row it was protecting would
-- be a disclosure made out of a refusal.
CREATE OR REPLACE FUNCTION public.audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    RAISE EXCEPTION
        'audit_log is append-only: % is not permitted on it', TG_OP
        USING ERRCODE = 'insufficient_privilege',
              DETAIL  = 'The audit log is a domain record retained for seven years '
                        '(docs/12 section 9), not telemetry. It is written in the same '
                        'transaction as the action it records and never afterwards.',
              HINT    = 'To correct the record, append a new entry describing the '
                        'correction. To purge rows past the retention period, an operator '
                        'must drop this trigger deliberately, in a migration, with the '
                        'retention policy cited.';
    -- Unreachable; plpgsql wants a return and a reader wants to see that
    -- the statement is refused rather than silently turned into a no-op.
    RETURN NULL;
END
$fn$;
--> statement-breakpoint

COMMENT ON FUNCTION public.audit_log_append_only() IS
    'Rejects any attempt to rewrite or remove audit_log rows, from any role including the owner.';
--> statement-breakpoint

-- ------------------------------------------------------------
-- The triggers
-- ------------------------------------------------------------
-- FOR EACH STATEMENT, not FOR EACH ROW. A row trigger fires once per
-- affected row, so `DELETE FROM audit_log WHERE id = -1` — which
-- matches nothing — would succeed quietly. It deletes nothing, so
-- append-only still holds, but the operator learns nothing and tries
-- a wider predicate next. A statement trigger refuses the attempt
-- itself, which is the answer worth giving.
--
-- ENABLE ALWAYS, not the default ENABLE ORIGIN. A trigger left at the
-- default does not fire when session_replication_role is 'replica' —
-- which is the setting a logical-replication apply worker runs under,
-- and the setting `pg_restore --disable-triggers` sets. Both are
-- plausible ways for an UPDATE to reach this table without anybody
-- deciding to allow one, and a protection that a routine restore
-- turns off is a protection that is off exactly when it is needed.
--
-- TRUNCATE gets its own trigger because a truncate trigger is a
-- different kind of object from a row-event trigger and PostgreSQL
-- does not accept both event sets in one CREATE TRIGGER. It is worth
-- the second statement: TRUNCATE is not a DELETE, is not covered by
-- the DELETE grant that 0002 revoked, and empties the table in one
-- line.
DROP TRIGGER IF EXISTS audit_log_no_rewrite ON audit_log;
--> statement-breakpoint

CREATE TRIGGER audit_log_no_rewrite
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.audit_log_append_only();
--> statement-breakpoint

ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_rewrite;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
--> statement-breakpoint

CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.audit_log_append_only();
--> statement-breakpoint

ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate;
--> statement-breakpoint

-- ------------------------------------------------------------
-- A reason, where a reason is required
-- ------------------------------------------------------------
-- FR-21 (a manual score override requires a reason) and FR-25
-- (voiding requires a reason) are product requirements about a record
-- that outlives every line of application code that will ever write
-- it. ADR-010 adds the third case: the background role bypasses
-- row-level security, and the reason is the entire counterweight.
--
-- packages/db/src/audit.ts enforces all three in TypeScript, which
-- catches the mistake at the call site with a message a developer can
-- act on. This constraint is the backstop for everything that is not
-- that call site: a psql session, an importer, a future service in
-- another language, a test fixture taking a shortcut.
--
-- WHERE THE REASON LIVES. audit_log has no reason column —
-- docs/hiring_platform_schema.sql section 10 defines the table and
-- this schema reproduces it exactly — so the reason is a key in the
-- `after` payload, which is the shape withElevated() has written
-- since P1 step 1 and the shape the dispute runbook reads back
-- (docs/12, "score dispute", step 4). Adding a column instead would
-- diverge the schema from its source document for a value that is
-- already recorded and already queryable as `after ->> 'reason'`.
--
-- The predicate is written so that it can never evaluate to NULL. A
-- CHECK passes on NULL, so `btrim(after ->> 'reason') <> ''` alone —
-- which is NULL whenever the key is absent — would admit exactly the
-- rows it was written to reject. The explicit IS NOT NULL tests are
-- what make it a constraint rather than a comment.
--
-- The action list is duplicated from REASON_REQUIRED_ACTIONS in
-- packages/db/src/audit.ts. Duplication across a language boundary is
-- unavoidable; the divergence is not, and tests/audit.test.ts reads
-- pg_get_constraintdef() and fails if the two lists stop matching.
--
-- Expand-contract (docs/17 section 4): NOT VALID first so the new
-- rule binds new rows immediately without holding a lock for a table
-- scan, VALIDATE second. On a fresh database the two are
-- indistinguishable; on a populated one the split is the difference
-- between a migration and an outage.
DO $expand$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'audit_log_reason_required'
           AND conrelid = 'public.audit_log'::regclass
    ) THEN
        ALTER TABLE audit_log
            ADD CONSTRAINT audit_log_reason_required
            CHECK (
                (
                    action NOT IN ('attempt.void', 'attempt.regrade', 'score.override')
                    AND action NOT LIKE 'job.%'
                )
                OR (
                    after IS NOT NULL
                    AND after ->> 'reason' IS NOT NULL
                    AND btrim(after ->> 'reason') <> ''
                )
            )
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
         WHERE conname = 'audit_log_reason_required'
           AND conrelid = 'public.audit_log'::regclass
           AND NOT convalidated
    ) THEN
        ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_reason_required;
    END IF;
END
$validate$;
--> statement-breakpoint

COMMENT ON CONSTRAINT audit_log_reason_required ON audit_log IS
    'Voiding (FR-25), score override and re-grade (FR-21) and any elevated job.* access '
    '(ADR-010) may not be recorded without a reason. The reason is after ->> ''reason''.';
--> statement-breakpoint

COMMENT ON TABLE audit_log IS
    'Append-only domain record, retained seven years (docs/12 section 9). Written in the '
    'same transaction as the action it records. UPDATE, DELETE and TRUNCATE are refused '
    'by trigger for every role, including the owner.';
