/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { findElement, textOf } from '../test-support/markup.js';
import { Alert, type AlertTone } from './Alert.js';

const TONES: readonly [AlertTone, string][] = [
  ['info', 'Information'],
  ['success', 'Success'],
  ['warning', 'Warning'],
  ['danger', 'Error'],
];

describe('Alert', () => {
  it.each(TONES)('renders the %s tone as the word "%s", never as colour alone', (tone, word) => {
    const markup = renderToStaticMarkup(<Alert tone={tone}>Something happened.</Alert>);

    // SC 1.4.1. A tinted box with a coloured border conveys nothing to a screen-reader
    // user and nothing to a user with a colour-vision deficiency (docs/15 §6.3).
    expect(textOf(markup)).toContain(word);
    expect(findElement(markup, 'div').attrs['class']).toContain(`ab-alert--${tone}`);
  });

  it('is not a live region by default', () => {
    const markup = renderToStaticMarkup(<Alert tone="danger">Could not save.</Alert>);

    // Content that is part of the page when it renders has nothing to announce, and a
    // live role on every alert is how four regions end up speaking at once.
    expect(markup).not.toContain('aria-live');
    expect(markup).not.toContain('role=');
  });

  it('uses role="status" with aria-live="polite" when asked to announce politely', () => {
    const markup = renderToStaticMarkup(
      <Alert tone="success" live="polite">
        Assessment saved.
      </Alert>,
    );
    const alert = findElement(markup, 'div');

    expect(alert.attrs['role']).toBe('status');
    expect(alert.attrs['aria-live']).toBe('polite');
    expect(alert.attrs['aria-atomic']).toBe('true');
  });

  it('uses role="alert" with aria-live="assertive" when asked to interrupt', () => {
    const markup = renderToStaticMarkup(
      <Alert tone="danger" live="assertive">
        Your changes could not be saved.
      </Alert>,
    );
    const alert = findElement(markup, 'div');

    expect(alert.attrs['role']).toBe('alert');
    expect(alert.attrs['aria-live']).toBe('assertive');
    // aria-atomic, so the whole message is read rather than the diff.
    expect(alert.attrs['aria-atomic']).toBe('true');
  });

  it('renders the title and body, and takes an id so it can be described by', () => {
    const markup = renderToStaticMarkup(
      <Alert tone="warning" title="Publishing is final" id="publish-warning">
        A published version can never be edited.
      </Alert>,
    );

    expect(findElement(markup, 'div').attrs['id']).toBe('publish-warning');
    expect(textOf(markup)).toContain('Publishing is final');
    expect(textOf(markup)).toContain('A published version can never be edited.');
  });

  it('allows the tone word to be reworded but not removed', () => {
    const markup = renderToStaticMarkup(
      <Alert tone="danger" toneLabel="Failed">
        Nothing was saved.
      </Alert>,
    );

    expect(textOf(markup)).toContain('Failed');
  });
});
