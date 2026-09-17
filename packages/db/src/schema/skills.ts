/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 2 of docs/hiring_platform_schema.sql — the skill taxonomy.
 *
 * The join between job roles and questions. Questions are tagged with skills, never with
 * roles: tagging with roles means every new role is a re-tagging exercise across the
 * whole bank, and a bank that is expensive to re-tag stops being re-tagged.
 *
 * `org_id IS NULL` is the shared global taxonomy. Migration 0002's policy admits those
 * rows for reading and refuses them for writing, so no tenant can edit a row every other
 * tenant depends on.
 */

import { sql } from 'drizzle-orm';
import { pgTable, text, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

import { optionalOrgRef } from './tenancy-rbac.js';

export const skills = pgTable(
  'skills',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Null means the row belongs to the global taxonomy rather than to one tenant. */
    orgId: optionalOrgRef(),
    /** Self-referential: `sql.window-functions` hangs under `sql`. */
    parentId: uuid('parent_id').references((): AnyPgColumn => skills.id, {
      onDelete: 'set null',
    }),
    /** `python`, `sql.window-functions`, `system-design`. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** `language` | `framework` | `cs-fundamentals` | `cloud`. */
    category: text('category'),
  },
  (t) => [
    unique('skills_org_id_key_key').on(t.orgId, t.key),
    // The constraint above does not constrain the global rows: NULLs are distinct for
    // uniqueness, so (NULL, 'python') could be inserted twice (migration 0011).
    uniqueIndex('skills_global_key_key')
      .on(t.key)
      .where(sql`org_id IS NULL`),
  ],
);
