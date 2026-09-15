-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0002_rls — row-level security on every tenant table, per ADR-010.
--
-- "Multi-tenant data leakage is the failure that ends products.
--  Application-layer filtering works until one developer forgets one clause
--  in one query." A forgotten WHERE now returns zero rows instead of another
--  tenant's data.
--
-- Every table created by 0001 is accounted for below, in one of three groups,
-- and the groups add up to all 40. A table that is in no group is a table
-- nobody decided about, which is the failure mode this migration exists to
-- prevent — so the completeness check at the end fails the migration rather
-- than letting it pass quietly.
--
--   Group A (16 tables)  direct tenant key: org_id, or id on organizations
--   Group B (23 tables)  no tenant key of their own; isolated via their parent
--   Group C ( 1 table)   global reference data, read-only by grant
--
-- src/rls-tables.ts derives the Group A list from the Drizzle schema, and
-- tests/rls.test.ts generates one isolation case per table from it. A tenant
-- table added later with no policy therefore fails CI on the day it is added.
--
-- ROLE NAMES. The two application roles are `hiring_app` and `hiring_job`,
-- matching DATABASE_APP_ROLE and DATABASE_JOB_ROLE in .env.example and
-- infra/postgres/init/01-roles.sql. A migration cannot read the environment,
-- so the defaults are written literally here; a deployment that renames them
-- owns a follow-up migration. No password is set by this file — a password in
-- a migration is a secret in the repository (docs/17 §7), so the role is
-- created without one and the operator or the container init script assigns
-- it. This migration never overwrites an existing role.
--
-- Re-running is a no-op: every statement is guarded.
-- ============================================================

-- ------------------------------------------------------------
-- The tenant key accessor
-- ------------------------------------------------------------
-- Returns NULL when app.current_org is unset. `org_id = NULL` evaluates to
-- NULL rather than true, so an unset variable denies everything instead of
-- leaking everything. The safe direction is the default direction.
--
-- STABLE, not VOLATILE, so the planner evaluates it once per statement rather
-- than once per row — the difference is large on a sequential scan, and
-- ADR-010 warns that RLS plans can degrade. PARALLEL SAFE so the policies do
-- not silently disable parallel plans.
CREATE OR REPLACE FUNCTION public.app_current_org()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $fn$
    SELECT nullif(current_setting('app.current_org', true), '')::uuid
$fn$;
--> statement-breakpoint

COMMENT ON FUNCTION public.app_current_org() IS
    'Tenant key for RLS. NULL when app.current_org is unset, which denies rather than admits.';
--> statement-breakpoint

-- ------------------------------------------------------------
-- The two application roles (ADR-010)
-- ------------------------------------------------------------
-- hiring_app  apps/api      RLS ENFORCED   per-request audit_log row
-- hiring_job  apps/worker   RLS BYPASSED   explicit, separate trail
--
-- Neither owns a table. That is load-bearing: a table's owner is exempt from
-- its own policies unless FORCE ROW LEVEL SECURITY is set, so the isolation
-- only holds because the API never connects as the owner. FORCE is
-- deliberately not used — it would also apply during expand-contract
-- migrations, where the owner legitimately needs to see every tenant's rows to
-- backfill a column, and a migration that silently touches zero rows is a
-- worse failure than the one FORCE removes.
--
-- BYPASSRLS on hiring_job is a superuser-only attribute. When this migration
-- runs as a non-superuser owner and the roles do not already exist, the block
-- below reports what it could not do instead of aborting the migration: the
-- roles are an operational prerequisite documented in
-- docs/13-environments-and-release.md, and failing the whole schema migration
-- over them helps nobody.
DO $roles$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiring_app') THEN
        EXECUTE 'CREATE ROLE hiring_app LOGIN '
                'NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
        EXECUTE 'COMMENT ON ROLE hiring_app IS '
                '''apps/api. Row-level security enforced. app.current_org is set per request.''';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiring_job') THEN
        EXECUTE 'CREATE ROLE hiring_job LOGIN '
                'NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS';
        EXECUTE 'COMMENT ON ROLE hiring_job IS ''apps/worker. BYPASSRLS by design '
                '(ADR-010). Every write emits a job.* audit_log row.''';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE
            'Could not create the application roles: %. Create hiring_app and hiring_job as a '
            'superuser (see infra/postgres/init/01-roles.sql) and re-run.', SQLERRM;
