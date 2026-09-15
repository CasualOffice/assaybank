-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0001_initial — the whole schema, as a migration.
--
-- This file is the source of truth for the database from P0 step 6 onward.
-- docs/hiring_platform_schema.sql is now the *documentation* of this model,
-- not its origin, and infra/postgres/init/02-schema.sql no longer loads it.
--
-- Conventions (docs/17 §4):
--   - UUID primary keys, gen_random_uuid()
--   - every tenant-scoped table carries org_id; policies land in 0002
--   - timestamptz everywhere, never naive
--   - soft delete via archived_at; hard delete only for GDPR erasure
--   - money and scores are numeric, never float
--   - a constraint that can live in the database does
--
-- Forward-only. There is no down migration: a down migration is either
-- trivially unnecessary or a data-loss event pretending to be a rollback.
--
-- Re-running is a no-op. The migrator records this file's hash and skips it,
-- and every statement below is additionally written IF NOT EXISTS or guarded
-- so that the file can be replayed by hand against a live database.
-- ============================================================

-- ------------------------------------------------------------
-- Extensions
-- ------------------------------------------------------------
-- Versioned here rather than in a container init script, so that the
-- extension set travels with the tables that depend on it: gen_random_uuid()
-- for every primary key, gin_trgm_ops for prompt search, citext for the
-- case-insensitive email uniqueness that users and candidates rely on.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint

-- ============================================================
-- SECTION 1: TENANCY, USERS, RBAC
-- "user roles" = who can do what inside the tool.
-- ============================================================

CREATE TABLE IF NOT EXISTS organizations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL,
    slug            text NOT NULL,
    settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT organizations_slug_key UNIQUE (slug)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL,
    email           citext NOT NULL,
    full_name       text NOT NULL,
    password_hash   text,
    sso_subject     text,
    timezone        text NOT NULL DEFAULT 'UTC',
    archived_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT users_org_id_email_key UNIQUE (org_id, email)
);
--> statement-breakpoint

-- RBAC kept as data, not an enum, so orgs can define custom roles.
-- org_id NULL means a system role shared by every tenant.
CREATE TABLE IF NOT EXISTS user_roles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid,
    key             text NOT NULL,
    name            text NOT NULL,
    is_system       boolean NOT NULL DEFAULT false,
    CONSTRAINT user_roles_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT user_roles_org_id_key_key UNIQUE (org_id, key)
);
--> statement-breakpoint

