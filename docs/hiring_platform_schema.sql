-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- Technical hiring platform - PostgreSQL schema
-- Covers: question bank, job roles, RBAC, assessments,
--         attempts, code submissions, live interviews, proctoring
--
-- Conventions:
--   - UUID primary keys (pgcrypto gen_random_uuid)
--   - Every tenant-scoped table carries org_id for row-level isolation
--   - timestamptz everywhere, never naive timestamps
--   - Soft delete via archived_at, hard delete only for GDPR erasure
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy search over question text
CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive email on users and candidates


-- ============================================================
-- SECTION 1: TENANCY, USERS, RBAC
-- "user roles" = who can do what inside your tool
-- ============================================================

CREATE TABLE organizations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL,
    slug            text NOT NULL UNIQUE,
    settings        jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           citext NOT NULL,
    full_name       text NOT NULL,
    password_hash   text,                   -- null when SSO-only
    sso_subject     text,
    timezone        text NOT NULL DEFAULT 'UTC',
    archived_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, email)
);

-- RBAC. Kept as data, not an enum, so orgs can define custom roles.
CREATE TABLE user_roles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE,
    key             text NOT NULL,          -- 'admin' | 'recruiter' | 'interviewer' | 'reviewer'
    name            text NOT NULL,
    is_system       boolean NOT NULL DEFAULT false,
    UNIQUE (org_id, key)
);

CREATE TABLE permissions (
    key             text PRIMARY KEY,       -- 'question.write', 'attempt.grade', 'report.export'
    description     text NOT NULL
);

CREATE TABLE user_role_permissions (
    user_role_id    uuid NOT NULL REFERENCES user_roles(id) ON DELETE CASCADE,
    permission_key  text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
    PRIMARY KEY (user_role_id, permission_key)
);

CREATE TABLE user_role_assignments (
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_role_id    uuid NOT NULL REFERENCES user_roles(id) ON DELETE CASCADE,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, user_role_id)
);


-- ============================================================
-- SECTION 2: SKILL TAXONOMY
-- The join between job roles and questions. Tag questions with
-- skills, not with roles - otherwise every new role means re-tagging.
-- ============================================================

CREATE TABLE skills (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global taxonomy
    parent_id       uuid REFERENCES skills(id) ON DELETE SET NULL,
    key             text NOT NULL,          -- 'python', 'sql.window-functions', 'system-design'
    name            text NOT NULL,
    category        text,                   -- 'language' | 'framework' | 'cs-fundamentals' | 'cloud'
    UNIQUE (org_id, key)
);


-- ============================================================
-- SECTION 3: JOB ROLES
-- "job roles" = the positions you are hiring for.
-- Distinct from user_roles above. Do not merge these.
-- ============================================================

CREATE TABLE job_roles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code            text NOT NULL,          -- 'BE-SDE1', 'DATA-ANALYST'
    title           text NOT NULL,
    family          text,                   -- 'engineering' | 'data' | 'devops'
    seniority       text,                   -- 'intern' | 'junior' | 'mid' | 'senior' | 'staff'
    description     text,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, code)
);

-- What a role needs, and how much each skill matters.
-- Drives automatic assessment generation and candidate scoring weights.
CREATE TABLE job_role_skills (
    job_role_id     uuid NOT NULL REFERENCES job_roles(id) ON DELETE CASCADE,
    skill_id        uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    weight          numeric(4,2) NOT NULL DEFAULT 1.0 CHECK (weight >= 0),
    min_difficulty  smallint CHECK (min_difficulty BETWEEN 1 AND 5),
    max_difficulty  smallint CHECK (max_difficulty BETWEEN 1 AND 5),
    is_required     boolean NOT NULL DEFAULT true,
    PRIMARY KEY (job_role_id, skill_id)
);

CREATE TABLE job_openings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    job_role_id     uuid NOT NULL REFERENCES job_roles(id),
    title           text NOT NULL,
    location        text,
    headcount       int NOT NULL DEFAULT 1,
    status          text NOT NULL DEFAULT 'open',   -- open | paused | closed
    opened_at       timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz
);


