/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The list-screen primitives: badge, table, empty state, select, toolbar.
 *
 * What is asserted here is the accessibility contract of each, because that is the part
 * that is easy to break while the component keeps looking right — a table that loses its
 * caption, a badge that starts relying on its colour, a scroll region the keyboard cannot
 * reach.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { findElement, scanTags, textOf } from '../test-support/markup.js';
import { Badge, type BadgeTone } from './Badge.js';
import { EmptyState } from './EmptyState.js';
import { Select } from './Select.js';
import { Table } from './Table.js';
import { Toolbar } from './Toolbar.js';

const TONES: readonly BadgeTone[] = ['neutral', 'info', 'success', 'warning', 'danger'];

describe('Badge', () => {
  it.each(TONES)('carries its meaning as text in the %s tone, not as colour', (tone) => {
    const markup = renderToStaticMarkup(<Badge tone={tone}>Published</Badge>);

    // SC 1.4.1: the word is the information. Removing every stylesheet must not remove it.
    expect(textOf(markup)).toContain('Published');
    expect(findElement(markup, 'span').attrs['class']).toContain(`ab-badge--${tone}`);
  });

  it('prefixes a label for assistive technology when the column heading is out of reach', () => {
    const markup = renderToStaticMarkup(<Badge label="Status">Retired</Badge>);

    expect(textOf(markup)).toContain('Status:');
    expect(textOf(markup)).toContain('Retired');
  });

  it('renders no label element when none is given', () => {
    expect(renderToStaticMarkup(<Badge>Draft</Badge>)).not.toContain('ab-badge__label');
  });
});

describe('Table', () => {
  const rows = (
    <Table caption="Questions in this bank" summary="Showing 2 of 40">
      <thead>
        <tr>
          <th scope="col">Prompt</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Reverse a linked list</td>
          <td>Published</td>
        </tr>
      </tbody>
    </Table>
  );

  it('renders a real table with a caption', () => {
    const markup = renderToStaticMarkup(rows);

    // A caption is how a screen-reader user decides whether to enter the table at all.
    expect(markup).toContain('<caption');
    expect(textOf(markup)).toContain('Questions in this bank');
    expect(textOf(markup)).toContain('Showing 2 of 40');
    expect(scanTags(markup).some((t) => t.name === 'table')).toBe(true);
  });

  it('keeps the caption in the accessibility tree when it is hidden visually', () => {
    const markup = renderToStaticMarkup(
      <Table caption="Questions" captionHidden>
        <tbody>
          <tr>
            <td>A</td>
          </tr>
        </tbody>
      </Table>,
    );

    expect(markup).toContain('ab-visually-hidden');
    expect(textOf(markup)).toContain('Questions');
  });

  it('makes the horizontal scroll region reachable by keyboard (SC 2.1.1)', () => {
    const scroll = findElement(renderToStaticMarkup(rows), 'div');

    // A region the mouse can scroll and the keyboard cannot is a region a keyboard user
    // cannot read the right-hand columns of.
    expect(scroll.attrs['tabindex']).toBe('0');
    expect(scroll.attrs['role']).toBe('group');
    expect(scroll.attrs['aria-label']).toBe('Questions in this bank');
  });
});

describe('EmptyState', () => {
  it('names the first-run case and offers the action that ends it', () => {
    const markup = renderToStaticMarkup(
      <EmptyState
        reason="empty"
        title="No questions yet"
        action={<button type="button">New question</button>}
      >
        A question belongs to a skill and is versioned from its first save.
      </EmptyState>,
    );

    expect(findElement(markup, 'section').attrs['class']).toContain('ab-empty--empty');
    expect(textOf(markup)).toContain('No questions yet');
    expect(textOf(markup)).toContain('New question');
  });

  it('distinguishes "no matches" from "nothing exists"', () => {
    const markup = renderToStaticMarkup(
      <EmptyState reason="no-matches" title="No questions match these filters" />,
    );

    // The two cases want different words and different actions: offering "New question"
    // to somebody whose filter is too narrow answers a question they did not ask.
    expect(findElement(markup, 'section').attrs['class']).toContain('ab-empty--no-matches');
  });

  it('gives the region a heading, so it is findable by heading navigation', () => {
    const markup = renderToStaticMarkup(<EmptyState reason="empty" title="Nothing here" />);

    expect(scanTags(markup).some((t) => t.name === 'h2')).toBe(true);
  });
});

describe('Select', () => {
  it('renders a native select, so the platform supplies the keyboard behaviour', () => {
    const markup = renderToStaticMarkup(
      <Select id="kind" defaultValue="coding">
        <option value="coding">Coding</option>
      </Select>,
    );

    expect(scanTags(markup).some((t) => t.name === 'select')).toBe(true);
    expect(findElement(markup, 'select').attrs['class']).toContain('ab-select');
  });

  it('marks itself invalid for the field around it', () => {
    const markup = renderToStaticMarkup(
      <Select invalid>
        <option value="">—</option>
      </Select>,
    );

    expect(findElement(markup, 'select').attrs['aria-invalid']).toBe('true');
  });
});

describe('Toolbar', () => {
  it('is a labelled search landmark rather than an unimplemented ARIA toolbar', () => {
    const markup = renderToStaticMarkup(
      <Toolbar label="Filter questions">
        <input aria-label="Search" />
      </Toolbar>,
    );

    // role="toolbar" promises roving arrow-key focus. These are ordinary form controls,
    // each its own tab stop, so claiming the role would tell the user to press keys that
    // do nothing.
    expect(markup).not.toContain('role="toolbar"');
    expect(findElement(markup, 'search').attrs['aria-label']).toBe('Filter questions');
  });
});
