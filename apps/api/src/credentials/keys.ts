/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One configured secret, three signing keys that cannot be substituted for each other.
 *
 * `packages/auth` says, in the header of `ws-ticket.ts`, that the attempt token and the
 * WebSocket ticket are "different secrets for different surfaces; a ticket leaked from a
 * URL must not be an attempt credential, and a stolen attempt token must not open a
 * socket". The environment (docs/13 §4.9) offers `SESSION_SECRET` and `TOKEN_PEPPER` and
 * nothing else, and adding a third variable for every credential this system grows is how
 * a deployment ends up with one of them unset, or with the same value pasted into all of
 * them.
 *
 * So the keys are *derived* rather than configured: each one is an HMAC of a purpose
 * label under `SESSION_SECRET`. Three properties follow, and all three are asserted in
 * `keys.test.ts`:
 *
 * - **Distinct.** Two purposes never produce the same key, so a signature minted for one
 *   surface cannot verify on another even if the envelope prefix check were removed.
 * - **Irreversible.** A key is a one-way function of the root secret, so the compromise
 *   of a derived key does not hand over `SESSION_SECRET` — and therefore does not hand
 *   over the other surfaces with it.
 * - **Deterministic.** The same root secret always produces the same keys, so a token
 *   minted by one API replica verifies on another, and a rolling deploy does not log
 *   every candidate out.
 *
 * Note what is *not* derived here: `TOKEN_PEPPER` stays exactly as configured. It
 * participates in a one-way function over data at rest (docs/13 §"TOKEN_PEPPER"), so
 * deriving it from another secret would tie the fate of every stored invitation hash to
 * `SESSION_SECRET` — and rotating a signing key is routine while rotating that pepper is
 * a cohort-wide outage.
 */

import { createHmac } from 'node:crypto';

import type { SecretsConfig } from '@assaybank/config';

/**
 * Domain separation for the derivation itself, distinct from the domains
 * `packages/auth` uses for the credentials. A label is only a label; the constant is
 * what stops a key derived here from colliding with a digest computed elsewhere under
 * the same secret.
 */
const DERIVATION_DOMAIN = 'assaybank.api.credential-key.v1';

/** The surfaces that get their own signing key. Adding one adds a key, not a variable. */
export const CREDENTIAL_PURPOSES = ['attempt-token', 'ws-ticket'] as const;

/** One of {@link CREDENTIAL_PURPOSES}. */
export type CredentialPurpose = (typeof CREDENTIAL_PURPOSES)[number];

/** The keys the candidate credential flow signs and hashes with. */
export interface CredentialKeys {
  /** Signs and verifies attempt tokens (`Authorization: Bearer …`). */
  readonly attemptToken: string;
  /** Signs and verifies WebSocket tickets (`?ticket=…`). */
  readonly wsTicket: string;
  /**
   * `TOKEN_PEPPER`, verbatim. Keys the at-rest hash of invitation tokens and the
   * replay key of a redeemed ticket. Never derived — see the module comment.
   */
  readonly pepper: string;
}

/** Derives one purpose-bound key. Exported for the test that asserts the properties. */
export function deriveCredentialKey(rootSecret: string, purpose: CredentialPurpose): string {
  return createHmac('sha256', rootSecret)
    .update(`${DERIVATION_DOMAIN}.${purpose}`, 'utf8')
    .digest('hex');
}

/**
 * Derives every credential key from the parsed configuration.
 *
 * Takes the narrowed `SecretsConfig` rather than the whole `AppConfig` so this module
 * cannot name a database URL, and so `deriveCredentialKeys(config.secrets)` is the whole
 * call at the composition root.
 */
export function deriveCredentialKeys(
  secrets: Pick<SecretsConfig, 'sessionSecret' | 'tokenPepper'>,
): CredentialKeys {
  return Object.freeze({
    attemptToken: deriveCredentialKey(secrets.sessionSecret, 'attempt-token'),
    wsTicket: deriveCredentialKey(secrets.sessionSecret, 'ws-ticket'),
    pepper: secrets.tokenPepper,
  });
}