-- ============================================================
-- SECTION 4: QUESTION BANK
-- questions  = stable identity
-- question_versions = immutable content. Never UPDATE a published
-- version; insert a new one. Attempts reference the version.
-- ============================================================

CREATE TYPE question_kind AS ENUM (
    'mcq_single',      -- one correct option
    'mcq_multi',       -- several correct options, partial credit possible
    'true_false',
    'short_answer',    -- string/regex/numeric match, auto-graded
    'coding',          -- run against test cases
    'sql',             -- run against a fixture database
    'subjective',      -- free text, human graded
    'system_design'    -- whiteboard / diagram, human graded
);

CREATE TYPE question_status AS ENUM ('draft', 'review', 'published', 'retired');

CREATE TABLE questions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind                question_kind NOT NULL,
    status              question_status NOT NULL DEFAULT 'draft',
    current_version_id  uuid,               -- FK added after question_versions exists
    external_ref        text,               -- 'humaneval/42', 'lbpp/17' for imported content
    source_license      text,               -- 'MIT', 'Apache-2.0', 'CC-BY-4.0', 'proprietary'
    author_id           uuid REFERENCES users(id),
    exposure_count      int NOT NULL DEFAULT 0,   -- times served; retire when too high
    archived_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE question_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id     uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    version_no      int NOT NULL,
    locale          text NOT NULL DEFAULT 'en',
    prompt_md       text NOT NULL,          -- markdown, rendered client-side
    explanation_md  text,                   -- shown post-attempt or in review
    difficulty      smallint NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
    est_seconds     int NOT NULL DEFAULT 120,
    max_score       numeric(6,2) NOT NULL DEFAULT 1.0,
    negative_score  numeric(6,2) NOT NULL DEFAULT 0.0,   -- for negative marking
    payload         jsonb NOT NULL DEFAULT '{}',          -- kind-specific extras
    published_at    timestamptz,
    created_by      uuid REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (question_id, version_no, locale)
);

ALTER TABLE questions
    ADD CONSTRAINT questions_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES question_versions(id);

CREATE TABLE question_skills (
    question_id     uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    skill_id        uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    weight          numeric(4,2) NOT NULL DEFAULT 1.0,
    PRIMARY KEY (question_id, skill_id)
);

-- ---- MCQ ----------------------------------------------------
CREATE TABLE mcq_options (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_version_id uuid NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
    ordinal             int NOT NULL,
    body_md             text NOT NULL,
    is_correct          boolean NOT NULL DEFAULT false,
    score_delta         numeric(6,2),       -- overrides default partial credit
    rationale_md        text,
    UNIQUE (question_version_id, ordinal)
);

-- ---- Coding -------------------------------------------------
CREATE TABLE coding_specs (
    question_version_id uuid PRIMARY KEY REFERENCES question_versions(id) ON DELETE CASCADE,
    allowed_languages   text[] NOT NULL,    -- {'python','java','cpp','go'}
    starter_code        jsonb NOT NULL DEFAULT '{}',  -- {"python": "def solve(...):", ...}
    solution_code       jsonb NOT NULL DEFAULT '{}',  -- reference solutions, never sent to client
    time_limit_ms       int NOT NULL DEFAULT 5000,
    memory_limit_kb     int NOT NULL DEFAULT 262144,
    grading_mode        text NOT NULL DEFAULT 'test_cases',  -- test_cases | unit_tests | custom_checker
    checker_code        text,
    fixture_sql         text                -- for kind='sql': schema + seed data
);

CREATE TABLE test_cases (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_version_id uuid NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
    ordinal             int NOT NULL,
    label               text,
    stdin               text NOT NULL DEFAULT '',
    expected_stdout     text,
    args                text[],
    assertion_code      text,               -- unit_tests mode: the test this case runs (ADR-024)
    is_sample           boolean NOT NULL DEFAULT false,  -- visible to candidate
    weight              numeric(6,2) NOT NULL DEFAULT 1.0,
    UNIQUE (question_version_id, ordinal)
);

