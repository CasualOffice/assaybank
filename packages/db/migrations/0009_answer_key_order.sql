-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0009_answer_key_order — short-answer keys keep the order they were written in.
--
-- mcq_options and test_cases carry an ordinal and are read ORDER BY it.
-- short_answer_keys had none, and was read with no ORDER BY at all, so a
-- version's keys came back in whatever order the heap returned them.
-- Invariant 3 requires every collection that feeds a score to have a total
-- order, and the order of keys is the author's: which pattern is tried first
-- can decide which score applies. It is also what made an export of a
-- multi-key question disagree with its own re-import.
--
-- Expand only. The column is nullable and nothing is backfilled: for rows
-- written before this migration the authored order was never recorded and
-- cannot be recovered, so the reader orders by `ordinal NULLS LAST, id` —
-- total and stable, if arbitrary, for those rows, and the authored order for
-- every row written from here on. Making it NOT NULL, with a unique
-- (question_version_id, ordinal) like its siblings, is a later contract step
-- once no writer that omits it can still be deployed.
-- ============================================================

ALTER TABLE short_answer_keys ADD COLUMN IF NOT EXISTS ordinal int;
