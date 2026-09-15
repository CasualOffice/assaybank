/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  BINARY,
  CIRCULAR,
  isDeniedKey,
  normaliseKey,
  REDACTED,
  redactRecord,
  redactValue,
  serialiseError,
} from './redaction.js';

describe('normaliseKey', () => {
  it('folds the spellings of one field onto one entry', () => {
    expect(normaliseKey('attempt_token')).toBe('attempttoken');
    expect(normaliseKey('attemptToken')).toBe('attempttoken');
    expect(normaliseKey('Attempt-Token')).toBe('attempttoken');
    expect(normaliseKey('ATTEMPT TOKEN')).toBe('attempttoken');
  });
});

describe('isDeniedKey', () => {
  it('denies by exact name, by family suffix and by subtree prefix', () => {
    expect(isDeniedKey('password')).toBe(true);
    expect(isDeniedKey('refresh_token')).toBe(true);
    expect(isDeniedKey('hidden_test_cases')).toBe(true);
    expect(isDeniedKey('demographic_gender')).toBe(true);
  });

  it('leaves the fields an on-call engineer needs alone', () => {
    // docs/12 §7.1: domain identifiers belong on a log line. It is the metric labels
    // that must stay free of them.
    for (const key of [
      'attempt_id',
      'submission_id',
      'question_version_id',
      'org_id',
      'user_id',
      'trace_id',
      'span_id',
      'event',
      'msg',
      'code',
      'reason',
      'queue',
      'job_name',
      'route_class',
      'status_class',
      'duration_seconds',
    ]) {
      expect(isDeniedKey(key), key).toBe(false);
    }
  });
});

/**
 * The test P0 step 4 asks for by name: one object carrying every forbidden field, and
 * an assertion that not one of the values survives serialisation.
 */
describe('the redaction deny-list', () => {
  const secrets = {
    password: 'hunter2-plaintext',
    token: 'tok_live_9c3f',
    attempt_token: 'att_7f3a1c',
    invitation_token: 'inv_44bd0e',
    ticket: 'ws_ticket_2211',
    secret: 'shhh-do-not-tell',
    authorization: 'Bearer abcdef123456',
    cookie: 'assaybank_session=deadbeef',
    session: 'sess_0192837465',
    pepper: 'TOKEN_PEPPER_VALUE',
    email: 'candidate@example.com',
    phone: '+44 7700 900123',
    full_name: 'Ada Lovelace',
    answer: '42',
    text_answer: 'The answer is a binary search over the sorted prefix sums.',
    selected_option_ids: ['opt_a1', 'opt_b2'],
    stdin: '5\n1 2 3 4 5\n',
    expected_stdout: '15\n',
    solution_code: 'def solve(xs): return sum(xs)',
    prompt_md: '# Reverse a linked list\nGiven the head of a list...',
  } as const;

  const forbiddenValues: string[] = Object.values(secrets).flatMap(
    (value: string | readonly string[]) => (typeof value === 'string' ? [value] : [...value]),
  );

  it('replaces every named field, at the top level', () => {
    const out = redactRecord({ ...secrets });
    for (const key of Object.keys(secrets)) {
      expect(out[key], key).toBe(REDACTED);
    }
  });

  it('replaces them nested inside an object, an array and a Map', () => {
    const payload = {
      request: { headers: { ...secrets } },
      history: [{ submission: { ...secrets } }],
      lookup: new Map<string, unknown>([['token', secrets.token]]),
    };

    const serialised = JSON.stringify(redactValue(payload));

    for (const value of forbiddenValues) {
      expect(serialised, value).not.toContain(value);
    }
    expect(serialised).toContain(REDACTED);
  });

  it('redacts the whole value, never a truncated prefix', () => {
    const out = redactRecord({ attempt_token: 'att_7f3a1c' });
    expect(out['attempt_token']).toBe(REDACTED);
    expect(String(out['attempt_token'])).not.toContain('att_');
  });

  it('redacts camelCase and header spellings of the same fields', () => {
    const out = redactRecord({
      attemptToken: 'att_7f3a1c',
      textAnswer: 'a candidate wrote this',
      'set-cookie': 'assaybank_session=deadbeef',
      Authorization: 'Bearer abcdef123456',
      expectedStdout: '15\n',
      solutionCode: 'return sum(xs)',
      fullName: 'Ada Lovelace',
    });
    for (const value of Object.values(out)) {
      expect(value).toBe(REDACTED);
    }
  });

  it('redacts hidden question content by its subtree key (FR-12, HLD §1)', () => {
    const out = redactValue({
      question: {
        id: 'qv_123',
        hidden: { test_cases: [{ stdin: '7', expected_stdout: '49' }] },
      },
    });
    expect(JSON.stringify(out)).not.toContain('49');
  });
});