-- ---- Short answer -------------------------------------------
CREATE TABLE short_answer_keys (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_version_id uuid NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
    ordinal             int,                -- authored order; nullable until contracted (migration 0009)
    match_type          text NOT NULL,      -- exact | ci | regex | numeric_tolerance
    pattern             text NOT NULL,
    tolerance           numeric,
    score               numeric(6,2) NOT NULL DEFAULT 1.0
);

-- ---- Bank import and export jobs (migration 0010, ADR-021) ----
-- The outbox and the record: a request writes the row; the worker claims it
-- through claim_bank_jobs(), which returns id and org_id only.
CREATE TABLE bank_jobs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind                text NOT NULL,      -- import | export
    format              text NOT NULL,      -- json | qti (both ways); humaneval | mbpp | lbpp (import only, 0013)
    status              text NOT NULL DEFAULT 'queued',  -- queued | dispatched | running | succeeded | failed
    requested_by        uuid NOT NULL REFERENCES users(id),
    options             jsonb NOT NULL DEFAULT '{}',
    input               bytea,              -- the upload; cleared when the job finishes
    input_bytes         int,                -- at most 32 MiB
    result              bytea,              -- an export's file, readable until expires_at
    result_content_type text,
    result_bytes        int,
    next_index          int NOT NULL DEFAULT 0,   -- import checkpoint, advanced with each item
    created_count       int NOT NULL DEFAULT 0,
    skipped_count       int NOT NULL DEFAULT 0,
    problems            jsonb NOT NULL DEFAULT '[]',  -- at most 1,000
    problems_truncated  boolean NOT NULL DEFAULT false,
    failure             text,
    created_at          timestamptz NOT NULL,
    dispatched_at       timestamptz,
    started_at          timestamptz,
    finished_at         timestamptz,
    expires_at          timestamptz
);

-- ---- Psychometrics ------------------------------------------
-- Recomputed nightly. Lets you retire bad questions instead of
-- guessing at difficulty forever.
CREATE TABLE question_stats (
    question_version_id uuid PRIMARY KEY REFERENCES question_versions(id) ON DELETE CASCADE,
    n_attempts          int NOT NULL DEFAULT 0,
    p_value             numeric(5,4),       -- proportion correct; 0.2-0.8 is the useful band
    discrimination      numeric(5,4),       -- point-biserial vs total score; want > 0.2
    mean_seconds        numeric(8,2),
    computed_at         timestamptz
);


-- ============================================================
-- SECTION 5: ASSESSMENTS (test templates)
-- A section either pins specific questions or draws randomly
-- from a pool defined by a rule. AWS-cert style randomisation
-- comes from the rules.
-- ============================================================

CREATE TABLE assessments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    job_role_id         uuid REFERENCES job_roles(id),
    name                text NOT NULL,
    description         text,
    duration_seconds    int NOT NULL,
    pass_score_pct      numeric(5,2),
    shuffle_sections    boolean NOT NULL DEFAULT false,
    allow_back_nav      boolean NOT NULL DEFAULT true,
    proctoring_profile  text NOT NULL DEFAULT 'none',  -- none | basic | strict
    status              question_status NOT NULL DEFAULT 'draft',
    version_no          int NOT NULL DEFAULT 1,
    created_by          uuid REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assessment_sections (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id       uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    ordinal             int NOT NULL,
    name                text NOT NULL,      -- 'Aptitude MCQ', 'DSA coding'
    kind                question_kind,      -- optional homogeneity constraint
    duration_seconds    int,                -- null = share the assessment timer
    shuffle_questions   boolean NOT NULL DEFAULT true,
    shuffle_options     boolean NOT NULL DEFAULT true,
    UNIQUE (assessment_id, ordinal)
);

-- Fixed picks
CREATE TABLE section_questions (
    section_id          uuid NOT NULL REFERENCES assessment_sections(id) ON DELETE CASCADE,
    question_id         uuid NOT NULL REFERENCES questions(id),
    pin_version_id      uuid REFERENCES question_versions(id),  -- null = use current
    ordinal             int NOT NULL,
    score_override      numeric(6,2),
    PRIMARY KEY (section_id, question_id)
);