END
$roles$;
--> statement-breakpoint

-- ------------------------------------------------------------
-- Privileges
-- ------------------------------------------------------------
-- Neither application role may create objects in public. A schema change is a
-- migration, and a migration runs as the owner.
DO $grants$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiring_app')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hiring_job') THEN
        RAISE NOTICE 'Application roles absent; skipping grants.';
        RETURN;
    END IF;

    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO hiring_app, hiring_job;

    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
        TO hiring_app, hiring_job;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hiring_app, hiring_job;

    -- Applies to objects created after this statement, so a later migration
    -- cannot produce a table the API silently cannot read.
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hiring_app, hiring_job';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
            'GRANT USAGE, SELECT ON SEQUENCES TO hiring_app, hiring_job';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
            'GRANT EXECUTE ON FUNCTIONS TO hiring_app, hiring_job';

    REVOKE ALL ON FUNCTION public.app_current_org() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.app_current_org() TO hiring_app, hiring_job;

    -- audit_log is append-only, enforced as a grant rather than as a habit.
    -- This is the counterweight to hiring_job's BYPASSRLS: a background write
    -- that no policy can constrain must at least be reconstructable, and
    -- history that can be rewritten is not a record (docs/17 §9).
    REVOKE UPDATE, DELETE ON audit_log FROM hiring_app, hiring_job;

    -- Group C. permissions is the fixed catalogue of permission keys: part of
    -- the product, not of a customer's configuration. It has no tenant
    -- dimension and never will, so it carries no policy; the read-only
    -- property is a grant instead.
    REVOKE INSERT, UPDATE, DELETE ON permissions FROM hiring_app, hiring_job;
END
$grants$;
--> statement-breakpoint

-- ============================================================
-- GROUP A — direct tenant key
-- 16 tables. The policy is one comparison and the plan stays flat.
-- ============================================================

-- A.1 The tenancy root. organizations is keyed on `id`, not `org_id`: a tenant
-- sees exactly its own row. Creating an organisation is an owner-level
-- operation, not an API one.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON organizations;
CREATE POLICY org_isolation ON organizations
    USING (id = public.app_current_org())
    WITH CHECK (id = public.app_current_org());
--> statement-breakpoint

-- A.2 org_id NOT NULL. Thirteen tables where every row belongs to exactly one
-- organisation.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON users;
CREATE POLICY org_isolation ON users
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE job_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON job_roles;
CREATE POLICY org_isolation ON job_roles
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE job_openings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON job_openings;
CREATE POLICY org_isolation ON job_openings
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON questions;
CREATE POLICY org_isolation ON questions
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON assessments;
CREATE POLICY org_isolation ON assessments
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON candidates;
CREATE POLICY org_isolation ON candidates
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON applications;
CREATE POLICY org_isolation ON applications
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON invitations;
CREATE POLICY org_isolation ON invitations
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON attempts;
CREATE POLICY org_isolation ON attempts
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON submissions;
CREATE POLICY org_isolation ON submissions
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE interview_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON interview_sessions;
CREATE POLICY org_isolation ON interview_sessions
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE scorecard_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON scorecard_templates;
CREATE POLICY org_isolation ON scorecard_templates
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

-- audit_log carries org_id with no foreign key (see 0001). The policy is the
-- same comparison regardless.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON audit_log;
CREATE POLICY org_isolation ON audit_log
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

