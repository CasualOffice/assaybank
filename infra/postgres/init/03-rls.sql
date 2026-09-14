-- ============================================================
-- 03-rls.sql — row-level security, per ADR-010.
--
-- Section 12 of docs/hiring_platform_schema.sql sketches the pattern in a
-- comment and leaves it to be enabled "per table as you go". This file is the
-- exhaustive version: every table in the authoritative schema is accounted for
-- below, in one of four groups, and the groups add up to all 40 tables. A
-- table that is not in a group is a table nobody decided about, which is the
-- failure mode ADR-010 exists to prevent.
--
--   Group A (16 tables)  direct tenant key — org_id, or id on organizations
--   Group B (23 tables)  no tenant key; isolated via their parent
--   Group C ( 1 table)   global reference data, read-only to tenants
--
-- The API sets app.current_org on every connection checkout. The helper below
-- returns NULL when it is unset, and `org_id = NULL` evaluates to NULL rather
-- than true, so an unset variable denies everything instead of leaking
-- everything. That asymmetry is the whole point: the safe direction is the
-- default direction.
--
-- Cost: ADR-010 warns that some plans degrade and says to measure. The
-- Group B policies are subqueries and are the ones to watch. TBD — owner:
-- backend lead, decide by 2026-11-27 (M2 exit): benchmark attempt_questions,
-- answers and submission_results under the M2 load profile
-- (docs/07-load-and-capacity-testing.md) and, if a plan regresses, denormalise
-- org_id onto the offending child table rather than weakening the policy.
-- ============================================================

\set ON_ERROR_STOP on
\set app_role `echo "${APP_ROLE:-hiring_app}"`
\set job_role `echo "${JOB_ROLE:-hiring_job}"`

-- ------------------------------------------------------------
-- The tenant key accessor
-- ------------------------------------------------------------
-- STABLE, not VOLATILE, so the planner evaluates it once per statement rather
-- than once per row — the difference is large on a sequential scan.
-- PARALLEL SAFE so policies do not silently disable parallel plans.
CREATE OR REPLACE FUNCTION public.app_current_org()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $fn$
    SELECT nullif(current_setting('app.current_org', true), '')::uuid
$fn$;

COMMENT ON FUNCTION public.app_current_org() IS
    'Tenant key for RLS. NULL when app.current_org is unset, which denies rather than admits.';

REVOKE ALL ON FUNCTION public.app_current_org() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_current_org() TO :"app_role", :"job_role";


-- ============================================================
-- GROUP A — direct tenant key
-- 16 tables. The policy is one comparison and the plan stays flat.
-- ============================================================

-- --- A.1 The tenancy root ------------------------------------
-- organizations is keyed on `id`, not `org_id`. A tenant sees exactly its own
-- row. Creating an organisation is an owner-level operation, not an API one.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organizations
    USING (id = public.app_current_org())
    WITH CHECK (id = public.app_current_org());

-- --- A.2 org_id NOT NULL -------------------------------------
-- Thirteen tables where every row belongs to exactly one organisation.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON users
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE job_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON job_roles
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE job_openings ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON job_openings
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON questions
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON assessments
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON candidates
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON applications
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON invitations
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON attempts
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON submissions
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE interview_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON interview_sessions
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE scorecard_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON scorecard_templates
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

