/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Everything the audit writer decides before it touches a database.
 *
 * `prepareAuditEntry` exists so these rules can be asserted without a container:
 * validation is where all of the interesting refusals are, and refusals are the point
 * of this module. `tests/audit.test.ts` covers the half that only a real PostgreSQL can
 * answer — the transaction boundary, the append-only trigger, and the CHECK that binds
 * a writer this file knows nothing about.
 */

import { describe, expect, it } from 'vitest';

import { AttemptIdSchema, OrgIdSchema, UserIdSchema } from '@assaybank/contracts';

import {
  AUDIT_ACTOR_ATTEMPT_KEY,
  AUDIT_REASON_KEY,
  AuditEntryError,
  AuditReasonRequiredError,
  MAX_PAYLOAD_BYTES,
  MAX_REASON_LENGTH,
  REASON_REQUIRED_ACTIONS,
  prepareAuditEntry,
  requiresReason,
  type AuditEntry,
} from './audit.js';

const ORG = OrgIdSchema.parse('7d3f1d2c-0a5e-4c9b-9f11-1a2b3c4d5e6f');
const USER = UserIdSchema.parse('1c0e2b44-9f3a-4d6e-8b21-aa11bb22cc33');
const ATTEMPT = AttemptIdSchema.parse('3f9a7b21-5c4d-4e6f-9a8b-0c1d2e3f4a5b');
const AT = new Date('2026-10-11T09:00:00.000Z');

/** A well-formed staff entry, so each case below varies exactly one thing. */
function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    orgId: ORG,
    actor: { kind: 'staff', userId: USER },
    action: 'question.publish',
    entityType: 'question_version',
    at: AT,
    ...overrides,
  };
}

/** The `after` column of a prepared entry, parsed back from its JSON. */
function afterOf(prepared: { after: string | null }): Record<string, unknown> {
  return prepared.after === null ? {} : (JSON.parse(prepared.after) as Record<string, unknown>);
}

describe('requiresReason', () => {
  it.each(REASON_REQUIRED_ACTIONS)('requires one for %s', (action) => {
    expect(requiresReason(action)).toBe(true);
  });

  it('requires one for every elevated background action, by prefix', () => {
    // ADR-010 grants the job role BYPASSRLS and takes the reason in exchange. By prefix
    // rather than by enumeration, so a job invented in P4 cannot forget to be on a list.
    for (const action of ['job.grade', 'job.deadline_sweep', 'job.invented_next_year']) {
      expect(requiresReason(action)).toBe(true);
    }
  });

  it('does not require one for an ordinary action', () => {
    for (const action of ['question.publish', 'invite.send', 'candidate.submit']) {
      expect(requiresReason(action)).toBe(false);
    }
  });
});

describe('the reason (FR-21, FR-25)', () => {
  it.each(REASON_REQUIRED_ACTIONS)('refuses %s with no reason at all', (action) => {
    expect(() => prepareAuditEntry(entry({ action, entityType: 'attempt' }))).toThrow(
      AuditReasonRequiredError,
    );
  });

  it.each(REASON_REQUIRED_ACTIONS)('refuses %s with a reason of only whitespace', (action) => {
    // The failure mode a required-field check misses: a client that sends the field,
    // satisfies "present", and says nothing. FR-25's requirement is a *non-empty* reason.
    expect(() =>
      prepareAuditEntry(entry({ action, entityType: 'attempt', reason: '   \n\t ' })),
    ).toThrow(AuditReasonRequiredError);
  });

  it('refuses an elevated access with no reason', () => {
    expect(() =>
      prepareAuditEntry(entry({ actor: { kind: 'job' }, action: 'job.grade', entityType: 'system' })),
    ).toThrow(AuditReasonRequiredError);
  });

  it('names the action it refused, so the log line is actionable', () => {
    try {
      prepareAuditEntry(entry({ action: 'attempt.void', entityType: 'attempt' }));
      expect.unreachable('a void with no reason was accepted');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AuditReasonRequiredError);
      expect((error as AuditReasonRequiredError).action).toBe('attempt.void');
      expect((error as Error).message).toContain('FR-25');
    }
  });

  it('is a distinct class from other malformed entries, because it is a 422 and they are 500s', () => {
    // docs/06 §"M4": a void with no reason is validation_failed. Every other refusal here
    // is a programming mistake, and telling a client about one would be a disclosure.
    const missing = new AuditReasonRequiredError('attempt.void');
    expect(missing).toBeInstanceOf(AuditEntryError);
    expect(new AuditEntryError('attempt.void', 'malformed')).not.toBeInstanceOf(
      AuditReasonRequiredError,
    );
  });

  it('stores a supplied reason under the key 0004 constrains', () => {
    const prepared = prepareAuditEntry(
      entry({ action: 'attempt.void', entityType: 'attempt', reason: '  Two people sat it.  ' }),
    );
    expect(afterOf(prepared)[AUDIT_REASON_KEY]).toBe('Two people sat it.');
  });

  it('accepts a reason on an action that does not require one', () => {
    const prepared = prepareAuditEntry(entry({ reason: 'Bank review complete.' }));
    expect(afterOf(prepared)[AUDIT_REASON_KEY]).toBe('Bank review complete.');
  });

  it('refuses a reason long enough to be a payload', () => {
    expect(() =>
      prepareAuditEntry(
        entry({ action: 'attempt.void', entityType: 'attempt', reason: 'x'.repeat(MAX_REASON_LENGTH + 1) }),
      ),
    ).toThrow(/may not exceed/);
  });
});

