/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'vitest';

import { type RequestContext, withContext } from './context.js';
import { createLogger, type Logger } from './logger.js';
import { REDACTED } from './redaction.js';

/** Collects the raw lines a logger writes, so the JSON contract itself can be asserted. */
class LineSink {
  public readonly lines: string[] = [];

  public write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim().length > 0) this.lines.push(line);
    }
  }

  public records(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  public last(): Record<string, unknown> {
    const records = this.records();
    const record = records[records.length - 1];
    if (record === undefined) throw new Error('nothing was logged');
    return record;
  }
}

let sink: LineSink;
let log: Logger;

beforeEach(() => {
  sink = new LineSink();
  log = createLogger({
    service: 'hiring-api',
    env: 'test',
    level: 'debug',
    destination: sink,
  });
});

describe('the log line contract (docs/12 §7.1)', () => {
  it('is single-line JSON carrying ts, level, service, env, msg and event', () => {
    log.info({ event: 'autosave.rejected', attempt_id: 'att_1' }, 'autosave rejected');

    expect(sink.lines).toHaveLength(1);
    const record = sink.last();

    expect(record['level']).toBe('info');
    expect(record['service']).toBe('hiring-api');
    expect(record['env']).toBe('test');
    expect(record['msg']).toBe('autosave rejected');
    expect(record['event']).toBe('autosave.rejected');
    // Domain identifiers are encouraged in this sink; they are banned only on metrics.
    expect(record['attempt_id']).toBe('att_1');
    expect(String(record['ts'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });

  it('does not emit pid or hostname', () => {
    log.info('up');
    const record = sink.last();
    expect(record['pid']).toBeUndefined();
    expect(record['hostname']).toBeUndefined();
  });

  it('honours the level', () => {
    const quiet = createLogger({ service: 'hiring-worker', level: 'warn', destination: sink });
    quiet.debug('invisible');
    quiet.warn('visible');
    expect(sink.records()).toHaveLength(1);
    expect(sink.last()['msg']).toBe('visible');
  });
});

describe('trace and tenant context', () => {
  it('stamps trace_id, org_id and user_id from the ambient request context', () => {
    const ctx: RequestContext = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      // The branded OrgId lives in @assaybank/contracts; the test reaches it through the
      // context type rather than importing it, so this file stays independent of it.
      orgId: 'org_9f2b' as RequestContext['orgId'],
      userId: 'usr_221',
    };

    withContext(ctx, () => {
      log.info({ event: 'attempt.started' }, 'attempt started');
    });

    const record = sink.last();
    expect(record['trace_id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(record['org_id']).toBe('org_9f2b');
    expect(record['user_id']).toBe('usr_221');
  });

  it('omits the fields outside a request context rather than inventing them', () => {
    log.info('worker booted');
    const record = sink.last();
    expect(record['trace_id']).toBeUndefined();
    expect(record['org_id']).toBeUndefined();
  });
});

/**
 * Rule 1 of P0 step 4, at the logger rather than at the serialiser: an object carrying
 * every deny-listed field is logged, and no value survives.
 */
describe('the logger never emits a secret, an answer, hidden content or PII', () => {
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
    pepper: 'pepper-value-0091',
    email: 'candidate@example.com',
    phone: '+44 7700 900123',
    full_name: 'Ada Lovelace',
    answer: 'answer-value-0092',
    text_answer: 'a binary search over the sorted prefix sums',
    selected_option_ids: ['opt_a1', 'opt_b2'],
    stdin: 'stdin-value-0093',
    expected_stdout: 'expected-value-0094',
    solution_code: 'def solve(xs): return sum(xs)',
    prompt_md: '# Reverse a linked list',
  } as const;

  const forbiddenValues: string[] = Object.values(secrets).flatMap(
    (value: string | readonly string[]) => (typeof value === 'string' ? [value] : [...value]),
  );

  it('redacts every one of them, at the top level and nested', () => {
    log.info(
      {
        event: 'request.failed',
        attempt_id: 'att_1',
        ...secrets,
        req: { headers: { ...secrets }, body: { deeply: { nested: { ...secrets } } } },
      },
      'request failed',
    );

    const line = sink.lines.join('\n');
    for (const value of forbiddenValues) {
      expect(line, value).not.toContain(value);
    }

    const record = sink.last();
    expect(record['attempt_id']).toBe('att_1');
    for (const key of Object.keys(secrets)) {
      expect(record[key], key).toBe(REDACTED);
    }
  });

  it('redacts the bindings of a child logger too', () => {
    const child = log.child({ queue: 'grading.submit', attempt_token: 'att_7f3a1c' });
    child.info('job started');
    const record = sink.last();
    expect(record['queue']).toBe('grading.submit');
    expect(record['attempt_token']).toBe(REDACTED);
  });

  it('never puts a raw error message in msg', () => {
    const err = Object.assign(new Error('duplicate key: (text_answer)=(candidate wrote this)'), {
      code: '23505',
      table: 'answers',
    });

    log.error(err);

    const record = sink.last();
    expect(record['msg']).toBe('error');
    const line = sink.lines.join('\n');
    expect(line).not.toContain('candidate wrote this');
    const serialisedError = record['err'] as Record<string, unknown>;
    expect(serialisedError['code']).toBe('23505');
    expect(serialisedError['table']).toBe('answers');
  });

  it('serialises an attached error through the allow-list', () => {
    log.warn(
      { event: 'exec.failed', err: new Error('piston said: solution_code leaked') },
      'exec failed',
    );
    const line = sink.lines.join('\n');
    expect(line).not.toContain('piston said');
    expect(sink.last()['msg']).toBe('exec failed');
  });
});
