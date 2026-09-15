/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `.env.example` as executable documentation.
 *
 * The schema and the example file must agree in both directions: a variable declared
 * here and missing there is undocumented, and a variable there and missing here is
 * read by nothing and will quietly rot. docs/13 §4 makes adding a variable a four-file
 * change; this test is the half of that rule a machine can enforce.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import { ENV_VAR_NAMES, loadConfig, SECRET_ENV_VARS, VARIABLES } from './index.js';

import { ENV_EXAMPLE_PATH, envWith, parseDotenv, readEnvExample } from '../test/env-fixture.js';

const example = readEnvExample();
const exampleNames = Object.keys(example);
const declared = new Set<string>(ENV_VAR_NAMES);

describe('.env.example and the schema agree', () => {
  it('declares every variable that .env.example sets', () => {
    const undeclared = exampleNames.filter((name) => !declared.has(name));

    expect(undeclared, 'in .env.example but not parsed by packages/config').toEqual([]);
  });

  it('sets in .env.example every variable the schema declares', () => {
    const undocumented = ENV_VAR_NAMES.filter((name) => !exampleNames.includes(name));

    expect(undocumented, 'declared by packages/config but absent from .env.example').toEqual([]);
  });

  it('lists each variable exactly once', () => {
    const lines = readFileSync(ENV_EXAMPLE_PATH, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.slice(0, line.indexOf('=')));

    expect(lines).toHaveLength(new Set(lines).size);
    expect(lines).toHaveLength(ENV_VAR_NAMES.length);
  });

  it('is itself a valid local environment', () => {
    const config = loadConfig(envWith());

    expect(config.core.appEnv).toBe('local');
    expect(config.core.nodeEnv).toBe('development');
  });

  it('satisfies the schema variable by variable, not only as a whole', () => {
    for (const name of ENV_VAR_NAMES) {
      const raw = example[name];
      expect(raw, `${name} is missing from .env.example`).toBeDefined();
      if (raw === undefined || raw.trim() === '') continue;
      const schema: ZodType = VARIABLES[name].schema;
      const result = schema.safeParse(raw);
      expect(result.success, `${name}=${raw} does not satisfy its schema`).toBe(true);
    }
  });

  it('keeps every declared placeholder in step with the value committed to the file', () => {
    for (const name of ENV_VAR_NAMES) {
      const { placeholder } = VARIABLES[name];
      if (placeholder === null) continue;
      expect(example[name], `${name} placeholder has drifted from .env.example`).toBe(placeholder);
    }
  });

  it('carries no real secret — every secret in it is a development placeholder', () => {
    // A committed file that parses is only safe if what it commits is worthless. Each
    // secret is either a CHANGE_ME marker or an obvious local-stack value.
    for (const name of SECRET_ENV_VARS) {
      const value = example[name] ?? '';
      if (value === '') continue;
      const looksLikeAPlaceholder =
        value.startsWith('CHANGE_ME') ||
        value.includes('hiring') ||
        value.includes('mailpit') ||
        value.includes('valkey') ||
        value === 'admin';
      expect(
        looksLikeAPlaceholder,
        `${name} in .env.example does not look like a placeholder`,
      ).toBe(true);
    }
  });

  it('rejects the example file wholesale in a deployed tier', () => {
    // The whole point of the §4.16 tightenings: a deploy that shipped .env.example
    // unchanged must not start.
    expect(() => loadConfig(envWith({ APP_ENV: 'production', NODE_ENV: 'production' }))).toThrow(
      /SESSION_SECRET/,
    );
  });
});

describe('the .env parser used by these tests', () => {
  it('reads KEY=value and ignores comments and blank lines', () => {
    expect(parseDotenv('# a comment\n\nA=1\nB=two=three\n')).toEqual({ A: '1', B: 'two=three' });
  });

  it('refuses a line that is not KEY=value rather than silently dropping it', () => {
    expect(() => parseDotenv('NOT_AN_ASSIGNMENT\n')).toThrow(/not KEY=value/);
  });
});
