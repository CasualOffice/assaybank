-- ============================================================
-- 02-schema.sql — loader, not a schema.
--
-- THE AUTHORITATIVE SCHEMA IS docs/hiring_platform_schema.sql.
--
-- There is deliberately no second copy of the DDL in this directory. A copy
-- would drift, and the first symptom of drift in a hiring platform is a score
-- that cannot be reproduced. docker-compose.yml mounts the documented schema
-- read-only at the path below:
--
--     ./docs/hiring_platform_schema.sql
--         -> /opt/hiring/schema/hiring_platform_schema.sql   (ro)
--
-- so the database a developer runs against is built from the same bytes the
-- documentation describes. Changing the schema means changing that file.
--
-- ORDER OF OPERATIONS
--   00-extensions.sql   pgcrypto, pg_trgm, citext          (must precede this)
--   01-roles.sql        roles + default privileges          (must precede this)
--   02-schema.sql       loads the authoritative schema      <- you are here
--   03-rls.sql          ENABLE RLS + org_isolation policies (must follow this)
--   04-partitions.sql   monthly event partitions            (must follow this)
--
-- LIFESPAN
-- This loader is a development convenience and a documentation-accuracy
-- device. From M0 (2026-09-21 → 2026-10-09) packages/db owns the schema as
-- versioned Drizzle migrations, generated from and checked against this file.
-- At that point `docker compose up` still initialises from here for a fast
-- clean start, and CI asserts that the migration chain and this file produce
-- an identical `pg_dump --schema-only`. The day that assertion cannot be made
-- to pass is the day this loader is deleted and migrations become the only
-- path. TBD — owner: backend lead, decide by 2026-10-09 (M0 exit).
-- ============================================================

\echo 'Loading authoritative schema from /opt/hiring/schema/hiring_platform_schema.sql'

-- Stop on the first error rather than leaving a half-built database that
-- looks like it started correctly.
\set ON_ERROR_STOP on

\i /opt/hiring/schema/hiring_platform_schema.sql

\echo 'Authoritative schema loaded.'
