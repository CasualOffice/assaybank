-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================
-- 0008_global_rows_read_only — a tenant reads global rows and writes none.
--
-- `skills` and `user_roles` carry a nullable org_id, where NULL means a row
-- shared by every tenant: the global taxonomy and the system role catalogue.
-- 0002 gave each a single policy for every command:
--
--     USING      (org_id IS NULL OR org_id = app_current_org())
--     WITH CHECK (org_id = app_current_org())
--
-- Its comment says no tenant can "create, edit or claim a global row". Two of
-- the three were not true:
--
--   * DELETE is filtered by USING only, and USING admits global rows. A tenant
--     could delete a global skill; the ON DELETE CASCADE on question_skills and
--     job_role_skills then removed that skill from every organisation's
--     questions and roles, and foreign-key cascades do not consult RLS.
--   * UPDATE checks the *new* row against WITH CHECK. `SET org_id = <own org>`
--     on a global row passes it, so a tenant could claim a shared row and take
--     it away from every other tenant.
--
-- Creating a global row was, and remains, refused by WITH CHECK.
--
-- The fix splits the one policy into a read policy that admits global rows and
-- write policies that do not. Permissive policies for the same command are
-- OR-ed, so the write commands get exactly one policy each and never inherit
-- the read policy's `org_id IS NULL`.
--
-- Found by the global-row cases added to packages/db/tests/rls.test.ts, which
-- failed against 0002 and pass against this file.
--
-- Expand-contract: a policy replacement changes no data and no shape. It
-- narrows what the application role may write, and nothing in the application
-- writes a global row — seeding them is an owner-level operation. Idempotent:
-- every policy is dropped if present before it is created.
-- ============================================================

DROP POLICY IF EXISTS org_isolation ON skills;
--> statement-breakpoint
DROP POLICY IF EXISTS org_read ON skills;
--> statement-breakpoint
CREATE POLICY org_read ON skills FOR SELECT
    USING (org_id IS NULL OR org_id = public.app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS org_insert ON skills;
--> statement-breakpoint
CREATE POLICY org_insert ON skills FOR INSERT
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS org_update ON skills;
--> statement-breakpoint
CREATE POLICY org_update ON skills FOR UPDATE
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS org_delete ON skills;
--> statement-breakpoint
CREATE POLICY org_delete ON skills FOR DELETE
    USING (org_id = public.app_current_org());
--> statement-breakpoint

DROP POLICY IF EXISTS org_isolation ON user_roles;
--> statement-breakpoint
DROP POLICY IF EXISTS org_read ON user_roles;
--> statement-breakpoint
CREATE POLICY org_read ON user_roles FOR SELECT
    USING (org_id IS NULL OR org_id = public.app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS org_insert ON user_roles;
--> statement-breakpoint
CREATE POLICY org_insert ON user_roles FOR INSERT
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS org_update ON user_roles;
--> statement-breakpoint
CREATE POLICY org_update ON user_roles FOR UPDATE
    USING (org_id = public.app_current_org())
    WITH CHECK (org_id = public.app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS org_delete ON user_roles;
--> statement-breakpoint
CREATE POLICY org_delete ON user_roles FOR DELETE
    USING (org_id = public.app_current_org());
