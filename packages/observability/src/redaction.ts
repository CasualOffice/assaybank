/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The log redaction deny-list (docs/12 §7.2).
 *
 * Redaction is implemented here, at the serialiser, rather than at each call site, so
 * that it holds even when a developer logs a whole object — which is exactly the moment
 * a token, a candidate's answer, a hidden test case or a candidate's email would
 * otherwise reach a log aggregator that recruiters can read.
 *
 * Two properties are deliberate:
 *
 *  - The replacement is the whole value, never a truncated prefix. A prefix of a token
 *    is still a token to an attacker who has the rest.
 *  - The walk is recursive and depth-limited. pino's own `redact` option only matches
 *    paths known in advance; a deny-list that only covers the top level is an invitation
 *    to nest the secret one level deeper. Both mechanisms are wired up in logger.ts.
 */

/** The value every denied field is replaced with. Never a truncated prefix. */
export const REDACTED = '[redacted]';

/** Placeholder for a value that was already visited on this branch. */
export const CIRCULAR = '[circular]';

/** Placeholder for binary content — proctoring media never reaches a log line. */
export const BINARY = '[binary]';

/** Placeholder for a value below the depth or width limit of the walk. */
export const TRUNCATED = '[truncated]';

const MAX_DEPTH = 8;
const MAX_ENTRIES = 200;
const MAX_STACK_FRAMES = 20;

/**
 * `attempt_token`, `attemptToken`, `Attempt-Token` and `ATTEMPT_TOKEN` are one field as
 * far as a deny-list is concerned. Normalising removes the only degree of freedom a
 * caller has to slip past it by accident.
 */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

/**
 * Exact field names. Normalised, so `full_name`, `fullName` and `FULL NAME` all match
 * the single entry `fullname`.
 */
const DENY_KEYS: ReadonlySet<string> = new Set(
  [
    // Credentials and secrets (docs/12 §7.2, row 1)
    'password',
    'passwordhash',
    'passphrase',
    'secret',
    'sessionsecret',
    'token',
    'tokenhash',
    'attempttoken',
    'invitationtoken',
    'refreshtoken',
    'accesstoken',
    'idtoken',
    'bearer',
    'ticket',
    'wsticket',
    'apikey',
    'session',
    'pepper',
    'tokenpepper',
    'salt',
    'nonce',
    'otp',
    'databaseurl',
    'redisurl',
    'smtpurl',
    's3accesskeyid',
    's3secretaccesskey',
    'oidcclientsecret',
    'livekitapisecret',
    'webhooksigningsecret',
    // Headers (docs/12 §7.2, row 2)
    'authorization',
    'proxyauthorization',
    'cookie',
    'cookies',
    'setcookie',
    'xsignature',
    // Candidate answers (docs/12 §7.2, row 3). Note that a bare `code` is deliberately
    // absent: the stable `ErrorCode` of the API envelope is the single most useful field
    // on a failure line, and candidate source arrives under `source_code`.
    'answer',
    'answers',
    'textanswer',
    'selectedoptionids',
    'sourcecode',
    'submissioncode',
    'candidatecode',
    'compilestderr',
    'actualstdout',
    'stdout',
    'stderr',
    'stdin',
    'output',
    // Question secrets (docs/12 §7.2, row 4) — FR-12: hidden content never leaves the bank
    'iscorrect',
    'correct',
    'correctoptionids',
    'answerkey',
    'answerkeys',
    'expectedstdout',
    'expectedoutput',
    'testcases',
    'solutioncode',
    'referencesolution',
    'promptmd',
    'prompt',
    'rubric',
    'explanation',
    'explanationmd',
    'hidden',
    // Candidate PII (docs/12 §7.2, row 5)
    'email',
    'emailaddress',
    'phone',
    'phonenumber',
    'mobile',
    'fullname',
    'firstname',
    'lastname',
    'givenname',
    'familyname',
    'displayname',
    'legalname',
    'resumeurl',
    'linkedinurl',
    'address',
    'postcode',
    'dateofbirth',
    'dob',
    'gender',
    'ethnicity',
    'nationality',
    'ip',
    'ipaddress',
    'remoteaddress',
    'useragent',
    'proctormedia',
    'webcamurl',
    'screenurl',
    'recordingurl',
  ].map(normaliseKey),
);

/**
 * Whole subtrees that are denied by their root key. `hidden` covers HLD §1 directly:
 * anything a question author filed under `hidden` is hidden from a log line too.
 */
const DENY_PREFIXES: readonly string[] = [
  'hidden',
  'demographic',
  'password',
  'secret',
  'token',
  'proctor',
];

/**
 * Suffix rules catch the family rather than the member: `refresh_token`, `ws_ticket`,
 * `text_answer`, `expected_stdout`. Over-redaction is the acceptable direction of error.
 */
const DENY_SUFFIXES: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'credential',
  'credentials',
  'pepper',
  'cookie',
  'signature',
  'privatekey',
  'ticket',
  'answer',
  'stdin',
  'stdout',
  'stderr',
  'solutioncode',
];

