/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Staff passwords: Argon2id, and the reasons it is Argon2id and not the alternatives.
 *
 * **Why a password KDF at all, when `token.ts` deliberately uses a single fast HMAC.**
 * The two inputs are nothing alike. A token is 256 bits of CSPRNG output, so there is no
 * dictionary to run against it and a slow hash buys nothing. A password is whatever a
 * recruiter typed, drawn from a distribution an attacker holding a database dump knows
 * better than we do. Against that input the *only* defence is making each guess cost
 * something, which is exactly what a memory-hard KDF sells.
 *
 * **Why Argon2id specifically, and not Better Auth's default.** Better Auth hashes with
 * scrypt out of the box, and scrypt is a perfectly respectable choice — this is not a
 * correction of a mistake. It is a deliberate move to the algorithm OWASP names first
 * (Password Storage Cheat Sheet) and the winner of the Password Hashing Competition.
 * Argon2id is the hybrid variant: the `i` half resists side-channel leakage of the
 * password through cache timing, the `d` half resists GPU and ASIC attackers, and the
 * combination is what makes it the default recommendation rather than either pure form.
 * The parameters below are OWASP's published minimum, which is the number to quote in a
 * security review rather than one somebody picked.
 *
 * bcrypt is not used, at any cost factor. Beyond the well-known 72-byte input truncation,
 * bcrypt's memory footprint is fixed and tiny, so its cost to a GPU farm falls with every
 * hardware generation while ours stays constant — which is the property a memory-hard
 * function exists to remove.
 *
 * **What this module is not.** It does not decide *whether* a login succeeds; that is the
 * whole point of {@link verifyPassword} returning a boolean and of
 * {@link verifyPasswordAgainstNothing} existing. It stores nothing, reads no
 * configuration, and knows nothing about organisations.
 */