-- Random draw: "5 questions, skill=python, difficulty 2-3, not seen in 90 days"
CREATE TABLE section_rules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    section_id          uuid NOT NULL REFERENCES assessment_sections(id) ON DELETE CASCADE,
    pick_count          int NOT NULL CHECK (pick_count > 0),
    skill_ids           uuid[] NOT NULL DEFAULT '{}',
    kinds               question_kind[] NOT NULL DEFAULT '{}',
    min_difficulty      smallint NOT NULL DEFAULT 1,
    max_difficulty      smallint NOT NULL DEFAULT 5,
    exclude_seen_days   int NOT NULL DEFAULT 0,
    score_per_question  numeric(6,2)
);


-- ============================================================
-- SECTION 6: CANDIDATES, INVITATIONS, ATTEMPTS
-- ============================================================

CREATE TABLE candidates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           citext NOT NULL,
    full_name       text,
    phone           text,
    resume_url      text,
    source          text,                   -- 'campus' | 'referral' | 'inbound'
    consent_at      timestamptz,            -- proctoring / data-processing consent
    erase_after     timestamptz,            -- GDPR retention clock
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, email)
);

CREATE TABLE applications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    candidate_id    uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    job_opening_id  uuid NOT NULL REFERENCES job_openings(id),
    stage           text NOT NULL DEFAULT 'applied',  -- applied|screening|interview|offer|rejected
    stage_changed_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (candidate_id, job_opening_id)
);

CREATE TABLE invitations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    application_id  uuid REFERENCES applications(id) ON DELETE CASCADE,
    assessment_id   uuid NOT NULL REFERENCES assessments(id),
    token_hash      text NOT NULL UNIQUE,   -- store the hash, mail the plaintext
    opens_at        timestamptz,
    expires_at      timestamptz NOT NULL,
    max_attempts    int NOT NULL DEFAULT 1,
    sent_at         timestamptz,
    created_by      uuid REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE attempt_status AS ENUM (
    'created', 'in_progress', 'submitted', 'expired',
    'auto_graded', 'under_review', 'finalised', 'voided'
);

CREATE TABLE attempts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    invitation_id       uuid REFERENCES invitations(id),
    candidate_id        uuid NOT NULL REFERENCES candidates(id),
    assessment_id       uuid NOT NULL REFERENCES assessments(id),
    assessment_version  int NOT NULL,
    status              attempt_status NOT NULL DEFAULT 'created',
    started_at          timestamptz,
    deadline_at         timestamptz,        -- computed at start; the server owns the clock
    submitted_at        timestamptz,
    raw_score           numeric(8,2),
    max_score           numeric(8,2),
    score_pct           numeric(5,2),
    passed              boolean,
    integrity_flag      text,               -- clean | suspicious | violation
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- The exact question set this candidate was served, in order.
-- Materialised at attempt start. Without this you cannot re-grade,
-- resolve a dispute, or measure question exposure.
CREATE TABLE attempt_questions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id          uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    section_id          uuid REFERENCES assessment_sections(id),
    question_version_id uuid NOT NULL REFERENCES question_versions(id),
    ordinal             int NOT NULL,
    option_order        int[],              -- the shuffle actually shown
    max_score           numeric(6,2) NOT NULL,
    UNIQUE (attempt_id, ordinal)
);

CREATE TABLE answers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_question_id uuid NOT NULL UNIQUE REFERENCES attempt_questions(id) ON DELETE CASCADE,
    selected_option_ids uuid[],             -- MCQ
    text_answer         text,               -- short answer / subjective
    final_submission_id uuid,               -- coding; FK added below
    seconds_spent       int NOT NULL DEFAULT 0,
    auto_score          numeric(6,2),
    manual_score        numeric(6,2),
    final_score         numeric(6,2),
    graded_by           uuid REFERENCES users(id),
    graded_at           timestamptz,
    answered_at         timestamptz NOT NULL DEFAULT now()
);


-- ============================================================
-- SECTION 7: CODE EXECUTION
-- Every run is recorded with the runtime identity that produced it.
-- ============================================================