/** A JWT-shaped string is a credential wherever it turned up. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/u;

/** A presigned URL's query string *is* the credential — log the object key instead. */
const PRESIGNED_RE =
  /(x-amz-signature|x-amz-credential|x-goog-signature|[?&](sig|signature|token|access_token|key)=)/iu;

/** A DSN with an inline password: `postgres://user:pw@host/db`. */
const DSN_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/iu;

/** Fields of an error that cannot carry candidate or question data (docs/12 §7.2). */
const ERROR_FIELD_ALLOW_LIST: readonly string[] = [
  'code',
  'constraint',
  'table',
  'routine',
  'severity',
  'errno',
  'syscall',
];

/** True when a field name is on the deny-list by exact name, prefix or suffix. */
export function isDeniedKey(key: string): boolean {
  const normalised = normaliseKey(key);
  if (normalised.length === 0) return false;
  if (DENY_KEYS.has(normalised)) return true;
  if (DENY_PREFIXES.some((prefix) => normalised.startsWith(prefix))) return true;
  return DENY_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

/** Redacts a string whose *shape* makes it a credential regardless of its field name. */
function redactString(value: string): string {
  if (JWT_RE.test(value)) return REDACTED;
  if (PRESIGNED_RE.test(value)) return REDACTED;
  if (DSN_RE.test(value)) return REDACTED;
  return value;
}

/**
 * Serialises an error through a field allow-list.
 *
 * A Postgres error carries the parameter values of the failing statement, which for an
 * answer upsert is the candidate's answer; the message and `detail` are therefore never
 * emitted. The stack is reduced to its frames — the first line of a stack is the message.
 */
export function serialiseError(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (!(value instanceof Error)) {
    // Tolerant on purpose: pino applies `formatters.log` before its serialisers, so by
    // the time the `err` serialiser runs the error has usually already been reduced to
    // the record below. Re-walking it is harmless; re-wrapping it would be confusing.
    return redactValue(value, depth, seen);
  }

  const out: Record<string, unknown> = { type: value.name };

  const source = value as unknown as Record<string, unknown>;
  for (const field of ERROR_FIELD_ALLOW_LIST) {
    const fieldValue = source[field];
    if (typeof fieldValue === 'string' || typeof fieldValue === 'number') {
      out[field] = fieldValue;
    }
  }

  if (typeof value.stack === 'string') {
    const frames = value.stack
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at '))
      .slice(0, MAX_STACK_FRAMES);
    if (frames.length > 0) out['stack_frames'] = frames;
  }

  if (value.cause !== undefined && depth < MAX_DEPTH) {
    out['cause'] = serialiseError(value.cause, depth + 1, seen);
  }

  return out;
}

/**
 * Walks any value and replaces every denied field with `[redacted]`.
 *
 * Depth- and width-limited, and cycle-safe: a logger that can be made to recurse for
 * ever is a denial-of-service vector on the request path it is instrumenting.
 */
export function redactValue(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return REDACTED;
  if (typeof value !== 'object') return REDACTED;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return BINARY;

  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TRUNCATED;

  if (value instanceof Error) return serialiseError(value, depth, visited);

  visited.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value.slice(0, MAX_ENTRIES)) {
        items.push(redactValue(item, depth + 1, visited));
      }
      if (value.length > MAX_ENTRIES) items.push(TRUNCATED);
      return items;
    }

    if (value instanceof Set) {
      return redactValue([...value].slice(0, MAX_ENTRIES), depth, visited);
    }

    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const [key, entry] of value) {
        if (count >= MAX_ENTRIES) break;
        count += 1;
        const name = String(key);
        out[name] = isDeniedKey(name) ? REDACTED : redactValue(entry, depth + 1, visited);
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= MAX_ENTRIES) break;
      count += 1;
      out[key] = isDeniedKey(key) ? REDACTED : redactValue(entry, depth + 1, visited);
    }
    return out;
  } finally {
    visited.delete(value);
  }
}

/** The shape pino's `formatters.log` and `formatters.bindings` hooks require. */
export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = isDeniedKey(key) ? REDACTED : redactValue(value, 1);
  }
  return out;
}

/**
 * The field names P0 step 4 names explicitly. They are also covered by the recursive
 * walk above; listing them here wires pino's own `redact` option up as a second,
 * independent mechanism, so a future change to the walk cannot silently unprotect them.
 */
const REDACT_LEAVES: readonly string[] = [
  'password',
  'token',
  'attempt_token',
  'invitation_token',
  'ticket',
  'secret',
  'authorization',
  'cookie',
  'session',
  'pepper',
  'email',
  'phone',
  'full_name',
  'answer',
  'text_answer',
  'selected_option_ids',
  'stdin',
  'expected_stdout',
  'solution_code',
  'prompt_md',
];

/** Paths handed to pino's `redact` option: each leaf at the top level and one below it. */
export const PINO_REDACT_PATHS: readonly string[] = [
  ...REDACT_LEAVES,
  ...REDACT_LEAVES.map((leaf) => `*.${leaf}`),
];