describe('the actor', () => {
  it('records a staff user in actor_user_id', () => {
    expect(prepareAuditEntry(entry()).actorUserId).toBe(USER);
  });

  it('leaves actor_user_id null for a background job, which has no human behind it', () => {
    const prepared = prepareAuditEntry(
      entry({ actor: { kind: 'job' }, action: 'job.grade', entityType: 'attempt', reason: 'job.grade' }),
    );
    expect(prepared.actorUserId).toBeNull();
  });

  it('leaves actor_user_id null for a candidate, who has no account (docs/03 §1)', () => {
    const prepared = prepareAuditEntry(
      entry({ actor: { kind: 'candidate', attemptId: ATTEMPT }, action: 'candidate.submit', entityType: 'attempt' }),
    );
    expect(prepared.actorUserId).toBeNull();
    // ...so the attempt is what identifies them. A null actor column with nothing else
    // on the row is a record that says "nobody", which is worse than no record.
    expect(afterOf(prepared)[AUDIT_ACTOR_ATTEMPT_KEY]).toBe(ATTEMPT);
  });

  it('refuses a job action from a staff actor, because the prefix means "no human"', () => {
    expect(() => prepareAuditEntry(entry({ action: 'job.grade', reason: 'job.grade' }))).toThrow(
      /reserved/,
    );
  });

  it('refuses a candidate action from a staff actor', () => {
    expect(() => prepareAuditEntry(entry({ action: 'candidate.submit' }))).toThrow(/reserved/);
  });

  it('refuses a background job that does not name itself as one', () => {
    expect(() =>
      prepareAuditEntry(entry({ actor: { kind: 'job' }, action: 'attempt.grade', reason: 'why' })),
    ).toThrow(/must record a "job\."/);
  });

  it('refuses a candidate action that does not carry the candidate prefix', () => {
    expect(() =>
      prepareAuditEntry(entry({ actor: { kind: 'candidate', attemptId: ATTEMPT }, action: 'attempt.submit' })),
    ).toThrow(/must record a "candidate\."/);
  });
});

describe('the action and the entity', () => {
  it.each(['attempt.void', 'question.publish', 'job.deadline_sweep', 'org.settings.update'])(
    'accepts %s',
    (action) => {
      expect(() =>
        prepareAuditEntry(
          entry({
            action,
            entityType: 'attempt',
            reason: 'because',
            ...(action.startsWith('job.') ? { actor: { kind: 'job' as const } } : {}),
          }),
        ),
      ).not.toThrow();
    },
  );

  it.each(['publish', 'Question.Publish', 'question publish', 'question.', '.publish', ''])(
    'refuses %s, which GET /audit-log could not filter on',
    (action) => {
      expect(() => prepareAuditEntry(entry({ action }))).toThrow(AuditEntryError);
    },
  );

  it('trims an action rather than storing the whitespace', () => {
    expect(prepareAuditEntry(entry({ action: '  question.publish  ' })).action).toBe(
      'question.publish',
    );
  });

  it('refuses an entity type that is not a lowercase snake-case noun', () => {
    for (const entityType of ['', 'Question Version', 'question-version', '1question']) {
      expect(() => prepareAuditEntry(entry({ entityType }))).toThrow(AuditEntryError);
    }
  });

  it('accepts no entity id, for an action that is about no single row', () => {
    expect(prepareAuditEntry(entry({ entityType: 'system' })).entityId).toBeNull();
  });

  it('refuses an entity id that is not a UUID, rather than failing mid-transaction', () => {
    // entity_id is a uuid column. A malformed value would abort the transaction the
    // action is running in, so the action would be rolled back by a formatting mistake.
    expect(() => prepareAuditEntry(entry({ entityId: 'question-42' }))).toThrow(/must be a UUID/);
  });
});