-- The fixed catalogue of permission keys. Part of the product, not of a
-- customer's configuration, so it has no tenant dimension and no policy;
-- 0002 removes the write grant instead.
CREATE TABLE IF NOT EXISTS permissions (
    key             text PRIMARY KEY,
    description     text NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS user_role_permissions (
    user_role_id    uuid NOT NULL,
    permission_key  text NOT NULL,
    CONSTRAINT user_role_permissions_pkey PRIMARY KEY (user_role_id, permission_key),
    CONSTRAINT user_role_permissions_user_role_id_fkey FOREIGN KEY (user_role_id) REFERENCES user_roles(id) ON DELETE CASCADE,
    CONSTRAINT user_role_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES permissions(key) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS user_role_assignments (
    user_id         uuid NOT NULL,
    user_role_id    uuid NOT NULL,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_role_assignments_pkey PRIMARY KEY (user_id, user_role_id),
    CONSTRAINT user_role_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT user_role_assignments_user_role_id_fkey FOREIGN KEY (user_role_id) REFERENCES user_roles(id) ON DELETE CASCADE
);
--> statement-breakpoint

-- ============================================================
-- SECTION 2: SKILL TAXONOMY
-- The join between job roles and questions. Tag questions with skills,
-- not with roles, or every new role means re-tagging the bank.
-- ============================================================

CREATE TABLE IF NOT EXISTS skills (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid,
    parent_id       uuid,
    key             text NOT NULL,
    name            text NOT NULL,
    category        text,
    CONSTRAINT skills_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT skills_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES skills(id) ON DELETE SET NULL,
    CONSTRAINT skills_org_id_key_key UNIQUE (org_id, key)
);
--> statement-breakpoint

-- ============================================================
-- SECTION 3: JOB ROLES
-- The positions being hired for. Distinct from user_roles above.
-- ============================================================

CREATE TABLE IF NOT EXISTS job_roles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL,
    code            text NOT NULL,
    title           text NOT NULL,
    family          text,
    seniority       text,
    description     text,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT job_roles_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT job_roles_org_id_code_key UNIQUE (org_id, code)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS job_role_skills (
    job_role_id     uuid NOT NULL,
    skill_id        uuid NOT NULL,
    weight          numeric(4,2) NOT NULL DEFAULT 1.0,
    min_difficulty  smallint,
    max_difficulty  smallint,
    is_required     boolean NOT NULL DEFAULT true,
    CONSTRAINT job_role_skills_pkey PRIMARY KEY (job_role_id, skill_id),
    CONSTRAINT job_role_skills_job_role_id_fkey FOREIGN KEY (job_role_id) REFERENCES job_roles(id) ON DELETE CASCADE,
    CONSTRAINT job_role_skills_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
    CONSTRAINT job_role_skills_weight_check CHECK (weight >= 0),
    CONSTRAINT job_role_skills_min_difficulty_check CHECK (min_difficulty BETWEEN 1 AND 5),
    CONSTRAINT job_role_skills_max_difficulty_check CHECK (max_difficulty BETWEEN 1 AND 5)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS job_openings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL,
    job_role_id     uuid NOT NULL,
    title           text NOT NULL,
    location        text,
    headcount       int NOT NULL DEFAULT 1,
    status          text NOT NULL DEFAULT 'open',
    opened_at       timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz,
    CONSTRAINT job_openings_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT job_openings_job_role_id_fkey FOREIGN KEY (job_role_id) REFERENCES job_roles(id)
);
--> statement-breakpoint

-- ============================================================
-- SECTION 4: QUESTION BANK
-- questions = stable identity. question_versions = immutable content.
-- ADR-003: never UPDATE a published version; insert a new one.
-- ============================================================

DO $enums$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'question_kind') THEN
        CREATE TYPE question_kind AS ENUM (
            'mcq_single',
            'mcq_multi',
            'true_false',
            'short_answer',
            'coding',
            'sql',
            'subjective',
            'system_design'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'question_status') THEN
        CREATE TYPE question_status AS ENUM ('draft', 'review', 'published', 'retired');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attempt_status') THEN
        CREATE TYPE attempt_status AS ENUM (
            'created', 'in_progress', 'submitted', 'expired',
            'auto_graded', 'under_review', 'finalised', 'voided'
        );
    END IF;
END
$enums$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS questions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL,
    kind                question_kind NOT NULL,
    status              question_status NOT NULL DEFAULT 'draft',
    current_version_id  uuid,
    external_ref        text,
    source_license      text,
    author_id           uuid,
    exposure_count      int NOT NULL DEFAULT 0,
    archived_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT questions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT questions_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS question_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id     uuid NOT NULL,
    version_no      int NOT NULL,
    locale          text NOT NULL DEFAULT 'en',
    prompt_md       text NOT NULL,
    explanation_md  text,
    difficulty      smallint NOT NULL,
    est_seconds     int NOT NULL DEFAULT 120,
    max_score       numeric(6,2) NOT NULL DEFAULT 1.0,
    negative_score  numeric(6,2) NOT NULL DEFAULT 0.0,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    published_at    timestamptz,
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT question_versions_question_id_fkey FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
    CONSTRAINT question_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
    CONSTRAINT question_versions_question_id_version_no_locale_key UNIQUE (question_id, version_no, locale),
    CONSTRAINT question_versions_difficulty_check CHECK (difficulty BETWEEN 1 AND 5)
);
--> statement-breakpoint

