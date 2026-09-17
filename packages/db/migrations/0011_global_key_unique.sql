-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0011_global_key_unique — a global key means one row, not several.
--
-- `skills` and `user_roles` carry a nullable org_id where NULL means "shared
-- by every tenant", and each has UNIQUE (org_id, key). That constraint does
-- not constrain the global rows at all: PostgreSQL treats NULLs as distinct
-- for uniqueness, so (NULL, 'python') may be inserted any number of times.
-- Verified against postgres:16-alpine before this file was written — two
-- identical global rows were accepted.
--
-- What that costs, left alone:
--
--   * Two global skills keyed `python`. Skills cross organisation boundaries
--     by key on import, so the importer's key-to-id lookup would resolve to
--     whichever row it happened to read, and a role's coverage report would
--     count questions tagged against the other one as missing.
--   * Two global system roles keyed `admin`, which makes "what may this user
--     do" depend on which row a join reached.
--
-- The fix is a partial unique index over the rows the constraint misses. It
-- also gives the seed an arbiter to write against, so `make seed` twice is a
-- no-op rather than a second copy of the taxonomy.
--
-- `NULLS NOT DISTINCT` on the original constraint would express the same
-- thing more directly, but it rewrites an existing constraint on a table
-- every tenant reads; an additive index is the expand-only move and leaves
-- the per-tenant uniqueness exactly as it was.
--
-- Creating either index fails if duplicates already exist. That is the right
-- failure: it means the data has to be reconciled by a person who knows which
-- row is the real one, and no migration can make that choice.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS skills_global_key_key
    ON skills (key)
    WHERE org_id IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_global_key_key
    ON user_roles (key)
    WHERE org_id IS NULL;
