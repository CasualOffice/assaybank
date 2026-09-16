-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0007_question_bank_lookup — the indexes `GET /questions` reads through.
--
-- P2 step 1. Additive only: no table, no column, no constraint and no change
-- to an existing object. Every statement is `IF NOT EXISTS`, so the file
-- replays as a no-op and `make migrate` twice reports `applied: 0` on the
-- second run. Expand-contract has nothing to contract here — an index is the
-- one kind of schema change that is purely an expand.
--
-- Four lookups exist and 0001 covers two of them:
--
--   * `questions_org_id_kind_status_idx` already serves a filtered list.
--   * `question_versions_prompt_md_trgm_idx` already serves `?q=`.
--
-- What is missing is the *ordering*. `GET /questions` is cursor-paginated on
-- `(created_at DESC, id DESC)` (docs/03 §2 — offset pagination breaks under
-- concurrent insertion, and this system inserts constantly during an import),
-- and a keyset page with no index on the sort key is a sort of the whole
-- tenant's bank per page. That is invisible at 200 questions and is the exit
-- criterion's number, not a ceiling: the same query is what an organisation
-- with 40,000 imported items runs.
--
-- Partial on `archived_at IS NULL`, matching the default list and the partial
-- index 0001 already established for this table. A soft-deleted question is
-- excluded from the ordinary list, so it has no business in the index that
-- serves it.
--
-- The `question_versions` index is the other half of the same page: the list
-- joins each question to its current version for `difficulty` and the prompt
-- excerpt, and `GET /questions/{id}/versions` walks a question's versions
-- newest-first. 0001's `question_versions_question_id_version_no_idx` serves
-- the second; this one serves the join by primary key ordering that the first
-- needs when a question has many versions.
--
-- Not `CONCURRENTLY`. A concurrent build cannot run inside a transaction, and
-- the migration runner wraps each file in one; these tables are small enough
-- at this point in the product's life that the brief `SHARE` lock is cheaper
-- than the machinery to special-case it. When the bank is large enough for
-- that to be wrong, the index will already exist.
-- ============================================================

-- The keyset order of `GET /questions`. `org_id` leads because every query is
-- tenant-scoped by policy (ADR-010) and the planner needs the tenant key to be
-- the first column to use the index for a single organisation at all.
CREATE INDEX IF NOT EXISTS questions_org_id_created_at_id_idx
    ON questions (org_id, created_at DESC, id DESC)
    WHERE archived_at IS NULL;
--> statement-breakpoint

-- `?exposure_gt=` — FR-4's "flag questions exceeding a configurable threshold
-- for retirement". A recruiter asking which questions are over-exposed is
-- asking for a small tail of a large table, which is what a partial-friendly
-- btree on the counter answers cheaply. Published questions only: a draft has
-- never been served, so its exposure count is zero by construction and it
-- would be dead weight in the index.
CREATE INDEX IF NOT EXISTS questions_org_id_exposure_count_idx
    ON questions (org_id, exposure_count DESC)
    WHERE archived_at IS NULL AND status = 'published';
--> statement-breakpoint

-- `question_skills` is walked from the skill side by `?skill_id=` — 0001
-- already indexes that direction. This is the other one: "which skills does
-- this question measure", read once per question detail page and once per
-- coverage report row.
CREATE INDEX IF NOT EXISTS question_skills_question_id_idx
    ON question_skills (question_id);
--> statement-breakpoint

-- The published-version lookup behind assessment composition and the coverage
-- report: "the published versions of this question, newest first". Partial,
-- because an unpublished version can never be drawn (ADR-003) and the
-- composer never asks about one.
CREATE INDEX IF NOT EXISTS question_versions_published_idx
    ON question_versions (question_id, published_at DESC)
    WHERE published_at IS NOT NULL;
--> statement-breakpoint

