/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `pnpm run migrate` — apply every migration the database has not seen.
 *
 * Runs as the **object owner**, not the application role. The application role is
 * deliberately unable to create or alter tables (ADR-010): if it could, a SQL injection
 * in a request path would be a schema-rewrite primitive rather than a data read. That is
 * why `DATABASE_OWNER_URL` is a separate variable rather than `DATABASE_URL` with a
 * comment attached.
 *
 * Configuration is read through `@assaybank/config` rather than `process.env`, so a
 * malformed DSN fails here with the variable named, not later with a connection error
 * that says nothing about which value was wrong.
 *
 * Idempotent: a second run applies nothing and says so.
 */

import { loadMigrationTarget } from '@assaybank/config';

import { migrate } from './migrate.js';

try {
  // The narrow loader, not loadConfig(): a migration needs the owner DSN and must not be
  // made to carry the application's session secret or storage keys to get it.
  const { ownerUrl } = loadMigrationTarget();
  const result = await migrate({ url: ownerUrl });
  process.stdout.write(
    result.applied === 0
      ? `migrate: up to date, ${result.total} migration(s) already applied.\n`
      : `migrate: applied ${result.applied} migration(s), ${result.total} total.\n`,
  );
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`\nmigrate: failed — ${message}\n\n`);
  process.exit(1);
}
