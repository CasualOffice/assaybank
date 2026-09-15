/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The failure type of this package.
 *
 * docs/13 §4.16 is explicit about why this exists: a missing `CANDIDATE_PUBLIC_URL`
 * breaks nothing at boot if it is read lazily — it breaks four hours later when the
 * first invitation goes out with a dead link, to a whole cohort. So configuration is
 * parsed once, and a failure names the variable, what was expected and what arrived.
 */

/** One variable that failed validation. */
export interface ConfigIssue {
  /** The environment variable name, exactly as it appears in `.env.example`. */
  readonly variable: string;
  /** Human description of the accepted shape, e.g. `an integer between 1 and 65535`. */
  readonly expected: string;
  /**
   * What arrived, quoted. Redacted to `[redacted]` for a variable marked secret, so a
   * crash log or a CI log can never carry a secret value (docs/12 §7.2).
   */
  readonly received: string;
  /** `<variable>: expected <expected>, received <received>`. */
  readonly message: string;
}

const UNKNOWN_VARIABLE = '(unknown)';

function describe(issues: readonly ConfigIssue[]): string {
  const count = issues.length;
  const head =
    count === 1
      ? 'Invalid environment configuration: 1 problem found.'
      : `Invalid environment configuration: ${String(count)} problems found.`;
  const lines = issues.map((issue) => `  - ${issue.message}`);
  return [
    head,
    ...lines,
    '',
    'Fix these in .env — .env.example lists every variable this process reads, and',
    'docs/13-environments-and-release.md §4 documents each one. The process refuses to',
    'start with an invalid environment rather than fail mid-exam.',
  ].join('\n');
}

/**
 * Thrown by {@link loadConfig} when the environment does not satisfy the schema.
 *
 * Carries the failing variable name — `variable` is the first failure, `variables` is
 * every one of them, and `issues` carries the expected/received detail per variable.
 */
export class ConfigError extends Error {
  /** The first failing variable. Present so a caller can branch without parsing text. */
  readonly variable: string;
  /** Every failing variable, in schema order. */
  readonly variables: readonly string[];
  /** The full detail behind each failure. */
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(describe(issues));
    this.name = 'ConfigError';
    this.issues = Object.freeze([...issues]);
    this.variables = Object.freeze(issues.map((issue) => issue.variable));
    this.variable = issues[0]?.variable ?? UNKNOWN_VARIABLE;
  }
}