-- The circular reference: a question points at its current version, and a
-- version belongs to a question. Added after both tables exist.
DO $fk$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'questions_current_version_fk'
    ) THEN
        ALTER TABLE questions
            ADD CONSTRAINT questions_current_version_fk
            FOREIGN KEY (current_version_id) REFERENCES question_versions(id);
    END IF;
END
$fk$;
--> statement-breakpoint

-- ADR-003, enforced where it cannot be forgotten.
--
-- docs/17 §5 requires this invariant at the lowest level that can enforce it,
-- because the API is not the only writer: the bank importer, the nightly
-- statistics job and future migrations write here too, and none of them runs
-- the API's validation. The 409 at the API is the friendly version of this
-- exception, not a substitute for it.
--
-- Publishing is allowed — that is the transition of published_at from NULL to
-- an instant. Every later UPDATE is refused. DELETE is deliberately not
-- covered: organisation deletion and GDPR erasure cascade through this table,
-- and a trigger that blocked them would turn a legal obligation into an
-- outage. Retiring content is questions.status and archived_at, not a DELETE.
CREATE OR REPLACE FUNCTION public.question_versions_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF OLD.published_at IS NOT NULL THEN
        RAISE EXCEPTION
            'question_version % is published and immutable (ADR-003)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation',
                  HINT = 'Insert a new question_version and move questions.current_version_id.';
    END IF;
    RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS question_versions_immutable ON question_versions;
--> statement-breakpoint

