-- ============================================================
-- 01-roles.sql
--
-- The two-role split required by ADR-010.
--
-- Role                Used by            RLS            Audit expectation
-- ------------------  -----------------  -------------  --------------------------
-- hiring (owner)      migrations only    owner, exempt  change log = migrations
-- hiring_app          apps/api           ENFORCED       per-request audit_log row
-- hiring_job          apps/worker        BYPASSED       explicit, separate trail
--
-- Neither application role owns any table. That is the load-bearing property:
-- a table's owner is exempt from its own row-level security policies unless
-- FORCE ROW LEVEL SECURITY is set, so the isolation only holds because the API
-- never connects as the owner. FORCE is deliberately not used — it would also
-- apply during expand-contract migrations, where the owner legitimately needs
-- to see every tenant's rows to backfill a column, and a migration that
-- silently touches zero rows is a worse failure than the one FORCE removes.
--
-- This file runs once, on an empty data directory, as POSTGRES_USER. CREATE
-- ROLE has no IF NOT EXISTS, so replaying it by hand against a live database
-- requires dropping the roles first. That is intentional: role changes in a
-- real environment are a reviewed migration in packages/db, not a container
-- init script.
--
-- Role names and passwords come from the environment so this file agrees with
-- DATABASE_APP_ROLE / DATABASE_JOB_ROLE in .env.example without being edited.
-- ============================================================

\set app_role       `echo "${APP_ROLE:-hiring_app}"`
\set app_password   `echo "${APP_ROLE_PASSWORD:-hiring_app}"`
\set job_role       `echo "${JOB_ROLE:-hiring_job}"`
\set job_password   `echo "${JOB_ROLE_PASSWORD:-hiring_job}"`

-- ------------------------------------------------------------
-- hiring_app — the API's role. RLS applies to it in full.
-- ------------------------------------------------------------
-- It gets LOGIN and nothing else: no CREATEDB, no CREATEROLE, no SUPERUSER,
-- and explicitly NOBYPASSRLS. NOBYPASSRLS is the default, and it is spelled
-- out anyway so that a future ALTER granting it stands out in a diff.
CREATE ROLE :"app_role"
    LOGIN
    PASSWORD :'app_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

COMMENT ON ROLE :"app_role" IS
    'apps/api. Row-level security enforced. The pool sets app.current_org on every checkout.';

-- ------------------------------------------------------------
-- hiring_job — the elevated background-job role.
-- ------------------------------------------------------------
-- ADR-010: "background jobs need an explicit elevated role with its own audit
-- trail." A grading job processes a submission with no authenticated session
-- behind it, so there is no org to put in app.current_org and no policy that
-- could admit it. BYPASSRLS states that plainly instead of hiding it behind a
-- permissive policy that would then also apply to the API.
--
-- WHAT THIS ROLE OWES IN RETURN
--
-- Because RLS cannot constrain it, every write made as hiring_job must be
-- reconstructable after the fact. The obligations, in full:
--
--   1. Every job writes an audit_log row with actor_user_id = NULL and an
--      action prefixed `job.` — job.grade, job.deadline_sweep, job.retention,
--      job.partition_rotate, job.stats_refresh. A background write with no
--      audit row is a defect, and the M2 test suite asserts the pairing.
--   2. Every job carries the trace ID from the request that enqueued it into
--      its audit rows. Without that, "why did this candidate's score differ on
--      re-grade" is unanswerable (docs/02-HLD.md section 8).
--   3. The job role appends to audit_log and never updates or deletes from it.
--      03-rls.sql revokes UPDATE and DELETE on that table from both
--      application roles; the append-only property is a grant, not a habit.
--   4. Job connections are pooled separately from the API's. One shared pool
--      would let a request-scoped checkout inherit BYPASSRLS, which is exactly
--      the leak RLS exists to prevent.
--   5. This credential lives only on worker-labelled nodes. It is never
--      present on an exec node and never compiled into a browser bundle.
--
-- TBD — owner: security reviewer, decide by 2026-11-27 (M2 exit): whether the
-- worker can drop BYPASSRLS entirely by setting app.current_org from the
-- attempt row it has just loaded. That would be strictly better. It requires
-- the genuinely cross-org sweeps (retention, partition rotation, question
-- stats) to be rewritten as per-org loops first, and the cost of that loop
-- measured against the single-pass version under M2 load.
CREATE ROLE :"job_role"
    LOGIN
    PASSWORD :'job_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;

COMMENT ON ROLE :"job_role" IS
    'apps/worker. BYPASSRLS by design (ADR-010). Every write must emit a job.* audit_log row.';

-- ------------------------------------------------------------
-- Schema and privileges
-- ------------------------------------------------------------
-- Neither application role may create objects in `public`. A schema change is
-- a migration, and a migration runs as the owner.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO :"app_role", :"job_role";

-- Default privileges apply to objects created *after* this statement. The
-- authoritative schema is loaded by 02-schema.sql, which runs next, so every
-- table and sequence it creates is covered. Without this, each new migration
-- would produce a table the API cannot read and the failure would surface as a
-- permission error in production rather than in review.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role", :"job_role";

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO :"app_role", :"job_role";

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO :"app_role", :"job_role";

-- app.current_org is set per connection *checkout* by the API pool, not once
-- per connection — a pooled connection serves many orgs over its life. The
-- empty database-level default means an unset variable reads as '' instead of
-- raising, which lets the helper in 03-rls.sql return NULL and deny cleanly
-- rather than erroring in the middle of a transaction.
ALTER DATABASE :"DBNAME" SET "app.current_org" TO '';
