-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0010_bank_jobs — the outbox and the record for bank import and export (ADR-021).
--
-- `POST /questions/import` and `POST /questions/export` answer 202 with a job id.
-- The request writes one row here, in the same transaction as its audit row,
-- and that commit is the hand-off: there is no separate enqueue that can be
-- lost after the commit or sent before it. The worker claims queued rows through
-- claim_bank_jobs() and puts each on the bank.jobs queue with the row id as the
-- job id, so a second claim of the same row is a no-op in BullMQ.
--
-- The row is also the operator's record: status, counts, per-item problems and
-- a failure message. `next_index` is the import checkpoint — advanced in the
-- same transaction that writes each item — so a retried job resumes at the
-- first unwritten item instead of importing the file twice.
--
-- Payloads, bounded and short-lived:
--   * `input` is the uploaded file. Cleared when the job finishes, either way.
--   * `result` is an export's file. Readable until `expires_at`; after that the
--     API answers 404 and the retention sweep (planned) nulls it.
-- Kept in PostgreSQL rather than the object store until the S3 adapter exists;
-- ADR-021 records that trade and its limits (32 MiB per file).
--
-- Expand only: a new table and a new function.
-- ============================================================

CREATE TABLE IF NOT EXISTS bank_jobs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind                text NOT NULL,
    format              text NOT NULL,
    status              text NOT NULL DEFAULT 'queued',
    requested_by        uuid NOT NULL REFERENCES users(id),
    options             jsonb NOT NULL DEFAULT '{}'::jsonb,
    input               bytea,
    input_bytes         int,
    result              bytea,
    result_content_type text,
    result_bytes        int,
    next_index          int NOT NULL DEFAULT 0,
    created_count       int NOT NULL DEFAULT 0,
    skipped_count       int NOT NULL DEFAULT 0,
    problems            jsonb NOT NULL DEFAULT '[]'::jsonb,
    problems_truncated  boolean NOT NULL DEFAULT false,
    failure             text,
    created_at          timestamptz NOT NULL,
    dispatched_at       timestamptz,
    started_at          timestamptz,
    finished_at         timestamptz,
    expires_at          timestamptz,
    CONSTRAINT bank_jobs_kind_check CHECK (kind IN ('import', 'export')),
    CONSTRAINT bank_jobs_format_check CHECK (format IN ('json', 'qti')),
    CONSTRAINT bank_jobs_status_check
        CHECK (status IN ('queued', 'dispatched', 'running', 'succeeded', 'failed')),
    CONSTRAINT bank_jobs_input_bytes_check CHECK (input_bytes IS NULL OR input_bytes BETWEEN 0 AND 33554432),
    CONSTRAINT bank_jobs_result_bytes_check CHECK (result_bytes IS NULL OR result_bytes BETWEEN 0 AND 33554432),
    CONSTRAINT bank_jobs_counts_check CHECK (next_index >= 0 AND created_count >= 0 AND skipped_count >= 0)
);
--> statement-breakpoint

-- The claim reads queued work oldest first across every tenant.
CREATE INDEX IF NOT EXISTS bank_jobs_status_created_at_idx
    ON bank_jobs (status, created_at, id)
    WHERE status IN ('queued', 'dispatched');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS bank_jobs_org_id_created_at_idx ON bank_jobs (org_id, created_at DESC);
--> statement-breakpoint

ALTER TABLE bank_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON bank_jobs;
--> statement-breakpoint
CREATE POLICY org_isolation ON bank_jobs
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

-- Claiming work across tenants without the elevated role.
--
-- The worker must find queued jobs in every organisation, and no single
-- organisation can see the others. withElevated would do it, but it writes an
-- audit row per call and the relay polls every few seconds. This function is
-- narrower than elevation, in the same way invitation_org_for_token (0005) is:
--
--   1. It returns two columns — id and org_id — and nothing of the job's
--      content. Everything the worker then reads or writes happens inside
--      withOrg(org_id), under the ordinary policy.
--   2. Its only write is the status transition queued -> dispatched, or a
--      re-dispatch of a row stuck in dispatched past p_stale_seconds, which is
--      what recovers a claim whose enqueue was lost.
--   3. FOR UPDATE SKIP LOCKED, so two worker replicas never claim one row.
--   4. An explicit search_path, so the body cannot be captured.
CREATE OR REPLACE FUNCTION public.claim_bank_jobs(p_limit int, p_now timestamptz, p_stale_seconds int)
RETURNS TABLE (id uuid, org_id uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
    UPDATE public.bank_jobs AS j
       SET status = 'dispatched',
           dispatched_at = p_now
     WHERE j.id IN (
             SELECT c.id
               FROM public.bank_jobs AS c
              WHERE c.status = 'queued'
                 OR (c.status = 'dispatched'
                     AND c.dispatched_at < p_now - make_interval(secs => greatest(p_stale_seconds, 30)))
              ORDER BY c.created_at, c.id
              LIMIT least(greatest(p_limit, 1), 100)
              FOR UPDATE SKIP LOCKED
           )
    RETURNING j.id, j.org_id
$fn$;
--> statement-breakpoint

COMMENT ON FUNCTION public.claim_bank_jobs(int, timestamptz, int) IS
    'Bank job outbox claim (ADR-021): moves up to p_limit queued jobs, or dispatched jobs stale '
    'past p_stale_seconds, to dispatched and returns their id and org_id only. Everything else '
    'the worker does with a job happens inside withOrg(org_id).';
--> statement-breakpoint

DO $grants$
BEGIN
    REVOKE ALL ON FUNCTION public.claim_bank_jobs(int, timestamptz, int) FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiring_app') THEN
        GRANT EXECUTE ON FUNCTION public.claim_bank_jobs(int, timestamptz, int) TO hiring_app;
    ELSE
        RAISE NOTICE 'Role hiring_app absent; skipping the grant on claim_bank_jobs.';
    END IF;
END
$grants$;