CREATE TRIGGER question_versions_immutable
    BEFORE UPDATE ON question_versions
    FOR EACH ROW
    EXECUTE FUNCTION public.question_versions_reject_mutation();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS question_skills (
    question_id     uuid NOT NULL,
    skill_id        uuid NOT NULL,
    weight          numeric(4,2) NOT NULL DEFAULT 1.0,
    CONSTRAINT question_skills_pkey PRIMARY KEY (question_id, skill_id),
    CONSTRAINT question_skills_question_id_fkey FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
    CONSTRAINT question_skills_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
--> statement-breakpoint

-- ---- MCQ ----------------------------------------------------
-- is_correct, score_delta and rationale_md are answer-key material and never
-- reach a candidate-scoped response (FR-12). The database cannot enforce that;
-- the typed serialisers and the standing leak suite do.
CREATE TABLE IF NOT EXISTS mcq_options (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_version_id uuid NOT NULL,
    ordinal             int NOT NULL,
    body_md             text NOT NULL,
    is_correct          boolean NOT NULL DEFAULT false,
    score_delta         numeric(6,2),
    rationale_md        text,
    CONSTRAINT mcq_options_question_version_id_fkey FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE CASCADE,
    CONSTRAINT mcq_options_question_version_id_ordinal_key UNIQUE (question_version_id, ordinal)
);
--> statement-breakpoint

-- ---- Coding -------------------------------------------------
-- solution_code and checker_code never leave the server. ADR-002 keeps
-- expectations out of the sandbox entirely, so an escaped process has nothing
-- to read even if it escapes.
CREATE TABLE IF NOT EXISTS coding_specs (
    question_version_id uuid PRIMARY KEY,
    allowed_languages   text[] NOT NULL,
    starter_code        jsonb NOT NULL DEFAULT '{}'::jsonb,
    solution_code       jsonb NOT NULL DEFAULT '{}'::jsonb,
    time_limit_ms       int NOT NULL DEFAULT 5000,
    memory_limit_kb     int NOT NULL DEFAULT 262144,
    grading_mode        text NOT NULL DEFAULT 'test_cases',
    checker_code        text,
    fixture_sql         text,
    CONSTRAINT coding_specs_question_version_id_fkey FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE CASCADE
);
--> statement-breakpoint

-- is_sample = true is the only row a candidate may see.
CREATE TABLE IF NOT EXISTS test_cases (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_version_id uuid NOT NULL,
    ordinal             int NOT NULL,
    label               text,
    stdin               text NOT NULL DEFAULT '',
    expected_stdout     text,
    args                text[],
    is_sample           boolean NOT NULL DEFAULT false,
    weight              numeric(6,2) NOT NULL DEFAULT 1.0,
    CONSTRAINT test_cases_question_version_id_fkey FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE CASCADE,
    CONSTRAINT test_cases_question_version_id_ordinal_key UNIQUE (question_version_id, ordinal)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS short_answer_keys (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_version_id uuid NOT NULL,
    match_type          text NOT NULL,
    pattern             text NOT NULL,
    tolerance           numeric,
    score               numeric(6,2) NOT NULL DEFAULT 1.0,
    CONSTRAINT short_answer_keys_question_version_id_fkey FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE CASCADE
);
--> statement-breakpoint

-- Psychometrics, recomputed nightly. Describes the item, never the person:
-- nothing in the scoring path reads this table.
CREATE TABLE IF NOT EXISTS question_stats (
    question_version_id uuid PRIMARY KEY,
    n_attempts          int NOT NULL DEFAULT 0,
    p_value             numeric(5,4),
    discrimination      numeric(5,4),
    mean_seconds        numeric(8,2),
    computed_at         timestamptz,
    CONSTRAINT question_stats_question_version_id_fkey FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE CASCADE
);
--> statement-breakpoint

-- ============================================================
-- SECTION 5: ASSESSMENTS (test templates)
-- A section either pins specific questions or draws from a rule.
-- These tables describe how a set is CHOSEN. What a candidate was actually
-- served is attempt_questions, materialised once at start (ADR-004).
-- ============================================================

CREATE TABLE IF NOT EXISTS assessments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL,
    job_role_id         uuid,
    name                text NOT NULL,
    description         text,
    duration_seconds    int NOT NULL,
    pass_score_pct      numeric(5,2),
    shuffle_sections    boolean NOT NULL DEFAULT false,
    allow_back_nav      boolean NOT NULL DEFAULT true,
    proctoring_profile  text NOT NULL DEFAULT 'none',
    status              question_status NOT NULL DEFAULT 'draft',
    version_no          int NOT NULL DEFAULT 1,
    created_by          uuid,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT assessments_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT assessments_job_role_id_fkey FOREIGN KEY (job_role_id) REFERENCES job_roles(id),
    CONSTRAINT assessments_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS assessment_sections (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id       uuid NOT NULL,
    ordinal             int NOT NULL,
    name                text NOT NULL,
    kind                question_kind,
    duration_seconds    int,
    shuffle_questions   boolean NOT NULL DEFAULT true,
    shuffle_options     boolean NOT NULL DEFAULT true,
    CONSTRAINT assessment_sections_assessment_id_fkey FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE CASCADE,
    CONSTRAINT assessment_sections_assessment_id_ordinal_key UNIQUE (assessment_id, ordinal)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS section_questions (
    section_id          uuid NOT NULL,
    question_id         uuid NOT NULL,
    pin_version_id      uuid,
    ordinal             int NOT NULL,
    score_override      numeric(6,2),
    CONSTRAINT section_questions_pkey PRIMARY KEY (section_id, question_id),
    CONSTRAINT section_questions_section_id_fkey FOREIGN KEY (section_id) REFERENCES assessment_sections(id) ON DELETE CASCADE,
    CONSTRAINT section_questions_question_id_fkey FOREIGN KEY (question_id) REFERENCES questions(id),
    CONSTRAINT section_questions_pin_version_id_fkey FOREIGN KEY (pin_version_id) REFERENCES question_versions(id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS section_rules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    section_id          uuid NOT NULL,
    pick_count          int NOT NULL,
    skill_ids           uuid[] NOT NULL DEFAULT '{}',
    kinds               question_kind[] NOT NULL DEFAULT '{}',
    min_difficulty      smallint NOT NULL DEFAULT 1,
    max_difficulty      smallint NOT NULL DEFAULT 5,
    exclude_seen_days   int NOT NULL DEFAULT 0,
    score_per_question  numeric(6,2),
    CONSTRAINT section_rules_section_id_fkey FOREIGN KEY (section_id) REFERENCES assessment_sections(id) ON DELETE CASCADE,
    CONSTRAINT section_rules_pick_count_check CHECK (pick_count > 0)
);
--> statement-breakpoint

-- ============================================================
-- SECTION 6: CANDIDATES, INVITATIONS, ATTEMPTS
-- ============================================================

CREATE TABLE IF NOT EXISTS candidates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL,
    email           citext NOT NULL,
    full_name       text,
    phone           text,
    resume_url      text,
    source          text,
    consent_at      timestamptz,
    erase_after     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT candidates_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT candidates_org_id_email_key UNIQUE (org_id, email)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS applications (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           uuid NOT NULL,
    candidate_id     uuid NOT NULL,
    job_opening_id   uuid NOT NULL,
    stage            text NOT NULL DEFAULT 'applied',
    stage_changed_at timestamptz NOT NULL DEFAULT now(),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT applications_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT applications_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    CONSTRAINT applications_job_opening_id_fkey FOREIGN KEY (job_opening_id) REFERENCES job_openings(id),
    CONSTRAINT applications_candidate_id_job_opening_id_key UNIQUE (candidate_id, job_opening_id)
);
--> statement-breakpoint

-- token_hash is the hash. The plaintext is mailed once and never stored
-- (docs/17 §7). It is globally unique so a redemption needs no org context.
CREATE TABLE IF NOT EXISTS invitations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL,
    application_id  uuid,
    assessment_id   uuid NOT NULL,
    token_hash      text NOT NULL,
    opens_at        timestamptz,
    expires_at      timestamptz NOT NULL,
    max_attempts    int NOT NULL DEFAULT 1,
    sent_at         timestamptz,
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invitations_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT invitations_application_id_fkey FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
    CONSTRAINT invitations_assessment_id_fkey FOREIGN KEY (assessment_id) REFERENCES assessments(id),
    CONSTRAINT invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
    CONSTRAINT invitations_token_hash_key UNIQUE (token_hash)
);
--> statement-breakpoint

-- deadline_at is computed by the server at start, from the assessment's
-- duration and the server's clock. The client clock is display only, and no
-- client input extends it (ADR-006).
--
-- integrity_flag is advisory. Nothing reads it to reject, void or down-score
-- (ADR-007, ADR-017).
CREATE TABLE IF NOT EXISTS attempts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL,
    invitation_id       uuid,
    candidate_id        uuid NOT NULL,
    assessment_id       uuid NOT NULL,
    assessment_version  int NOT NULL,
    status              attempt_status NOT NULL DEFAULT 'created',
    started_at          timestamptz,
    deadline_at         timestamptz,
    submitted_at        timestamptz,
    raw_score           numeric(8,2),
    max_score           numeric(8,2),
    score_pct           numeric(5,2),
    passed              boolean,
    integrity_flag      text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT attempts_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT attempts_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES invitations(id),
    CONSTRAINT attempts_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES candidates(id),
    CONSTRAINT attempts_assessment_id_fkey FOREIGN KEY (assessment_id) REFERENCES assessments(id)
);
--> statement-breakpoint

-- The exact question set this candidate was served, in order, with the
-- shuffle actually shown. Written once at attempt start, never re-rolled
-- (ADR-004). Without it a re-grade is guesswork and a dispute is
-- unresolvable.
CREATE TABLE IF NOT EXISTS attempt_questions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id          uuid NOT NULL,
    section_id          uuid,
    question_version_id uuid NOT NULL,
    ordinal             int NOT NULL,
    option_order        int[],
    max_score           numeric(6,2) NOT NULL,
    CONSTRAINT attempt_questions_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE,
    CONSTRAINT attempt_questions_section_id_fkey FOREIGN KEY (section_id) REFERENCES assessment_sections(id),
    CONSTRAINT attempt_questions_question_version_id_fkey FOREIGN KEY (question_version_id) REFERENCES question_versions(id),
    CONSTRAINT attempt_questions_attempt_id_ordinal_key UNIQUE (attempt_id, ordinal)
);
--> statement-breakpoint

-- One answer per served question, enforced here rather than in the
-- application: autosave retries, and at-least-once delivery makes a duplicate
-- insert normal rather than exceptional (docs/17 §6).
CREATE TABLE IF NOT EXISTS answers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_question_id uuid NOT NULL,
    selected_option_ids uuid[],
    text_answer         text,
    final_submission_id uuid,
    seconds_spent       int NOT NULL DEFAULT 0,
    auto_score          numeric(6,2),
    manual_score        numeric(6,2),
    final_score         numeric(6,2),
    graded_by           uuid,
    graded_at           timestamptz,
    answered_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT answers_attempt_question_id_fkey FOREIGN KEY (attempt_question_id) REFERENCES attempt_questions(id) ON DELETE CASCADE,
    CONSTRAINT answers_graded_by_fkey FOREIGN KEY (graded_by) REFERENCES users(id),
    CONSTRAINT answers_attempt_question_id_key UNIQUE (attempt_question_id)
);
--> statement-breakpoint