describe('the payload', () => {
  it('writes null rather than an empty object when there is nothing to say', () => {
    const prepared = prepareAuditEntry(entry({ before: {}, after: {} }));
    expect(prepared.before).toBeNull();
    expect(prepared.after).toBeNull();
  });

  it('keeps before and after separate and verbatim', () => {
    const prepared = prepareAuditEntry(
      entry({
        action: 'score.override',
        entityType: 'attempt',
        reason: 'Grader mis-scored question 3.',
        before: { score: 41 },
        after: { score: 55 },
      }),
    );
    expect(prepared.before).not.toBeNull();
    expect(JSON.parse(prepared.before ?? '{}')).toEqual({ score: 41 });
    // FR-21: both numbers survive, and so does the sentence explaining the disagreement.
    expect(afterOf(prepared)).toEqual({ score: 55, [AUDIT_REASON_KEY]: 'Grader mis-scored question 3.' });
  });

  it('refuses a caller payload that claims a key the writer owns', () => {
    // Silently picking one of two values for `reason` would produce a record that is
    // present, looks complete, and is wrong.
    expect(() =>
      prepareAuditEntry(
        entry({ action: 'attempt.void', entityType: 'attempt', reason: 'a', after: { reason: 'b' } }),
      ),
    ).toThrow(/writer owns it/);

    expect(() =>
      prepareAuditEntry(entry({ after: { [AUDIT_ACTOR_ATTEMPT_KEY]: ATTEMPT } })),
    ).toThrow(/writer owns it/);
  });

  it('refuses a payload key whose name says it is a secret', () => {
    // An audit row outlives every credential rotation policy the organisation has.
    for (const key of ['password', 'token_hash', 'api_key', 'Authorization', 'session_secret']) {
      expect(() => prepareAuditEntry(entry({ after: { [key]: 'x' } })), key).toThrow(/secret/);
    }
  });

  it('finds a secret nested inside the payload, not only at the top', () => {
    expect(() =>
      prepareAuditEntry(entry({ before: { invitation: { detail: { token: 'abc' } } } })),
    ).toThrow(/secret/);
  });

  it('finds a secret inside an array', () => {
    expect(() => prepareAuditEntry(entry({ after: { items: [{ password: 'x' }] } }))).toThrow(
      /secret/,
    );
  });

  it('refuses a payload over the size budget', () => {
    expect(() => prepareAuditEntry(entry({ after: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES) } }))).toThrow(
      /budget/,
    );
  });

  it('refuses a payload nested past the depth limit', () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) nested = { level: nested };
    expect(() => prepareAuditEntry(entry({ after: nested }))).toThrow(/nests deeper/);
  });

  it('refuses a payload that cannot be serialised', () => {
    // A bigint rather than a cycle: a cyclic object is caught by the depth guard long
    // before JSON.stringify is reached, so asserting on one would leave the serialiser's
    // own refusal untested while looking as though it were covered. A bigint walks the
    // inspection cleanly — it is not an object — and fails at exactly the statement this
    // case is about.
    expect(() => prepareAuditEntry(entry({ after: { attempts_seen: 3n } }))).toThrow(
      /could not be serialised/,
    );
  });

  it('refuses a cyclic payload too, before it can be walked forever', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => prepareAuditEntry(entry({ after: cyclic }))).toThrow(AuditEntryError);
  });
});

describe('the client address', () => {
  it('records an IPv4 and an IPv6 address verbatim', () => {
    expect(prepareAuditEntry(entry({ ip: '203.0.113.7' })).ip).toBe('203.0.113.7');
    expect(prepareAuditEntry(entry({ ip: '2001:db8::1' })).ip).toBe('2001:db8::1');
  });

  it('records null when there was no address', () => {
    expect(prepareAuditEntry(entry()).ip).toBeNull();
    expect(prepareAuditEntry(entry({ ip: null })).ip).toBeNull();
    expect(prepareAuditEntry(entry({ ip: '' })).ip).toBeNull();
  });

  it('refuses something that is not an address, rather than failing mid-transaction', () => {
    // The column is `inet`. An unparseable value aborts the transaction the *action* is
    // running in, so without this check a request carrying `X-Forwarded-For: nonsense`
    // rolls its own void back — a caller-triggered failure of an audited write. apps/api
    // parses the header before it gets here; this is the backstop for every other caller.
    for (const ip of ['not-an-ip', '203.0.113.7, 198.51.100.1', '999.1.1.1', 'fe80::1%lo0']) {
      expect(() => prepareAuditEntry(entry({ ip })), ip).toThrow(/not an IPv4 or IPv6 address/);
    }
  });

  it('refuses a CIDR range, which is a network and not a client', () => {
    expect(() => prepareAuditEntry(entry({ ip: '203.0.113.0/24' }))).toThrow(
      /not an IPv4 or IPv6 address/,
    );
  });
});

describe('the instant', () => {
  it('uses the injected clock verbatim (ADR-006)', () => {
    // Never `now()` in SQL and never `new Date()` here: a column that falls back to the
    // wall clock is a column no test can assert on, and this one is evidence.
    expect(prepareAuditEntry(entry()).at).toBe('2026-10-11T09:00:00.000Z');
  });

  it('refuses an invalid instant rather than writing one', () => {
    expect(() => prepareAuditEntry(entry({ at: new Date('not a date') }))).toThrow(
      /not a valid instant/,
    );
  });
});