CREATE TABLE submissions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    attempt_question_id uuid REFERENCES attempt_questions(id) ON DELETE CASCADE,
    interview_session_id uuid,              -- FK added after sessions table
    language            text NOT NULL,
    language_version    text NOT NULL,      -- '3.12.0' - reproducibility
    runtime_image       text,               -- piston package id or container digest
    source_code         text NOT NULL,
    is_trial_run        boolean NOT NULL DEFAULT false,  -- candidate hit "Run", not "Submit"
    status              text NOT NULL DEFAULT 'queued',  -- queued|running|done|error|timeout
    compile_stderr      text,
    total_passed        int,
    total_cases         int,
    score               numeric(6,2),
    runtime_ms          int,
    memory_kb           int,
    created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE answers
    ADD CONSTRAINT answers_final_submission_fk
    FOREIGN KEY (final_submission_id) REFERENCES submissions(id);

CREATE TABLE submission_results (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id   uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    test_case_id    uuid REFERENCES test_cases(id),
    passed          boolean NOT NULL,
    actual_stdout   text,                   -- truncate before storing; these get large
    stderr          text,
    exit_code       int,
    runtime_ms      int,
    memory_kb       int
);


-- ============================================================
-- SECTION 8: LIVE INTERVIEWS
-- ============================================================

CREATE TABLE interview_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    application_id  uuid REFERENCES applications(id),
    job_role_id     uuid REFERENCES job_roles(id),
    title           text,
    room_code       text NOT NULL UNIQUE,   -- short shareable join code
    scheduled_at    timestamptz,
    started_at      timestamptz,
    ended_at        timestamptz,
    doc_state       bytea,                  -- final Yjs document snapshot
    recording_url   text,
    status          text NOT NULL DEFAULT 'scheduled',
    created_by      uuid REFERENCES users(id)
);

ALTER TABLE submissions
    ADD CONSTRAINT submissions_session_fk
    FOREIGN KEY (interview_session_id) REFERENCES interview_sessions(id);

CREATE TABLE session_participants (
    session_id      uuid NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
    user_id         uuid REFERENCES users(id),
    candidate_id    uuid REFERENCES candidates(id),
    participant_role text NOT NULL,         -- interviewer | candidate | observer
    joined_at       timestamptz,
    left_at         timestamptz,
    CHECK (num_nonnulls(user_id, candidate_id) = 1)
);

-- Keystroke/event stream for replay. High volume - partition by month
-- and move to cold storage or the object store after ~90 days.
CREATE TABLE session_events (
    id              bigserial PRIMARY KEY,
    session_id      uuid NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
    at              timestamptz NOT NULL DEFAULT now(),
    actor           text NOT NULL,          -- 'candidate' | 'interviewer'
    event_type      text NOT NULL,          -- edit | run | paste | language_change | ai_prompt
    payload         jsonb NOT NULL DEFAULT '{}'
);


-- ============================================================
-- SECTION 9: SCORECARDS (structured human judgement)
-- ============================================================

CREATE TABLE scorecard_templates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    job_role_id     uuid REFERENCES job_roles(id),
    name            text NOT NULL,
    is_active       boolean NOT NULL DEFAULT true
);

CREATE TABLE scorecard_criteria (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id     uuid NOT NULL REFERENCES scorecard_templates(id) ON DELETE CASCADE,
    skill_id        uuid REFERENCES skills(id),
    ordinal         int NOT NULL,
    label           text NOT NULL,
    anchor_md       text,                   -- what a 1 vs a 4 actually looks like
    weight          numeric(4,2) NOT NULL DEFAULT 1.0,
    scale_max       smallint NOT NULL DEFAULT 4
);

CREATE TABLE scorecards (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id     uuid NOT NULL REFERENCES scorecard_templates(id),
    session_id      uuid REFERENCES interview_sessions(id) ON DELETE CASCADE,
    attempt_id      uuid REFERENCES attempts(id) ON DELETE CASCADE,
    reviewer_id     uuid NOT NULL REFERENCES users(id),
    overall         text,                   -- strong_no | no | yes | strong_yes
    notes_md        text,
    submitted_at    timestamptz,
    CHECK (num_nonnulls(session_id, attempt_id) = 1)
);