-- A.3 org_id NULLABLE. Two tables where NULL means "global, shared by every
-- tenant": the system role definitions and the global skill taxonomy.
--
-- The asymmetry between USING and WITH CHECK is deliberate. USING admits the
-- global rows so a tenant can read the shared taxonomy. WITH CHECK omits them
-- so no tenant can create, edit or claim a global row — an org that could
-- write org_id = NULL would be editing every other org's taxonomy. Seeding
-- global rows is an owner-level operation.

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON user_roles;
CREATE POLICY org_isolation ON user_roles
    USING (org_id IS NULL OR org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON skills;
CREATE POLICY org_isolation ON skills
    USING (org_id IS NULL OR org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint

-- ============================================================
-- GROUP B — no tenant key of their own
--
-- 23 tables. Each reaches its organisation through a foreign key, and each
-- gets a policy that walks that key. These are defence in depth: the API
-- always reaches these rows through their parent, so a correct query is
-- already isolated. The policies exist for the incorrect query — the one that
-- looks up an mcq_options row by a guessed UUID, and finds another
-- organisation's answer key.
--
-- Every predicate is an EXISTS over an indexed primary key, so the planner
-- turns it into a single index lookup per row rather than a join. The parent's
-- own policy applies inside the subquery, which is what makes the chain hold
-- all the way up to organizations.
-- ============================================================

-- B.1 RBAC
ALTER TABLE user_role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON user_role_permissions;
CREATE POLICY org_isolation ON user_role_permissions
    USING (EXISTS (SELECT 1 FROM user_roles r WHERE r.id = user_role_id))
    WITH CHECK (EXISTS (SELECT 1 FROM user_roles r
                        WHERE r.id = user_role_id
                          AND r.org_id = public.app_current_org()));
--> statement-breakpoint

ALTER TABLE user_role_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON user_role_assignments;
CREATE POLICY org_isolation ON user_role_assignments
    USING (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id))
    WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id));
--> statement-breakpoint

-- B.2 Roles and skills
ALTER TABLE job_role_skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON job_role_skills;
CREATE POLICY org_isolation ON job_role_skills
    USING (EXISTS (SELECT 1 FROM job_roles jr WHERE jr.id = job_role_id))
    WITH CHECK (EXISTS (SELECT 1 FROM job_roles jr WHERE jr.id = job_role_id));
--> statement-breakpoint

-- B.3 Question bank. This subtree is the highest-value target in the system:
-- a leak here is not one candidate's data, it is a competitor's entire
-- question bank, including reference solutions and hidden test cases.
ALTER TABLE question_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON question_versions;
CREATE POLICY org_isolation ON question_versions
    USING (EXISTS (SELECT 1 FROM questions q WHERE q.id = question_id))
    WITH CHECK (EXISTS (SELECT 1 FROM questions q WHERE q.id = question_id));
--> statement-breakpoint

ALTER TABLE question_skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON question_skills;
CREATE POLICY org_isolation ON question_skills
    USING (EXISTS (SELECT 1 FROM questions q WHERE q.id = question_id))
    WITH CHECK (EXISTS (SELECT 1 FROM questions q WHERE q.id = question_id));
--> statement-breakpoint

ALTER TABLE mcq_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON mcq_options;
CREATE POLICY org_isolation ON mcq_options
    USING (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id))
    WITH CHECK (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id));
--> statement-breakpoint

ALTER TABLE coding_specs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON coding_specs;
CREATE POLICY org_isolation ON coding_specs
    USING (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id))
    WITH CHECK (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id));
--> statement-breakpoint

ALTER TABLE test_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON test_cases;
CREATE POLICY org_isolation ON test_cases
    USING (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id))
    WITH CHECK (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id));
--> statement-breakpoint

ALTER TABLE short_answer_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON short_answer_keys;
CREATE POLICY org_isolation ON short_answer_keys
    USING (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id))
    WITH CHECK (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id));
--> statement-breakpoint

ALTER TABLE question_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON question_stats;
CREATE POLICY org_isolation ON question_stats
    USING (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id))
    WITH CHECK (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id));
--> statement-breakpoint

-- B.4 Assessment composition
ALTER TABLE assessment_sections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON assessment_sections;
CREATE POLICY org_isolation ON assessment_sections
    USING (EXISTS (SELECT 1 FROM assessments a WHERE a.id = assessment_id))
    WITH CHECK (EXISTS (SELECT 1 FROM assessments a WHERE a.id = assessment_id));
--> statement-breakpoint

-- Both ends are checked on write. Without the second clause an org could
-- attach another org's question to its own section, and the question text
-- would then be served to its candidates.
ALTER TABLE section_questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON section_questions;
CREATE POLICY org_isolation ON section_questions
    USING (EXISTS (SELECT 1 FROM assessment_sections s WHERE s.id = section_id))
    WITH CHECK (EXISTS (SELECT 1 FROM assessment_sections s WHERE s.id = section_id)
            AND EXISTS (SELECT 1 FROM questions q WHERE q.id = question_id));
--> statement-breakpoint

ALTER TABLE section_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON section_rules;
CREATE POLICY org_isolation ON section_rules
    USING (EXISTS (SELECT 1 FROM assessment_sections s WHERE s.id = section_id))
    WITH CHECK (EXISTS (SELECT 1 FROM assessment_sections s WHERE s.id = section_id));