-- ============================================================
-- SECTION 7: CODE EXECUTION
-- Every run records the runtime identity that produced it, because a score
-- has to be explainable months later.
-- ============================================================

CREATE TABLE IF NOT EXISTS submissions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               uuid NOT NULL,
    attempt_question_id  uuid,
    interview_session_id uuid,
    language             text NOT NULL,
    language_version     text NOT NULL,
    runtime_image        text,
    source_code          text NOT NULL,
    is_trial_run         boolean NOT NULL DEFAULT false,
    status               text NOT NULL DEFAULT 'queued',
    compile_stderr       text,
    total_passed         int,
    total_cases          int,
    score                numeric(6,2),
    runtime_ms           int,
    memory_kb            int,
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT submissions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT submissions_attempt_question_id_fkey FOREIGN KEY (attempt_question_id) REFERENCES attempt_questions(id) ON DELETE CASCADE
);
--> statement-breakpoint

DO $fk$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'answers_final_submission_fk'
    ) THEN
        ALTER TABLE answers
            ADD CONSTRAINT answers_final_submission_fk
            FOREIGN KEY (final_submission_id) REFERENCES submissions(id);
    END IF;
END
$fk$;
--> statement-breakpoint

-- actual_stdout and stderr are truncated by the worker before they get here.
CREATE TABLE IF NOT EXISTS submission_results (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id   uuid NOT NULL,
    test_case_id    uuid,
    passed          boolean NOT NULL,
    actual_stdout   text,
    stderr          text,
    exit_code       int,
    runtime_ms      int,
    memory_kb       int,
    CONSTRAINT submission_results_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT submission_results_test_case_id_fkey FOREIGN KEY (test_case_id) REFERENCES test_cases(id)
);
--> statement-breakpoint

