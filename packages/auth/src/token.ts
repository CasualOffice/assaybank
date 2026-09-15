/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opaque bearer secrets: invitation tokens today, anything else handed to a human later.
 *
 * The rules are docs/17 §7 and docs/14-threat-model.md `H-120`, and they are all
 * expressed in this file rather than at the call sites:
 *
 * - **High entropy.** 256 bits from the CSPRNG, because the only defence against
 *   `POST /candidate/redeem` being scripted against generated tokens is that the space
 *   cannot be walked. Rate limiting narrows the attack; entropy is what ends it.
 * - **Hashed at rest.** The database stores {@link hashToken}'s output, never the
 *   plaintext. A dump of `invitations` is then not a set of live credentials.
 * - **Peppered.** The hash is keyed with `TOKEN_PEPPER`, which lives in the process
 *   environment and not in the database, so stolen rows cannot be attacked offline
 *   without also stealing the application secret.
 * - **Returned exactly once.** That is the caller's discipline, but this module makes it
 *   possible: {@link generateToken} is the only place the plaintext exists, and nothing
 *   here can recover it from a hash.
 *
 * A single fast HMAC is the right primitive here and a password KDF is not: the input is
 * 256 random bits, so there is no dictionary to run and nothing for a slow hash to buy.
 */

import { randomBytes } from 'node:crypto';

import { constantTimeEquals, hmacHex } from './crypto.js';

/** Bytes of CSPRNG output behind every token. 32 bytes is 256 bits (`H-120`). */
export const TOKEN_BYTES = 32;

/**
 * The hash format version, carried as a prefix.
 *
 * Rotating `TOKEN_PEPPER` or moving off HMAC-SHA-256 means stored hashes in two formats
 * at once for the length of the overlap window. A version tag makes that a migration
 * rather than a flag day; without one, the only way to tell the formats apart is to
 * guess from the length.
 */
export const TOKEN_HASH_VERSION = 'v1';

/**
 * Domain separation. Every HMAC in this package covers a constant naming what is being
 * signed, so a digest minted for one purpose can never be replayed as another even if
 * the same key is configured in two places by mistake.
 */
const TOKEN_HASH_DOMAIN = 'assaybank.token.v1';

/** The separator between the domain and the payload: a byte no token plaintext contains. */
const SEPARATOR = '\u001f';

/**
 * The at-rest form of `plaintext`: `v1$<64 hex characters>`.
 *
 * Deterministic — the same plaintext and pepper always produce the same string — which
 * is what lets the schema put a `UNIQUE` constraint on `invitations.token_hash` and what
 * lets redemption be a single indexed lookup rather than a scan comparing every row.
 *
 * Fixed length, so two hashes of this version are always {@link constantTimeEquals}-
 * comparable without the length itself carrying information.
 */
export function hashToken(plaintext: string, pepper: string): string {
  return `${TOKEN_HASH_VERSION}$${hmacHex(pepper, `${TOKEN_HASH_DOMAIN}${SEPARATOR}${plaintext}`)}`;
}

/**
 * Mints a new token: the plaintext to hand over exactly once, and the hash to store.
 *
 * `pepper` is optional only so that the call form in the P0 plan — `generateToken()` —
 * compiles. **Always pass `config.secrets.tokenPepper`.** An unpeppered hash is still a
 * hash, so nothing silently weakens into a plaintext store, but it is a hash an attacker
 * holding a database dump can attack without also holding the application secret, and it
 * will not verify against the peppered form.
 */
export function generateToken(pepper = ''): { plaintext: string; hash: string } {
  // base64url so the token survives a URL, an email client and a copy-paste intact.
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url');
  return { plaintext, hash: hashToken(plaintext, pepper) };
}

/**
 * True when `plaintext` is the token behind `hash`.
 *
 * Timing-safe: the presented plaintext is hashed and the two digests are compared with
 * `node:crypto`'s `timingSafeEqual`, which does not stop at the first differing byte. A
 * comparison that stopped early would let an attacker who can submit candidate hashes
 * recover a stored digest one byte at a time.
 */
export function verifyToken(plaintext: string, hash: string, pepper: string): boolean {
  return constantTimeEquals(hashToken(plaintext, pepper), hash);
}