-- audit_log carries org_id with no foreign key, on purpose: an audit row must
-- survive the hard deletion of the entity it describes (GDPR erasure removes
-- the candidate, not the record that the candidate's attempt was voided).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_log
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

-- Append-only, enforced as a grant rather than a convention. Both application
-- roles may INSERT and SELECT; neither may rewrite history. This is the
-- counterweight to hiring_job's BYPASSRLS (see 01-roles.sql).
REVOKE UPDATE, DELETE ON audit_log FROM :"app_role", :"job_role";

-- --- A.3 org_id NULLABLE -------------------------------------
-- Two tables carry a nullable org_id, where NULL means "global, shared by
-- every tenant": the system role definitions and the global skill taxonomy.
--
-- The asymmetry between USING and WITH CHECK is deliberate. USING admits the
-- global rows so a tenant can read the shared taxonomy. WITH CHECK omits them
-- so no tenant can create, edit or claim a global row — an org that could
-- write org_id = NULL would be editing every other org's taxonomy. Seeding
-- global rows is an owner-level operation.

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON user_roles
    USING (org_id IS NULL OR org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON skills
    USING (org_id IS NULL OR org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());


-- ============================================================
-- GROUP B — no tenant key of their own
--
-- 23 tables. Each reaches its organisation through a foreign key, and each
-- gets a policy that walks that key. These are defence in depth: the API
-- always reaches these rows through their parent, so a correct query is
-- already isolated. The policies exist for the incorrect query — the one that
-- looks up a mcq_options row by a guessed UUID.
--
-- Every predicate below is an EXISTS over an indexed primary key, so the
-- planner turns it into a single index lookup per row rather than a join.
-- The parent table's own policy applies inside the subquery, which is what
-- makes the chain hold all the way up to organizations.
-- ============================================================

-- --- B.1 RBAC ------------------------------------------------
ALTER TABLE user_role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON user_role_permissions
    USING (EXISTS (SELECT 1 FROM user_roles r WHERE r.id = user_role_id))
    WITH CHECK (EXISTS (SELECT 1 FROM user_roles r
                        WHERE r.id = user_role_id
                          AND r.org_id = public.app_current_org()));

ALTER TABLE user_role_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON user_role_assignments
    USING (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id))
    WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id));

-- --- B.2 Roles and skills ------------------------------------
ALTER TABLE job_role_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON job_role_skills
    USING (EXISTS (SELECT 1 FROM job_roles jr WHERE jr.id = job_role_id))
    WITH CHECK (EXISTS (SELECT 1 FROM job_roles jr WHERE jr.id = job_role_id));

-- --- B.3 Question bank ---------------------------------------
-- This subtree is the highest-value target in the system. A leak here is not
-- one candidate's data, it is a competitor's entire question bank, including
-- reference solutions and hidden test cases.
ALTER TABLE question_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON question_versions
    USING (EXISTS (SELECT 1 FROM questions q WHERE q.id = question_id))
    WITH CHECK (EXISTS (SELECT 1 FROM questions q WHERE q.id = question_id));

ALTER TABLE question_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON question_skills
    USING (EXISTS (SELECT 1 FROM questions q WHERE q.id = question_id))
    WITH CHECK (EXISTS (SELECT 1 FROM questions q WHERE q.id = question_id));

ALTER TABLE mcq_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON mcq_options
    USING (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id))
    WITH CHECK (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id));

ALTER TABLE coding_specs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON coding_specs
    USING (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id))
    WITH CHECK (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id));

ALTER TABLE test_cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON test_cases
    USING (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id))
    WITH CHECK (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id));

ALTER TABLE short_answer_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON short_answer_keys
    USING (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id))
    WITH CHECK (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id));

ALTER TABLE question_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON question_stats
    USING (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id))
    WITH CHECK (EXISTS (SELECT 1 FROM question_versions v WHERE v.id = question_version_id));

-- --- B.4 Assessment composition ------------------------------
ALTER TABLE assessment_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON assessment_sections
    USING (EXISTS (SELECT 1 FROM assessments a WHERE a.id = assessment_id))
    WITH CHECK (EXISTS (SELECT 1 FROM assessments a WHERE a.id = assessment_id));

ALTER TABLE section_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON section_questions
    USING (EXISTS (SELECT 1 FROM assessment_sections s WHERE s.id = section_id))
    -- Both ends are checked on write. Without the second clause an org could
    -- attach another org's question to its own section, and the question text
    -- would then be served to its candidates.
    WITH CHECK (EXISTS (SELECT 1 FROM assessment_sections s WHERE s.id = section_id)
            AND EXISTS (SELECT 1 FROM questions q WHERE q.id = question_id));

ALTER TABLE section_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON section_rules
    USING (EXISTS (SELECT 1 FROM assessment_sections s WHERE s.id = section_id))
    WITH CHECK (EXISTS (SELECT 1 FROM assessment_sections s WHERE s.id = section_id));

-- --- B.5 Attempts and answers --------------------------------
ALTER TABLE attempt_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON attempt_questions
    USING (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id))
    WITH CHECK (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id));

ALTER TABLE answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON answers
    USING (EXISTS (SELECT 1 FROM attempt_questions aq WHERE aq.id = attempt_question_id))
    WITH CHECK (EXISTS (SELECT 1 FROM attempt_questions aq WHERE aq.id = attempt_question_id));