-- ============================================================
-- SECTION 8: LIVE INTERVIEWS
-- ============================================================

CREATE TABLE IF NOT EXISTS interview_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL,
    application_id  uuid,
    job_role_id     uuid,
    title           text,
    room_code       text NOT NULL,
    scheduled_at    timestamptz,
    started_at      timestamptz,
    ended_at        timestamptz,
    doc_state       bytea,
    recording_url   text,
    status          text NOT NULL DEFAULT 'scheduled',
    created_by      uuid,
    CONSTRAINT interview_sessions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT interview_sessions_application_id_fkey FOREIGN KEY (application_id) REFERENCES applications(id),
    CONSTRAINT interview_sessions_job_role_id_fkey FOREIGN KEY (job_role_id) REFERENCES job_roles(id),
    CONSTRAINT interview_sessions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
    CONSTRAINT interview_sessions_room_code_key UNIQUE (room_code)
);
--> statement-breakpoint

DO $fk$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'submissions_session_fk'
    ) THEN
        ALTER TABLE submissions
            ADD CONSTRAINT submissions_session_fk
            FOREIGN KEY (interview_session_id) REFERENCES interview_sessions(id);
    END IF;
END
$fk$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS session_participants (
    session_id       uuid NOT NULL,
    user_id          uuid,
    candidate_id     uuid,
    participant_role text NOT NULL,
    joined_at        timestamptz,
    left_at          timestamptz,
    CONSTRAINT session_participants_session_id_fkey FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
    CONSTRAINT session_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT session_participants_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES candidates(id),
    CONSTRAINT session_participants_check CHECK (num_nonnulls(user_id, candidate_id) = 1)
);
--> statement-breakpoint

