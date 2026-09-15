/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import * as coreDomain from './index.js';

describe('@assaybank/core-domain', () => {
  it('names itself with the workspace name declared in package.json', () => {
    expect(coreDomain.WORKSPACE_NAME).toBe('@assaybank/core-domain');
  });

  it('exports the whole public surface through src/index.ts and nothing more', () => {
    expect(Object.keys(coreDomain).sort()).toStrictEqual(
      [
        'ATTEMPT_STATUSES',
        'QUESTION_KINDS',
        'WORKSPACE_NAME',
        'canTransition',
        'computeDeadline',
        'domainError',
        'err',
        'isErr',
        'isOk',
        'isPastDeadline',
        'isTerminalStatus',
        'mapResult',
        'ok',
        'resolveDraw',
        'rollUpSkillScores',
        'secondsRemaining',
        'shuffleOptions',
        'transition',
        'unwrapOr',
      ].sort(),
    );
  });

  it('exposes no clock of its own — time is always injected (CODE-GRAPH L2)', () => {
    expect(Object.keys(coreDomain)).not.toContain('systemClock');
    expect(Object.keys(coreDomain)).not.toContain('now');
  });
});
