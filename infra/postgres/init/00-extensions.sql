-- ============================================================
-- 00-extensions.sql
--
-- Runs first, before the authoritative schema is loaded by 02-schema.sql.
-- Extensions must exist before any DDL that references their types.
--
-- These scripts execute exactly once, on an empty data directory, in
-- filename order. A re-run means `docker compose down -v` first. Every
-- statement here is therefore written to be idempotent anyway, so that the
-- same file can be replayed by hand against a database that already exists.
-- ============================================================

-- gen_random_uuid() for every primary key in the schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigram indexes for fuzzy search over question prompts. The schema builds
-- a GIN index with gin_trgm_ops on question_versions.prompt_md.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Case-insensitive text.
--
-- docs/hiring_platform_schema.sql declares citext in its own header alongside
-- pgcrypto and pg_trgm, so it loads standalone. This line is kept because
-- CREATE EXTENSION IF NOT EXISTS is idempotent and the loader should not
-- depend on the order in which the schema happens to declare things.
--
-- TBD — owner: backend lead, decide by 2026-11-13 (M0 exit): fold this into
-- the Drizzle migration in packages/db so the extension set is versioned
-- alongside the tables rather than living in a container init script.
CREATE EXTENSION IF NOT EXISTS citext;
