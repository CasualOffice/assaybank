/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `pnpm run seed` — the permission catalogue, the system roles and the starter taxonomy.
 *
 * Runs as the **object owner** for the same reason `migrate` does: these are global rows, and
 * migration 0002 deliberately leaves the application role unable to write one. An application
 * role that could seed a permission could grant itself one.
 *
 * Idempotent. Run it after `migrate`, and again after any deploy that adds a permission.
 */

import { loadMigrationTarget } from '@assaybank/config';

import { seed } from './seed.js';

try {
  const { ownerUrl } = loadMigrationTarget();
  const result = await seed({ url: ownerUrl });
  const total = result.permissions + result.roles + result.rolePermissions + result.skills;
  process.stdout.write(
    total === 0
      ? 'seed: up to date, nothing to write.\n'
      : `seed: wrote ${result.permissions} permission(s), ${result.roles} role(s), ` +
          `${result.rolePermissions} grant(s), ${result.skills} skill(s).\n`,
  );
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`\nseed: failed — ${message}\n\n`);
  process.exit(1);
}
