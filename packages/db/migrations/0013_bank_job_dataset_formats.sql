-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0013_bank_job_dataset_formats — the named datasets H-032 imports.
--
-- 0010 constrained `bank_jobs.format` to the two interchange formats
-- this system both reads and writes. The dataset importers add four
-- it only ever reads: HumanEval, MBPP, LBPP and Exercism, whose
-- licences and field mappings are in
-- apps/worker/src/interchange/datasets/, and whose terms are in
-- docs/05 §2. Exercism arrives as a zip of exercise directories
-- rather than a line-delimited file; the other three are JSONL.
--
-- Import-only is a deliberate asymmetry rather than an unfinished
-- half. We do not own those file shapes, and a question edited here
-- has no MBPP row to become — writing one back out would claim a
-- fidelity we cannot promise. An export of imported content is a JSON
-- bank document, which keeps `source_license` and `external_ref` per
-- item and an `attributions` list in its header, so the CC-BY credit
-- MBPP requires survives the round trip. `ExportQuerySchema` refuses
-- a dataset format at the API rather than letting a job fail later
-- with the same information.
--
-- Expand-contract (invariant 15). Widening a CHECK only ever accepts
-- more: every existing row satisfies the new predicate because it
-- satisfied the old one, which was stricter. The drop and the add are
-- one transaction, so no window exists in which the column is
-- unconstrained, and there is nothing to backfill and nothing to
-- rewrite — PostgreSQL validates a new CHECK against existing rows
-- without a table rewrite.
-- ============================================================

-- `IF EXISTS`, so the file replays against a database whose shape already
-- matches -- the local stack bootstraps table shapes from the documented DDL
-- before `make migrate` runs. See the note in 0012.
ALTER TABLE bank_jobs
    DROP CONSTRAINT IF EXISTS bank_jobs_format_check;

ALTER TABLE bank_jobs
    ADD CONSTRAINT bank_jobs_format_check
    CHECK (format IN ('json', 'qti', 'humaneval', 'mbpp', 'lbpp', 'exercism'));

-- An export is still one of ours. The constraint above admits six values for the
-- column; this one says which of them an export row may carry, so a dataset format
-- cannot reach an export path through a route nobody re-checked.
ALTER TABLE bank_jobs
    DROP CONSTRAINT IF EXISTS bank_jobs_export_format_check;

ALTER TABLE bank_jobs
    ADD CONSTRAINT bank_jobs_export_format_check
    CHECK (kind <> 'export' OR format IN ('json', 'qti'));
