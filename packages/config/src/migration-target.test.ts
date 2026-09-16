/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { ConfigError } from './errors.js';
import { loadMigrationTarget } from './load.js';

const OWNER = 'postgres://hiring_owner:example-fixture-owner@db.internal:5432/hiring';

describe('loadMigrationTarget', () => {
  it('needs only the owner DSN — not the session secret, pepper or storage keys', () => {
    // The whole reason this loader exists. loadConfig() over this environment reports
    // seven missing variables; a migration job must not be made to hold any of them.
    expect(loadMigrationTarget({ DATABASE_OWNER_URL: OWNER })).toEqual({ ownerUrl: OWNER });
  });

  it('refuses a missing owner DSN, naming the variable', () => {
    const error = captured(() => loadMigrationTarget({}));
    expect(error.variable).toBe('DATABASE_OWNER_URL');
  });

  it('does not fall back to DATABASE_URL, which is the application role', () => {
    // Falling back would turn a missing variable into a permission error half way
    // through applying DDL, because the application role cannot alter the schema.
    const error = captured(() =>
      loadMigrationTarget({ DATABASE_URL: 'postgres://hiring_app:hiring_app@db:5432/hiring' }),
    );
    expect(error.variable).toBe('DATABASE_OWNER_URL');
  });

  it('refuses a non-postgres URL without echoing the value, which is a credential', () => {
    const leaked = 'mysql://root:example-fixture-secret@db/hiring';
    const error = captured(() => loadMigrationTarget({ DATABASE_OWNER_URL: leaked }));
    expect(error.variable).toBe('DATABASE_OWNER_URL');
    expect(error.message).not.toContain('example-fixture-secret');
  });

  it('treats an empty value as unset', () => {
    expect(captured(() => loadMigrationTarget({ DATABASE_OWNER_URL: '   ' })).variable).toBe(
      'DATABASE_OWNER_URL',
    );
  });
});

function captured(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}
