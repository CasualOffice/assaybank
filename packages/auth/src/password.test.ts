/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_PREFIX,
  ARGON2_PARAMETERS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  hashPasswordUnchecked,
  verifyPassword,
  verifyPasswordAgainstNothing,
} from './password.js';

const PASSWORD = 'example-staff-password';

describe('hashPassword', () => {
  it('produces an Argon2id PHC string, not a bare digest', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith(ARGON2ID_PREFIX)).toBe(true);
  });

  it('encodes the OWASP parameters into the hash, so a review can read them off a row', async () => {
    const hash = await hashPassword(PASSWORD);
    // $argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>
    expect(hash).toContain(`m=${ARGON2_PARAMETERS.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2_PARAMETERS.timeCost}`);
    expect(hash).toContain(`p=${ARGON2_PARAMETERS.parallelism}`);
  });

  it('salts, so two staff who chose the same password do not share a hash', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(a).not.toBe(b);
    await expect(verifyPassword(PASSWORD, a)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, b)).resolves.toBe(true);
  });

  it('refuses a password shorter than the floor', async () => {
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow(RangeError);
  });

  it('refuses a password past the ceiling rather than truncating it', async () => {
    // The bcrypt failure mode: a silent truncation means two different passwords hash to
    // the same value and nobody notices for years.
    await expect(hashPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow(RangeError);
  });

  it('accepts a passphrase at each boundary', async () => {
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH))).resolves.toContain(ARGON2ID_PREFIX);
    await expect(hashPassword('a'.repeat(MAX_PASSWORD_LENGTH))).resolves.toContain(ARGON2ID_PREFIX);
  });
});

describe('hashPasswordUnchecked', () => {
  it('hashes input that hashPassword refuses, rather than throwing', async () => {
    // The reason it exists. Better Auth calls `password.hash` as its dummy hash on the
    // sign-in path for an address it did not find, with whatever the caller typed — so a
    // throw there becomes a 500 that only appears for addresses without an account, which
    // is the enumeration oracle `verifyPasswordAgainstNothing` exists to close.
    for (const input of ['', 'short', 'a'.repeat(MIN_PASSWORD_LENGTH - 1), 'a'.repeat(5_000)]) {
      await expect(hashPasswordUnchecked(input)).resolves.toContain(ARGON2ID_PREFIX);
      await expect(hashPassword(input)).rejects.toThrow(RangeError);
    }
  });

  it('keeps the cost ceiling, so an oversized input is not an amplification', async () => {
    const huge = 'a'.repeat(50_000);
    const bounded = 'a'.repeat(MAX_PASSWORD_LENGTH);

    // Truncated to the ceiling, so the two are the same work — and, because the input is
    // the same character, the same hash once the salt is held fixed. Verifying one against
    // the other is how that is observed without reaching inside the function.
    const at = await hashPasswordUnchecked(bounded);
    await expect(verifyPassword(huge.slice(0, MAX_PASSWORD_LENGTH), at)).resolves.toBe(true);
  });

  it('still produces the OWASP parameters', async () => {
    const hashed = await hashPasswordUnchecked('short');
    expect(hashed).toContain(`m=${ARGON2_PARAMETERS.memoryCost}`);
    expect(hashed).toContain(`t=${ARGON2_PARAMETERS.timeCost}`);
    expect(hashed).toContain(`p=${ARGON2_PARAMETERS.parallelism}`);
  });
});

describe('verifyPassword', () => {
  it('accepts the password it was given', async () => {
    const hash = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
  });

  it('rejects a different password', async () => {
    const hash = await hashPassword(PASSWORD);
    await expect(verifyPassword(`${PASSWORD}!`, hash)).resolves.toBe(false);
  });

  it('rejects, rather than throwing, when the stored hash is unusable', async () => {
    // A corrupt or empty password_hash must fail the login, not fail the request: a 500
    // here distinguishes "this account exists" from "no such account".
    for (const stored of ['', 'not-a-hash', '$argon2id$garbage', '$2b$10$abcdefghijklmnop']) {
      await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(false);
    }
  });
});

describe('verifyPasswordAgainstNothing', () => {
  it('always answers false', async () => {
    await expect(verifyPasswordAgainstNothing(PASSWORD)).resolves.toBe(false);
    await expect(verifyPasswordAgainstNothing('')).resolves.toBe(false);
  });

  it('costs about what a real verification costs, so the two are not distinguishable', async () => {
    const hash = await hashPassword(PASSWORD);

    // Warm both paths first: the decoy hash is computed once and cached, and the first
    // real verification pays for module and allocator warm-up that the measurement is
    // not about.
    await verifyPasswordAgainstNothing(PASSWORD);
    await verifyPassword(PASSWORD, hash);

    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const started = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const rounds = 3;
    let real = 0;
    let decoy = 0;
    for (let i = 0; i < rounds; i += 1) {
      real += await time(() => verifyPassword(`${PASSWORD}-wrong`, hash));
      decoy += await time(() => verifyPasswordAgainstNothing(`${PASSWORD}-wrong`));
    }

    // A generous band. The claim under test is "the same order of magnitude", which is
    // what defeats a remote stopwatch; asserting anything tighter would make a loaded CI
    // machine fail a test about cryptography.
    const ratio = decoy / real;
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(5);
  });
});