CREATE TABLE scorecard_ratings (
    scorecard_id    uuid NOT NULL REFERENCES scorecards(id) ON DELETE CASCADE,
    criterion_id    uuid NOT NULL REFERENCES scorecard_criteria(id),
    rating          smallint NOT NULL,
    comment         text,
    PRIMARY KEY (scorecard_id, criterion_id)
);


-- ============================================================
-- SECTION 10: PROCTORING + AUDIT
-- Signals only. Never auto-reject on these - surface them to a
-- human with the evidence attached.
-- ============================================================

CREATE TABLE proctor_events (
    id              bigserial PRIMARY KEY,
    attempt_id      uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    at              timestamptz NOT NULL DEFAULT now(),
    event_type      text NOT NULL,          -- tab_blur | fullscreen_exit | paste | copy |
                                            -- devtools_open | multi_face | no_face | second_screen
    severity        smallint NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
    payload         jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE proctor_media (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id      uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    kind            text NOT NULL,          -- webcam_snapshot | screen_clip | id_photo
    object_key      text NOT NULL,          -- S3/R2 key, never a public URL
    captured_at     timestamptz NOT NULL,
    delete_after    timestamptz NOT NULL    -- enforce retention, do not keep biometrics forever
);

CREATE TABLE audit_log (
    id              bigserial PRIMARY KEY,
    org_id          uuid NOT NULL,
    actor_user_id   uuid REFERENCES users(id),
    action          text NOT NULL,          -- 'question.publish', 'attempt.void', 'score.override'
    entity_type     text NOT NULL,
    entity_id       uuid,
    before          jsonb,
    after           jsonb,
    ip              inet,
    at              timestamptz NOT NULL DEFAULT now()
);


-- ============================================================
-- SECTION 11: INDEXES
-- ============================================================

CREATE INDEX ON users (org_id) WHERE archived_at IS NULL;
CREATE INDEX ON questions (org_id, kind, status) WHERE archived_at IS NULL;
CREATE INDEX ON question_versions (question_id, version_no DESC);
CREATE INDEX ON question_versions USING gin (prompt_md gin_trgm_ops);
CREATE INDEX ON question_skills (skill_id);
CREATE INDEX ON job_role_skills (skill_id);
CREATE INDEX ON attempts (org_id, status);
CREATE INDEX ON attempts (candidate_id, created_at DESC);
CREATE INDEX ON attempt_questions (question_version_id);   -- exposure counting
CREATE INDEX ON submissions (attempt_question_id, created_at DESC);
CREATE INDEX ON submission_results (submission_id);
CREATE INDEX ON session_events (session_id, at);
CREATE INDEX ON proctor_events (attempt_id, at);
CREATE INDEX ON audit_log (org_id, at DESC);
CREATE INDEX ON invitations (expires_at) WHERE sent_at IS NOT NULL;


-- ============================================================
-- SECTION 12: ROW LEVEL SECURITY (enable per table as you go)
-- Set app.current_org in your connection pool on every request.
-- ============================================================

-- ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY org_isolation ON questions
--     USING (org_id = current_setting('app.current_org')::uuid);


-- ============================================================
-- SECTION 13: SEED - system user roles and permissions
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
ON CONFLICT DO NOTHING;

-- System roles are global rows (org_id NULL) written by `make seed`, not by a
-- migration: see packages/db/src/seed.ts, whose list is the one that runs.
-- One role per persona in docs/01-PRD.md section 3.
--   admin            every permission  -- a new org must be able to configure itself
--   question_author  question.read, question.write, question.publish
--   recruiter        question.read, assessment.write, invite.send, attempt.read, report.export
--   interviewer      question.read, interview.host, attempt.read, attempt.grade
--   hiring_manager   attempt.read, report.export
--
-- UNIQUE (org_id, key) does NOT constrain these rows: PostgreSQL treats NULLs as
-- distinct, so without the partial indexes below a second seed run writes a second
-- copy of every global row (migration 0011).
CREATE UNIQUE INDEX skills_global_key_key     ON skills (key)     WHERE org_id IS NULL;
CREATE UNIQUE INDEX user_roles_global_key_key ON user_roles (key) WHERE org_id IS NULL;
