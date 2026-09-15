/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { TOKEN_BYTES, TOKEN_HASH_VERSION, generateToken, hashToken, verifyToken } from './token.js';

const PEPPER = 'a-local-development-token-pepper';
const OTHER_PEPPER = 'a-different-deployments-token-pepper';

describe('generateToken', () => {
  it('produces 256 bits of entropy, which is what makes redemption unguessable', () => {
    const { plaintext } = generateToken(PEPPER);

    // base64url of 32 bytes, unpadded: ceil(32 * 4 / 3) = 43 characters.
    expect(plaintext).toHaveLength(43);
    expect(Buffer.from(plaintext, 'base64url')).toHaveLength(TOKEN_BYTES);
  });

  it('is URL and email safe, so the plaintext survives being mailed to a candidate', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateToken(PEPPER).plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never repeats itself', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateToken(PEPPER).plaintext);
    }

    expect(seen.size).toBe(1000);
  });

  it('returns a hash that verifies against the plaintext it was minted with', () => {
    const { plaintext, hash } = generateToken(PEPPER);

    expect(verifyToken(plaintext, hash, PEPPER)).toBe(true);
  });

  it('returns the hash, not the plaintext — a dump of hashes is not a set of credentials', () => {
    const { plaintext, hash } = generateToken(PEPPER);

    expect(hash).not.toContain(plaintext);
    expect(hash.startsWith(`${TOKEN_HASH_VERSION}$`)).toBe(true);
  });
});

describe('hashToken', () => {
  it('is deterministic, so the stored hash can be a unique indexed lookup', () => {
    expect(hashToken('some-token', PEPPER)).toBe(hashToken('some-token', PEPPER));
  });

  it('is fixed length regardless of the plaintext, so the digest leaks nothing about it', () => {
    const short = hashToken('a', PEPPER);
    const long = hashToken('a'.repeat(10_000), PEPPER);

    expect(short).toHaveLength(long.length);
    // "v1$" plus 64 hex characters of SHA-256.
    expect(short).toMatch(/^v1\$[0-9a-f]{64}$/);
  });

  it('is keyed by the pepper, so stolen rows cannot be attacked without the app secret', () => {
    expect(hashToken('some-token', PEPPER)).not.toBe(hashToken('some-token', OTHER_PEPPER));
  });

  it('gives two different plaintexts two different digests', () => {
    expect(hashToken('token-a', PEPPER)).not.toBe(hashToken('token-b', PEPPER));
    // Including the case where one is a prefix of the other, which is where a
    // length-extendable construction would be at risk of confusing them.
    expect(hashToken('token', PEPPER)).not.toBe(hashToken('token-with-more', PEPPER));
  });
});

describe('verifyToken', () => {
  it('accepts the plaintext behind the hash', () => {
    const hash = hashToken('correct-token', PEPPER);

    expect(verifyToken('correct-token', hash, PEPPER)).toBe(true);
  });

  it('rejects a different plaintext', () => {
    const hash = hashToken('correct-token', PEPPER);

    expect(verifyToken('incorrect-token', hash, PEPPER)).toBe(false);
  });

  it('rejects the right plaintext under the wrong pepper', () => {
    const hash = hashToken('correct-token', PEPPER);

    expect(verifyToken('correct-token', hash, OTHER_PEPPER)).toBe(false);
  });

  it('rejects an empty or truncated hash instead of throwing', () => {
    const hash = hashToken('correct-token', PEPPER);

    expect(verifyToken('correct-token', '', PEPPER)).toBe(false);
    expect(verifyToken('correct-token', hash.slice(0, -1), PEPPER)).toBe(false);
    expect(verifyToken('', hash, PEPPER)).toBe(false);
  });

  it('rejects a hash of the right shape from a different token', () => {
    const decoy = hashToken('a-different-token', PEPPER);

    expect(verifyToken('correct-token', decoy, PEPPER)).toBe(false);
  });
});
