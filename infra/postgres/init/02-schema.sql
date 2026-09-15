-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 02-schema.sql — a development bootstrap. NOT the source of truth.
--
-- THE AUTHORITATIVE SCHEMA IS packages/db/migrations/.
--
-- This changed in P0 step 6 (project/P0-FOUNDATION-PLAN.md). Until then, the
-- schema was docs/hiring_platform_schema.sql, mounted into this container and
-- loaded verbatim by this file. From P0 step 6 the schema is versioned Drizzle
-- migrations owned by packages/db:
--
--   packages/db/migrations/0001_initial.sql
--       extensions, all 40 tables, constraints, indexes, the ADR-003
--       immutability trigger on question_versions, and the permission seed
--   packages/db/migrations/0002_rls.sql
--       the two application roles, grants, ENABLE ROW LEVEL SECURITY and the
--       org_isolation policies, with a completeness check that fails if a
--       table was added and nobody decided about its tenancy
--
-- docs/hiring_platform_schema.sql is now the **documentation** of that model
-- rather than its origin. It is still the version worth reading, because it is
-- the one with the prose in it. It is no longer what defines a database, and
-- editing it changes nothing that runs.
--
-- WHY THIS FILE STILL LOADS ANYTHING AT ALL
--
-- Only because 03-rls.sql and 04-partitions.sql run after it and address the
-- tables by name: an empty schema at this point aborts container start. The
-- migrations directory is not mounted into this container, so this file cannot
-- apply the real thing. It therefore bootstraps the *table shapes* from the
-- documented DDL, which is byte-for-byte the model migration 0001 creates —
-- packages/db/src/schema/schema.test.ts and the generated-versus-handwritten
-- comparison in packages/db keep the two in step.
--
--   >>> A database built by this file alone is INCOMPLETE. <<<
--
-- It has the tables but not the ADR-003 trigger, and the policies it gets come
-- from 03-rls.sql rather than from the migration. Run
--
--     make migrate
--
-- after `make up`. The migrations are guarded and idempotent, so applying them
-- over a bootstrapped database adds what is missing and touches nothing else.
-- That is the supported path, and it is the only one that produces the schema
-- CI tests against.
--
-- HOW THIS FILE DISAPPEARS
--
-- TBD — owner: backend lead, decide by 2026-10-09 (M0 exit): mount
-- ./packages/db/migrations into the container (or drop the schema out of
-- container init entirely and make `make up` run `make migrate`), then reduce
-- 00-extensions.sql, 01-roles.sql and 03-rls.sql to the superuser-only
-- prerequisites a non-superuser migration cannot create for itself — CREATE
-- ROLE with a password, and BYPASSRLS — and delete this file. At that point
-- there is exactly one definition of every table and every policy instead of
-- two that have to agree.
--
-- ORDER OF OPERATIONS IN THIS DIRECTORY
--   00-extensions.sql   pgcrypto, pg_trgm, citext   (also in migration 0001)
--   01-roles.sql        roles + default privileges  (also in migration 0002)
--   02-schema.sql       table bootstrap             <- you are here
--   03-rls.sql          policies                    (also in migration 0002)
--   04-partitions.sql   monthly event partitions    (init-only, for now)
--
-- The overlap with the migrations is deliberate and safe in both directions:
-- every statement on both sides is written IF NOT EXISTS or guarded, so
-- whichever runs first wins and the second is a no-op.
-- ============================================================

\set ON_ERROR_STOP on

\echo '============================================================'
\echo '02-schema.sql: bootstrapping table shapes for container init.'
\echo 'The authoritative schema is packages/db/migrations.'
\echo 'Run `make migrate` after the stack is up — a database built by'
\echo 'this file alone is missing the ADR-003 immutability trigger.'
\echo '============================================================'

-- Guarded, so this file can also be replayed by hand against a database that
-- migrations have already built without trying to create everything twice.
SELECT to_regclass('public.organizations') IS NULL AS needs_bootstrap \gset

\if :needs_bootstrap
    \echo 'Empty database: loading table shapes from the documented DDL.'
    \i /opt/hiring/schema/hiring_platform_schema.sql
    \echo 'Bootstrap complete. NOT YET MIGRATED — run `make migrate`.'
\else
    \echo 'Schema already present (migrations have run). Nothing to bootstrap.'
\endif
