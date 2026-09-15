/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { WORKSPACE_NAME } from './index.js';

describe('@assaybank/exec-adapter', () => {
  it('names itself with the workspace name declared in package.json', () => {
    expect(WORKSPACE_NAME).toBe('@assaybank/exec-adapter');
  });
});