-- The replay stream, including the candidate's own AI prompts (ADR-017).
-- High volume: partitioned by month and archived after ~90 days.
CREATE TABLE IF NOT EXISTS session_events (
    id              bigserial PRIMARY KEY,
    session_id      uuid NOT NULL,
    at              timestamptz NOT NULL DEFAULT now(),
    actor           text NOT NULL,
    event_type      text NOT NULL,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT session_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE
);
--> statement-breakpoint

-- ============================================================
-- SECTION 9: SCORECARDS (structured human judgement)
-- ADR-011 keeps every model out of the scoring and decision path, so nothing
-- writes these rows except a person.
-- ============================================================

CREATE TABLE IF NOT EXISTS scorecard_templates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL,
    job_role_id     uuid,
    name            text NOT NULL,
    is_active       boolean NOT NULL DEFAULT true,
    CONSTRAINT scorecard_templates_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    CONSTRAINT scorecard_templates_job_role_id_fkey FOREIGN KEY (job_role_id) REFERENCES job_roles(id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS scorecard_criteria (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id     uuid NOT NULL,
    skill_id        uuid,
    ordinal         int NOT NULL,
    label           text NOT NULL,
    anchor_md       text,
    weight          numeric(4,2) NOT NULL DEFAULT 1.0,
    scale_max       smallint NOT NULL DEFAULT 4,
    CONSTRAINT scorecard_criteria_template_id_fkey FOREIGN KEY (template_id) REFERENCES scorecard_templates(id) ON DELETE CASCADE,
    CONSTRAINT scorecard_criteria_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES skills(id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS scorecards (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id     uuid NOT NULL,
    session_id      uuid,
    attempt_id      uuid,
    reviewer_id     uuid NOT NULL,
    overall         text,
    notes_md        text,
    submitted_at    timestamptz,
    CONSTRAINT scorecards_template_id_fkey FOREIGN KEY (template_id) REFERENCES scorecard_templates(id),
    CONSTRAINT scorecards_session_id_fkey FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
    CONSTRAINT scorecards_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE,
    CONSTRAINT scorecards_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES users(id),
    CONSTRAINT scorecards_check CHECK (num_nonnulls(session_id, attempt_id) = 1)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS scorecard_ratings (
    scorecard_id    uuid NOT NULL,
    criterion_id    uuid NOT NULL,
    rating          smallint NOT NULL,
    comment         text,
    CONSTRAINT scorecard_ratings_pkey PRIMARY KEY (scorecard_id, criterion_id),
    CONSTRAINT scorecard_ratings_scorecard_id_fkey FOREIGN KEY (scorecard_id) REFERENCES scorecards(id) ON DELETE CASCADE,
    CONSTRAINT scorecard_ratings_criterion_id_fkey FOREIGN KEY (criterion_id) REFERENCES scorecard_criteria(id)
);
--> statement-breakpoint

-- ============================================================
-- SECTION 10: PROCTORING + AUDIT
-- Signals only. Never auto-reject on these — surface them to a human with the
-- evidence attached (ADR-007, ADR-017). There is deliberately no column here
-- that could hold a computed verdict.
-- ============================================================

CREATE TABLE IF NOT EXISTS proctor_events (
    id              bigserial PRIMARY KEY,
    attempt_id      uuid NOT NULL,
    at              timestamptz NOT NULL DEFAULT now(),
    event_type      text NOT NULL,
    severity        smallint NOT NULL DEFAULT 1,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT proctor_events_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE,
    CONSTRAINT proctor_events_severity_check CHECK (severity BETWEEN 1 AND 3)
);
--> statement-breakpoint

-- delete_after is a retention commitment, not a hint. Biometrics are swept on
-- it by the worker (docs/11 §4.1), by explicit delete rather than a bucket
-- lifecycle rule, because a promise we cannot verify is not a promise.
CREATE TABLE IF NOT EXISTS proctor_media (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id      uuid NOT NULL,
    kind            text NOT NULL,
    object_key      text NOT NULL,
    captured_at     timestamptz NOT NULL,
    delete_after    timestamptz NOT NULL,
    CONSTRAINT proctor_media_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE
);
--> statement-breakpoint

-- A domain record, not telemetry (docs/17 §9): append-only, queryable,
-- retained for seven years. org_id carries no foreign key on purpose — an
-- audit row must survive the hard deletion of the entity it describes, because
-- GDPR erasure removes the candidate and not the record that the candidate's
-- attempt was voided.
CREATE TABLE IF NOT EXISTS audit_log (
    id              bigserial PRIMARY KEY,
    org_id          uuid NOT NULL,
    actor_user_id   uuid,
    action          text NOT NULL,
    entity_type     text NOT NULL,
    entity_id       uuid,
    before          jsonb,
    after           jsonb,
    ip              inet,
    at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES users(id)
);
--> statement-breakpoint

-- ============================================================
-- SECTION 11: INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS users_org_id_idx ON users (org_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS questions_org_id_kind_status_idx ON questions (org_id, kind, status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS question_versions_question_id_version_no_idx ON question_versions (question_id, version_no DESC);
CREATE INDEX IF NOT EXISTS question_versions_prompt_md_trgm_idx ON question_versions USING gin (prompt_md gin_trgm_ops);
CREATE INDEX IF NOT EXISTS question_skills_skill_id_idx ON question_skills (skill_id);
CREATE INDEX IF NOT EXISTS job_role_skills_skill_id_idx ON job_role_skills (skill_id);
CREATE INDEX IF NOT EXISTS attempts_org_id_status_idx ON attempts (org_id, status);
CREATE INDEX IF NOT EXISTS attempts_candidate_id_created_at_idx ON attempts (candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attempt_questions_question_version_id_idx ON attempt_questions (question_version_id);
CREATE INDEX IF NOT EXISTS submissions_attempt_question_id_created_at_idx ON submissions (attempt_question_id, created_at DESC);
CREATE INDEX IF NOT EXISTS submission_results_submission_id_idx ON submission_results (submission_id);
CREATE INDEX IF NOT EXISTS session_events_session_id_at_idx ON session_events (session_id, at);
CREATE INDEX IF NOT EXISTS proctor_events_attempt_id_at_idx ON proctor_events (attempt_id, at);
CREATE INDEX IF NOT EXISTS audit_log_org_id_at_idx ON audit_log (org_id, at DESC);
CREATE INDEX IF NOT EXISTS invitations_expires_at_idx ON invitations (expires_at) WHERE sent_at IS NOT NULL;
--> statement-breakpoint

-- ============================================================
-- SECTION 12: SEED — the permission catalogue
--
-- Part of the product rather than of a customer's configuration, so it is
-- seeded by the migration that creates the table. ON CONFLICT DO NOTHING
-- makes a replay a no-op and lets a later migration add a key without
-- rewriting this one.
-- ============================================================

INSERT INTO permissions (key, description) VALUES
    ('question.read',    'View the question bank'),
    ('question.write',   'Create and edit questions'),
    ('question.publish', 'Publish a question version'),
    ('assessment.write', 'Create and edit assessments'),
    ('invite.send',      'Invite candidates to assessments'),
    ('attempt.read',     'View attempts and results'),
    ('attempt.grade',    'Manually grade or override scores'),
    ('attempt.void',     'Void an attempt for integrity reasons'),
    ('interview.host',   'Run live interview sessions'),
    ('report.export',    'Export candidate and aggregate reports'),
    ('org.admin',        'Manage users, roles and settings')
ON CONFLICT (key) DO NOTHING;