import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id`, spelled as its value.
 *
 * `@node-rs/argon2` declares `Algorithm` as an *ambient const enum*, which
 * `verbatimModuleSyntax` forbids reading at a call site — the compiler would have to
 * inline a value it is not allowed to assume survives to runtime. The number is part of
 * the Argon2 specification (0 = Argon2d, 1 = Argon2i, 2 = Argon2id) rather than a detail
 * of this binding, and `password.test.ts` asserts that what comes out actually says
 * `$argon2id$`, so a wrong constant fails a test rather than silently downgrading every
 * staff password to Argon2d.
 */
const ARGON2ID: Algorithm = 2;

/**
 * OWASP's published minimum for Argon2id: 19 MiB of memory, two iterations, one lane.
 *
 * Frozen and exported so a review can read the numbers without reading the call, and so
 * `password.test.ts` can assert that the encoded hash actually carries them — a
 * configuration object that is passed to the wrong function is a configuration object
 * that silently does nothing.
 *
 * These are a floor, not a target. Raising them is a one-line change and old hashes keep
 * verifying, because the parameters are encoded in the hash string itself.
 */
export const ARGON2_PARAMETERS = Object.freeze({
  algorithm: ARGON2ID,
  /** KiB. 19456 KiB = 19 MiB. */
  memoryCost: 19_456,
  /** Iterations. */
  timeCost: 2,
  /** Lanes. One, because the API process is already concurrent at the request level. */
  parallelism: 1,
});

/**
 * The shortest password this system will hash.
 *
 * Long enough to matter, short enough not to push people towards a sticky note. Length is
 * the only composition rule enforced anywhere in this codebase: character-class rules
 * measurably push users towards `Password1!` and are no longer recommended by NIST
 * (SP 800-63B), which is why there is no regular expression in this file.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * The longest password this system will hash.
 *
 * A bound exists because Argon2's cost is linear in input length past the block size, so
 * an unbounded password field is an unauthenticated request that can be made arbitrarily
 * expensive — a denial of service wearing a login form. 128 characters is far beyond any
 * legitimate passphrase.
 */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * The prefix every Argon2id hash produced here carries. Exported so a caller can tell an
 * Argon2id hash from whatever a future migration introduces without parsing the rest.
 */
export const ARGON2ID_PREFIX = '$argon2id$';

/**
 * Hashes `password` for storage.
 *
 * The result is the standard PHC string — algorithm, version, parameters and a random
 * salt, all inside the one value — so nothing else has to be stored alongside it and a
 * parameter change does not invalidate existing rows.
 *
 * @throws {RangeError} if the password is outside {@link MIN_PASSWORD_LENGTH} …
 * {@link MAX_PASSWORD_LENGTH}. Deliberately a throw rather than a silent truncation:
 * bcrypt's quiet truncation at 72 bytes is the canonical example of a length rule that
 * nobody noticed until it was a vulnerability.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new RangeError(
      `A password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} ` +
        'characters. The bound is enforced here rather than at the form, because the ' +
        'upper bound is a cost ceiling on an unauthenticated request and not a UI rule.',
    );
  }
  return hash(password, ARGON2_PARAMETERS);
}

/**
 * Hashes without the length policy, for the one call site where the result is thrown
 * away.
 *
 * Better Auth reaches for `password.hash` in two unrelated situations. The first is
 * *setting* a password — sign-up, update-user, reset, admin set-password — and every one
 * of those routes checks `minPasswordLength`/`maxPasswordLength` before it calls the
 * hasher, so {@link hashPassword} is what runs there and its `RangeError` is unreachable.
 * The second is the **dummy hash on sign-in**: an address with no row, or a row with no
 * credential account, is answered by hashing whatever arrived and discarding it, so that
 * the not-found path costs what the wrong-password path costs.
 *
 * That second call receives an unauthenticated caller's raw input. Handing it to
 * {@link hashPassword} makes a four-character password throw, the throw becomes a `500`,
 * and the `500` distinguishes "no such account" from "wrong password" — reconstructing,
 * out of an exception, exactly the oracle docs/14 `H-118` and
 * {@link verifyPasswordAgainstNothing} exist to close. So the decoy path does not enforce
 * the policy; it only burns the work.
 *
 * Truncation at {@link MAX_PASSWORD_LENGTH} keeps the cost ceiling. It is safe here and
 * would not be in {@link hashPassword}, and the difference is the whole reason these are
 * two functions: nothing is stored, nothing is compared, and the return value is dropped
 * by the caller. There is no later verification for a truncated input to silently match.
 */
export async function hashPasswordUnchecked(password: string): Promise<string> {
  return hash(password.slice(0, MAX_PASSWORD_LENGTH), ARGON2_PARAMETERS);
}

/**
 * True when `password` is the one behind `storedHash`.
 *
 * Never throws for a malformed or unrecognised hash: a row whose `password_hash` is
 * corrupt, empty, or in some format this build does not understand must fail the login,
 * not fail the request. A 500 there would be an oracle — it distinguishes "this account
 * exists and its stored hash is odd" from "no such account" — and it would page somebody
 * at 03:00 for what is, from the caller's side, simply a wrong password.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_PARAMETERS);
  } catch {
    return false;
  }
}

/**
 * A hash of a value nobody knows, computed once, to be verified against when there is no
 * real hash to verify against.
 *
 * Computed lazily and cached: the cost is one Argon2id hash for the lifetime of the
 * process, and doing it at module load would put 19 MiB and a few tens of milliseconds
 * into the startup path of every service that imports this package, including the ones
 * that never see a password.
 */
let decoyHash: Promise<string> | undefined;

/**
 * Burns the same work a real verification would, and returns `false`.
 *
 * docs/14 `H-118` requires that a failed login not reveal whether the email exists. The
 * response body and status handle the obvious half of that; this handles the half a
 * stopwatch can see. Without it the two paths are trivially distinguishable — "no such
 * user" returns in a millisecond and "wrong password" returns in fifty — and an attacker
 * with a list of addresses learns which of a customer's staff have accounts, which is the
 * first step of a phishing campaign aimed at exactly the right people.
 *
 * It is a decoy verification rather than a sleep because a sleep has to guess the right
 * duration and guesses wrong as soon as the Argon2 parameters change, while this is the
 * same function doing the same work under the same parameters, by construction.
 */
export async function verifyPasswordAgainstNothing(password: string): Promise<false> {
  decoyHash ??= hash(
    // Not a secret, and not required to be one: an attacker who knows this string still
    // cannot use it, because nothing accepts it as a credential. Its only job is to be a
    // syntactically valid Argon2id hash with our parameters.
    'assaybank.decoy.password.never-a-credential',
    ARGON2_PARAMETERS,
  );
  await verifyPassword(password, await decoyHash);
  return false;
}