ALTER TABLE submission_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON submission_results
    USING (EXISTS (SELECT 1 FROM submissions s WHERE s.id = submission_id))
    WITH CHECK (EXISTS (SELECT 1 FROM submissions s WHERE s.id = submission_id));

-- --- B.6 Live interviews -------------------------------------
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON session_participants
    USING (EXISTS (SELECT 1 FROM interview_sessions s WHERE s.id = session_id))
    WITH CHECK (EXISTS (SELECT 1 FROM interview_sessions s WHERE s.id = session_id));

-- session_events is partitioned by 04-partitions.sql. RLS on a partitioned
-- parent is inherited by every partition, including ones created later by the
-- rotation job, so the policy is declared once here and never per month.
ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON session_events
    USING (EXISTS (SELECT 1 FROM interview_sessions s WHERE s.id = session_id))
    WITH CHECK (EXISTS (SELECT 1 FROM interview_sessions s WHERE s.id = session_id));

-- --- B.7 Scorecards ------------------------------------------
ALTER TABLE scorecard_criteria ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON scorecard_criteria
    USING (EXISTS (SELECT 1 FROM scorecard_templates t WHERE t.id = template_id))
    WITH CHECK (EXISTS (SELECT 1 FROM scorecard_templates t WHERE t.id = template_id));

ALTER TABLE scorecards ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON scorecards
    USING (EXISTS (SELECT 1 FROM scorecard_templates t WHERE t.id = template_id))
    WITH CHECK (EXISTS (SELECT 1 FROM scorecard_templates t WHERE t.id = template_id));

ALTER TABLE scorecard_ratings ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON scorecard_ratings
    USING (EXISTS (SELECT 1 FROM scorecards sc WHERE sc.id = scorecard_id))
    WITH CHECK (EXISTS (SELECT 1 FROM scorecards sc WHERE sc.id = scorecard_id));

-- --- B.8 Proctoring ------------------------------------------
-- ADR-007: these rows are advisory signals. Nothing downstream may read them
-- and auto-reject, auto-void or down-score. RLS constrains who can see them;
-- it says nothing about what may be done with them, and the answer to that is
-- "surfaced to a human with the evidence attached, and nothing else".
ALTER TABLE proctor_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON proctor_events
    USING (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id))
    WITH CHECK (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id));

ALTER TABLE proctor_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON proctor_media
    USING (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id))
    WITH CHECK (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id));


-- ============================================================
-- GROUP C — global reference data
--
-- 1 table. `permissions` is the fixed catalogue of permission keys seeded by
-- section 13 of the authoritative schema. It has no tenant dimension and
-- never will: a permission key is part of the product, not of a customer's
-- configuration. RLS is therefore not enabled on it. Instead the write
-- privilege is removed, so the read-only property is enforced by the grant
-- rather than by everyone remembering.
-- ============================================================

REVOKE INSERT, UPDATE, DELETE ON permissions FROM :"app_role", :"job_role";


-- ============================================================
-- A NOTE ON session_events AND proctor_events
--
-- 04-partitions.sql runs next and converts those two tables from ordinary
-- tables to partitioned ones. The conversion drops and recreates the table,
-- which discards the policy declared above with it, so 04 re-applies both the
-- ENABLE and the policy verbatim after the conversion. The declarations are
-- kept here as well so that this file remains the complete statement of the
-- isolation model — reading 03 alone tells you the truth about every table.
-- ============================================================


-- ============================================================
-- COMPLETENESS CHECK
--
-- Fails the container init — loudly, before anyone connects — if a table in
-- `public` has neither RLS enabled nor an explicit exemption. When a migration
-- adds a tenant table and forgets its policy, this is what says so.
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
       AND c.relkind IN ('r', 'p')          -- ordinary and partitioned tables
       AND NOT c.relrowsecurity
       AND c.relname NOT IN ('permissions'); -- Group C, exempt by decision

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'RLS completeness check failed. Tables without row-level security: %', v_missing
        USING HINT = 'Add an org_isolation policy in infra/postgres/init/03-rls.sql, '
                     'or add the table to the Group C exemption list with a reason.';
    END IF;
END
$check$;

\echo 'Row-level security enabled and verified on every table in public.'
