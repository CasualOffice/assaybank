-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0012_test_case_assertion — where a unit test actually lives (ADR-024).
--
-- `question_versions.grading_mode` has read `test_cases | unit_tests |
-- custom_checker` since 0001, and only the first has ever had semantics.
-- Nothing needed the others, because execution is M2.
--
-- H-032 needs them now. HumanEval, MBPP, LBPP and Exercism are all
-- unit-test datasets: a function to implement and Python assertions that
-- call it. There is no stdin and no expected stdout anywhere in them, and
-- the three ways of importing them without this column all cost more than
-- it does:
--
--   * Parsing `assert f(a, b) == c` into args and an expected value means
--     interpreting Python expression semantics with a regex. MBPP compares
--     floats with math.isclose, returns unordered sets, and passes nested
--     structures. A meaningful fraction would import subtly wrong, and a
--     candidate would lose marks to our parser.
--   * The whole module in `checker_code` collapses a problem to one
--     pass-or-fail: no partial credit, no per-case weight, and nothing to
--     tell a candidate which assertion failed.
--   * Overloading `stdin` makes the column name a lie for whoever reads it
--     next.
--
-- So: one test case is one assertion, and the assertion gets a column.
--
-- Expand-contract (invariant 15). Nullable, no backfill, no default, and no
-- existing row or code path changes: a `test_cases`-mode question leaves it
-- NULL and behaves exactly as before. The contract step — if there ever is
-- one — is a later migration once `unit_tests` questions exist.
--
-- No CHECK constraint, deliberately. The rule is "NOT NULL when this row's
-- question_version is in unit_tests mode", and `grading_mode` lives on
-- `question_versions`, not here; a CHECK cannot reach another table. It is
-- enforced at publish in packages/core-domain, where every other kind rule
-- already is, and refusing it at publish rather than at write is the same
-- choice made for every other `incomplete` rule (ADR-003 — publish is the
-- irreversible act, so publish is where completeness is owed).
--
-- Not candidate-reachable, and not by accident: the candidate payload
-- carries no test-case rows at all, only counts, so there is no shape for
-- this field to be added to (invariant 7).
-- ============================================================

-- `IF NOT EXISTS`, like every other statement in this directory. The runner's
-- contract is that a migration file can be replayed by hand against a database
-- that already has the shape -- which is exactly what the local stack produces,
-- because `infra/postgres/init` bootstraps the table shapes from the documented
-- DDL and `make migrate` then runs over the top of them. Without the guard,
-- `make up && make migrate` fails on a clean machine.
ALTER TABLE test_cases
    ADD COLUMN IF NOT EXISTS assertion_code text;

COMMENT ON COLUMN test_cases.assertion_code IS
    'Unit-test source for this case, exercising the candidate submission. '
    'Set only when the version''s grading_mode is unit_tests; NULL otherwise. '
    'Hidden-case content: never served to a candidate, never logged (ADR-024).';
