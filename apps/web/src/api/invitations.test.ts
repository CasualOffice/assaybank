/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parsing a pasted list of addresses (`H-182`).
 *
 * The screen's whole premise is that a recruiter arrives holding a list in whatever shape the
 * source produced, and this is the function that has to accept it. Every case below came from
 * a real place a list gets copied out of, and each one silently losing a candidate is the
 * failure mode: somebody is simply never invited, and nobody finds out until they ask why
 * they heard nothing.
 */

import { describe, expect, it } from 'vitest';

import { parseEmails } from './invitations.js';

describe('parseEmails', () => {
  it('takes one per line, which is what a spreadsheet column pastes as', () => {
    expect(parseEmails('ada@x.test\ngrace@x.test\n')).toEqual(['ada@x.test', 'grace@x.test']);
  });

  it('takes a comma-separated list, which is what a mail client pastes as', () => {
    expect(parseEmails('ada@x.test, grace@x.test')).toEqual(['ada@x.test', 'grace@x.test']);
  });

  it('takes semicolons, which is what Outlook pastes as', () => {
    expect(parseEmails('ada@x.test; grace@x.test')).toEqual(['ada@x.test', 'grace@x.test']);
  });

  it('takes tabs, which is what a two-column spreadsheet selection pastes as', () => {
    expect(parseEmails('ada@x.test\tgrace@x.test')).toEqual(['ada@x.test', 'grace@x.test']);
  });

  it('keeps only the address from a display name', () => {
    // Every mail client copies this form, and the whole string is not an address.
    expect(parseEmails('Ada Lovelace <ada@x.test>, Grace Hopper <grace@x.test>')).toEqual([
      'ada@x.test',
      'grace@x.test',
    ]);
  });

  it('drops a repeat regardless of case, because one person is one invitation', () => {
    expect(parseEmails('ada@x.test, ADA@x.test, Ada@X.test')).toEqual(['ada@x.test']);
  });

  it('keeps the first spelling of a repeated address rather than the last', () => {
    // The recruiter typed it first; echoing their own spelling back is less alarming than
    // showing them a case they did not write.
    expect(parseEmails('Ada@x.test, ada@x.test')).toEqual(['Ada@x.test']);
  });

  it('ignores empty pieces from trailing separators and blank lines', () => {
    expect(parseEmails('ada@x.test,,\n\n  \ngrace@x.test,')).toEqual([
      'ada@x.test',
      'grace@x.test',
    ]);
  });

  it('is empty for an empty paste rather than producing one blank address', () => {
    expect(parseEmails('')).toEqual([]);
    expect(parseEmails('   \n\t ')).toEqual([]);
  });

  it('does not validate — that is the server’s answer to give', () => {
    // A client-side guess at what is a valid address is a client-side guess that rejects
    // somebody's real one. The contract's `z.email()` refuses it on the way in, with a
    // message that names the field.
    expect(parseEmails('not-an-address')).toEqual(['not-an-address']);
  });
});