describe('redaction by value shape', () => {
  it('redacts a presigned URL, whose query string is the credential', () => {
    const url = 'https://s3.example.com/proctor/abc.webm?X-Amz-Signature=8f2b9c&X-Amz-Expires=600';
    expect(redactValue(url)).toBe(REDACTED);
  });

  it('redacts a JWT wherever it turned up', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5kaWRhdGUifQ.7Hq2sVq0Qw';
    expect(redactValue({ note: jwt })).toEqual({ note: REDACTED });
  });

  it('redacts a DSN carrying an inline password', () => {
    expect(redactValue('postgres://app:s3cr3t@db:5432/assaybank')).toBe(REDACTED);
  });

  it('never emits binary content — proctoring media does not reach a log line', () => {
    expect(redactValue(new Uint8Array([1, 2, 3]))).toBe(BINARY);
  });
});

describe('redactValue robustness', () => {
  it('survives a cycle rather than recursing for ever', () => {
    const node: Record<string, unknown> = { id: 'a' };
    node['self'] = node;
    expect(redactValue(node)).toEqual({ id: 'a', self: CIRCULAR });
  });

  it('keeps the harmless scalars intact', () => {
    expect(redactValue({ count: 3, ok: true, missing: null, when: new Date(0) })).toEqual({
      count: 3,
      ok: true,
      missing: null,
      when: '1970-01-01T00:00:00.000Z',
    });
  });
});

describe('serialiseError', () => {
  it('drops the message and `detail`, which can carry the candidate answer', () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'answers_attempt_question_uniq',
      table: 'answers',
      routine: '_bt_check_unique',
      severity: 'ERROR',
      detail: 'Key (text_answer)=(the candidate wrote this) already exists.',
    });

    const out = serialiseError(err) as Record<string, unknown>;

    expect(out['type']).toBe('Error');
    expect(out['code']).toBe('23505');
    expect(out['constraint']).toBe('answers_attempt_question_uniq');
    expect(out['table']).toBe('answers');
    expect(out['routine']).toBe('_bt_check_unique');
    expect(out['severity']).toBe('ERROR');

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('the candidate wrote this');
    expect(serialised).not.toContain('duplicate key value');
    expect(out['detail']).toBeUndefined();
    expect(out['message']).toBeUndefined();
  });

  it('keeps the stack frames, which say where without saying what', () => {
    const out = serialiseError(new Error('boom')) as Record<string, unknown>;
    const frames = out['stack_frames'];
    expect(Array.isArray(frames)).toBe(true);
    expect(JSON.stringify(frames)).not.toContain('boom');
  });

  it('follows `cause` through the same allow-list', () => {
    const cause = Object.assign(new Error('inner'), { code: 'ECONNREFUSED' });
    const out = serialiseError(new Error('outer', { cause })) as Record<string, unknown>;
    expect((out['cause'] as Record<string, unknown>)['code']).toBe('ECONNREFUSED');
    expect(JSON.stringify(out)).not.toContain('inner');
  });

  it('is tolerant of a value that is not an Error', () => {
    expect(serialiseError({ token: 'tok_live_9c3f' })).toEqual({ token: REDACTED });
  });
});