--> statement-breakpoint

-- B.5 Attempts and answers
ALTER TABLE attempt_questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON attempt_questions;
CREATE POLICY org_isolation ON attempt_questions
    USING (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id))
    WITH CHECK (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id));
--> statement-breakpoint

ALTER TABLE answers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON answers;
CREATE POLICY org_isolation ON answers
    USING (EXISTS (SELECT 1 FROM attempt_questions aq WHERE aq.id = attempt_question_id))
    WITH CHECK (EXISTS (SELECT 1 FROM attempt_questions aq WHERE aq.id = attempt_question_id));
--> statement-breakpoint

ALTER TABLE submission_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON submission_results;
CREATE POLICY org_isolation ON submission_results
    USING (EXISTS (SELECT 1 FROM submissions s WHERE s.id = submission_id))
    WITH CHECK (EXISTS (SELECT 1 FROM submissions s WHERE s.id = submission_id));
--> statement-breakpoint

-- B.6 Live interviews
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON session_participants;
CREATE POLICY org_isolation ON session_participants
    USING (EXISTS (SELECT 1 FROM interview_sessions s WHERE s.id = session_id))
    WITH CHECK (EXISTS (SELECT 1 FROM interview_sessions s WHERE s.id = session_id));
--> statement-breakpoint

-- RLS on a partitioned parent is inherited by every partition, including ones
-- created later by the rotation job, so this policy is declared once and never
-- per month when session_events is converted.
ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON session_events;
CREATE POLICY org_isolation ON session_events
    USING (EXISTS (SELECT 1 FROM interview_sessions s WHERE s.id = session_id))
    WITH CHECK (EXISTS (SELECT 1 FROM interview_sessions s WHERE s.id = session_id));
--> statement-breakpoint

-- B.7 Scorecards
ALTER TABLE scorecard_criteria ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON scorecard_criteria;
CREATE POLICY org_isolation ON scorecard_criteria
    USING (EXISTS (SELECT 1 FROM scorecard_templates t WHERE t.id = template_id))
    WITH CHECK (EXISTS (SELECT 1 FROM scorecard_templates t WHERE t.id = template_id));
--> statement-breakpoint

ALTER TABLE scorecards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON scorecards;
CREATE POLICY org_isolation ON scorecards
    USING (EXISTS (SELECT 1 FROM scorecard_templates t WHERE t.id = template_id))
    WITH CHECK (EXISTS (SELECT 1 FROM scorecard_templates t WHERE t.id = template_id));
--> statement-breakpoint

ALTER TABLE scorecard_ratings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON scorecard_ratings;
CREATE POLICY org_isolation ON scorecard_ratings
    USING (EXISTS (SELECT 1 FROM scorecards sc WHERE sc.id = scorecard_id))
    WITH CHECK (EXISTS (SELECT 1 FROM scorecards sc WHERE sc.id = scorecard_id));
--> statement-breakpoint

-- B.8 Proctoring.
-- ADR-007: these rows are advisory signals. RLS constrains who can see them;
-- it says nothing about what may be done with them, and the answer to that is
-- "surfaced to a human with the evidence attached, and nothing else".
ALTER TABLE proctor_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON proctor_events;
CREATE POLICY org_isolation ON proctor_events
    USING (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id))
    WITH CHECK (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id));
--> statement-breakpoint

ALTER TABLE proctor_media ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON proctor_media;
CREATE POLICY org_isolation ON proctor_media
    USING (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id))
    WITH CHECK (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id));
--> statement-breakpoint

-- ============================================================
-- COMPLETENESS CHECK
--
-- Fails the migration — loudly, before anything connects — if a table in
-- public has neither RLS enabled nor an explicit exemption. When a later
-- migration adds a tenant table and forgets its policy, this is what says so,
-- alongside tests/rls.test.ts, which proves the policy actually isolates
-- rather than merely existing.
-- ============================================================
DO $check$
DECLARE
    v_missing text;
BEGIN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
      INTO v_missing
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity
       AND c.relname NOT IN ('permissions');

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'RLS completeness check failed. Tables without row-level security: %', v_missing
        USING HINT = 'Add an org_isolation policy in a migration, or add the table to the '
                     'Group C exemption list with a reason in src/rls-tables.ts.';
    END IF;
END
$check$;