-- ============================================================
-- ADR-003, finished.
--
-- 0001 installed `question_versions_immutable`, which refuses any UPDATE of a
-- published version. That closes the obvious door and leaves four windows
-- open: `mcq_options`, `coding_specs`, `test_cases` and `short_answer_keys`
-- hang off `question_versions` and had no trigger of their own, so
--
--     UPDATE mcq_options SET is_correct = true WHERE id = ...
--
-- against the options of a published version was permitted by the database.
-- The `question_versions` row would be untouched and byte-identical, its
-- `published_at` unchanged, and the *meaning* of the version — which option
-- is the right one — would have silently changed underneath every attempt
-- that had already been graded against it. That is precisely the failure
-- ADR-003 exists to prevent, arrived at through a side door.
--
-- FR-1 says "a published question version is immutable". The content of a
-- version is not only the row that carries its prompt.
--
-- One function serves all four tables. It reads `question_version_id` out of
-- the row generically, through `to_jsonb`, rather than existing in four
-- near-identical copies that would drift the first time one of them was
-- edited.
--
-- **DELETE is covered here, unlike in 0001, and the difference is not an
-- inconsistency.** 0001 exempts DELETE because organisation deletion and GDPR
-- erasure cascade through `question_versions`, and a trigger that blocked
-- them would turn a legal obligation into an outage (docs/11 §6). The same
-- cascades reach these four tables — but they reach them *through* the parent,
-- and PostgreSQL applies `ON DELETE CASCADE` as a referential action that runs
-- after the referenced row is gone. So by the time this trigger fires for a
-- cascaded delete, the parent version no longer exists, the `EXISTS` below is
-- false, and the delete proceeds. A direct `DELETE FROM mcq_options WHERE
-- id = ...` against a live published version finds its parent exactly where it
-- left it, and is refused. Erasure keeps working; tampering does not.
--
-- The same reasoning makes the check safe for INSERT: adding a hidden test
-- case to a published coding question changes what that version scores.
--
-- Nothing here is a business rule (docs/17 §12 — "business logic in a database
-- function" is a named anti-pattern). It is one integrity constraint that
-- cannot be spelled as a CHECK because it spans two tables, which is the
-- circumstance a trigger is for. The API answers `409 version_immutable`
-- before a statement ever gets here; this is what makes that answer true for
-- the importer, for a migration and for a human at a psql prompt as well.
-- ============================================================

CREATE OR REPLACE FUNCTION public.question_version_child_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_row        jsonb;
    v_version_id uuid;
BEGIN
    -- The row being written, whichever direction this is. Branched on TG_OP
    -- rather than COALESCE(NEW, OLD): the unused one of the pair is an
    -- unassigned record in plpgsql, and naming it is the kind of thing that
    -- works until the day it does not. Read generically through jsonb so one
    -- function covers four tables; every one of them names the column
    -- `question_version_id`.
    IF TG_OP = 'DELETE' THEN
        v_row := to_jsonb(OLD);
    ELSE
        v_row := to_jsonb(NEW);
    END IF;

    v_version_id := (v_row ->> 'question_version_id')::uuid;

    IF v_version_id IS NOT NULL AND EXISTS (
        SELECT 1
          FROM public.question_versions qv
         WHERE qv.id = v_version_id
           AND qv.published_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'question_version % is published; its % rows are immutable (ADR-003)',
            v_version_id, TG_TABLE_NAME
            USING ERRCODE = 'integrity_constraint_violation',
                  HINT = 'Insert a new question_version and move questions.current_version_id.';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$fn$;
--> statement-breakpoint

COMMENT ON FUNCTION public.question_version_child_reject_mutation() IS
    'ADR-003: the option, spec, test-case and answer-key rows of a published question '
    'version are immutable. Cascaded deletes pass, because the parent version is already '
    'gone by the time the referential action reaches the child.';
--> statement-breakpoint

DROP TRIGGER IF EXISTS mcq_options_immutable ON mcq_options;
--> statement-breakpoint
CREATE TRIGGER mcq_options_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON mcq_options
    FOR EACH ROW
    EXECUTE FUNCTION public.question_version_child_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS coding_specs_immutable ON coding_specs;
--> statement-breakpoint
CREATE TRIGGER coding_specs_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON coding_specs
    FOR EACH ROW
    EXECUTE FUNCTION public.question_version_child_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS test_cases_immutable ON test_cases;
--> statement-breakpoint
CREATE TRIGGER test_cases_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON test_cases
    FOR EACH ROW
    EXECUTE FUNCTION public.question_version_child_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS short_answer_keys_immutable ON short_answer_keys;
--> statement-breakpoint
CREATE TRIGGER short_answer_keys_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON short_answer_keys
    FOR EACH ROW
    EXECUTE FUNCTION public.question_version_child_reject_mutation();
