/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The second deny-list of the standing leak suite: field names that belong to the staff
 * surface and must never appear in a response served to a candidate.
 *
 * `forbidden-fields.ts` guards the *content* half of FR-12 — answer keys, hidden test
 * cases, reference solutions. This file guards the *audience* half, which is docs/17 §3's
 * rule about serialisers: *"Candidate-facing and staff-facing serialisers for the same
 * entity are different types, not the same type with a flag."* The failure it catches is
 * not a leaked answer; it is a handler that returned the row, or the principal, or the
 * staff view of an entity, to the one caller who has no account at all.
 *
 * Each name is here because a real staff payload carries it:
 *
 * | name | why a candidate must not see it |
 * |---|---|
 * | `permissions`, `roles` | the authorisation model, and evidence that a staff surface exists |
 * | `user`, `user_id`, `created_by` | staff identities, none of which a candidate is party to |
 * | `email`, `full_name`, `phone` | another person's contact details (docs/11) |
 * | `org`, `org_id`, `organization` | the tenant key; a candidate never needs it and it is the thing ADR-010 exists to contain |
 * | `candidate_id`, `candidates` | other candidates — FR-12's third clause |
 * | `token_hash`, `password`, `secret` | stored credentials, at any depth, ever |
 * | `pass_score_pct`, `proctoring_profile`, `integrity_flag` | staff configuration and staff conclusions about the person reading the response (ADR-007) |
 * | `max_attempts`, `invitation_id`, `application_id` | the invitation's staff-side bookkeeping |
 * | `audit_log`, `before`, `after` | the audit record, which is a staff artefact |
 * | `settings`, `org_settings`, `proctoring_defaults` | an organisation's own configuration — `GET /org/settings` (docs/03 §13), added in P1 step 7 |
 *
 * `branding` is deliberately **not** on the list, and the omission is the interesting one.
 * It is a sibling of `proctoring_defaults` inside the same settings document, and it is
 * the one part of that document a candidate is *meant* to see: the logo and the display
 * name on the runner. A deny-list that banned it would be banning the feature. What must
 * never reach a candidate is the document it lives in, which is why the container names
 * are listed and the one publishable leaf is not.
 *
 * Adding a name is cheap. Removing one requires an argument about why a candidate may
 * now see it — and, per docs/17 §3, that argument has to end in a *type*, not in a flag.
 */

/** Field names that must never appear in a candidate-scoped response body. */
export const STAFF_SHAPED_FIELDS: readonly string[] = Object.freeze([
  'permissions',
  'roles',
  'role_key',
  'roleKey',
  'user',
  'user_id',
  'userId',
  'users',
  'created_by',
  'createdBy',
  'email',
  'full_name',
  'fullName',
  'phone',
  'org',
  'org_id',
  'orgId',
  'organization',
  'organisation',
  'candidate_id',
  'candidateId',
  'candidates',
  'token_hash',
  'tokenHash',
  'password',
  'password_hash',
  'passwordHash',
  'secret',
  'pepper',
  'pass_score_pct',
  'passScorePct',
  'proctoring_profile',
  'proctoringProfile',
  'integrity_flag',
  'integrityFlag',
  'max_attempts',
  'maxAttempts',
  'invitation_id',
  'invitationId',
  'application_id',
  'applicationId',
  'audit_log',
  'auditLog',
  'actor_user_id',
  'actorUserId',
  'settings',
  'org_settings',
  'orgSettings',
  'proctoring_defaults',
  'proctoringDefaults',
]);

const STAFF_SHAPED = new Set(STAFF_SHAPED_FIELDS);

/**
 * Walks an already-serialised payload and returns the dotted path of every staff-shaped
 * field it carries. An empty array means the payload is clean.
 *
 * `unknown` because that is what it is: the suite asserts on the shape that actually
 * crossed the boundary, not on the shape the handler claimed to return.
 */
export function findStaffShapedFields(payload: unknown, path = '$'): string[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry, index) => findStaffShapedFields(entry, `${path}[${index}]`));
  }

  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const found: string[] = [];

  for (const [key, value] of Object.entries(payload)) {
    const here = `${path}.${key}`;
    if (STAFF_SHAPED.has(key)) {
      found.push(here);
    }
    found.push(...findStaffShapedFields(value, here));
  }

  return found;
}
