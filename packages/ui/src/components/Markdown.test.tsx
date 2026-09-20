/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the rendered prompt promises a reader.
 *
 * The parser's own suite proves nothing dangerous survives parsing. This proves the other
 * half — that the markup this component produces is the markup a screen reader and a keyboard
 * need, because a prompt is read under time pressure by someone who cannot ask a question
 * about it. Heading level, table semantics, scrollable regions and the new-tab warning are
 * each a documented failure of a markdown renderer that got the security part right.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { findElement, scanTags, textOf } from '../test-support/markup.js';
import { Markdown } from './Markdown.js';

const render = (
  source: string,
  props: { headingLevel?: 2 | 3 | 4 | 5; externalLinks?: 'new-tab' | 'same-tab' } = {},
): string => renderToStaticMarkup(<Markdown source={source} {...props} />);

describe('the payload is inert on the page, not merely absent from the tree', () => {
  it('renders a script element as the text the author typed', () => {
    const markup = render('<script>alert(1)</script>');

    // React escaped it, because it was given a string and not markup. The author sees
    // exactly what they wrote, which is also how they notice they wrote it.
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).not.toContain('<script>');
    expect(textOf(markup)).toContain('<script>alert(1)</script>');
  });

  it('drops a javascript: href and keeps the sentence around it', () => {
    const markup = render('Read [the brief](javascript:alert(1)) first.');

    expect(scanTags(markup).some((t) => t.name === 'a')).toBe(false);
    expect(textOf(markup)).toContain('Read the brief first.');
  });
});

describe('headings nest into the page rather than competing with it', () => {
  it('renders a top-level hash at the offset it was given', () => {
    expect(scanTags(render('# Title')).some((t) => t.name === 'h3')).toBe(true);
    expect(scanTags(render('# Title', { headingLevel: 2 })).some((t) => t.name === 'h2')).toBe(
      true,
    );
  });

  it('never emits an h1, which the page already has', () => {
    expect(scanTags(render('# A\n## B\n### C')).some((t) => t.name === 'h1')).toBe(false);
  });

  it('clamps at h6 rather than emitting an element that does not exist', () => {
    const tags = scanTags(render('###### Deep', { headingLevel: 5 })).map((t) => t.name);

    expect(tags).toContain('h6');
    expect(tags).not.toContain('h7');
    expect(tags).not.toContain('h10');
  });
});

describe('keyboard and assistive technology', () => {
  it('makes a code block reachable and names its language', () => {
    const pre = findElement(render('```sql\nSELECT 1;\n```'), 'pre');

    // SC 2.1.1. A code block scrolls sideways; a mouse can scroll it and a keyboard
    // cannot, unless it is focusable.
    expect(pre.attrs['tabindex']).toBe('0');
    expect(pre.attrs['aria-label']).toBe('Code, sql');
  });

  it('renders a table with column headers rather than a grid of cells', () => {
    const markup = render('| Column | Type |\n| --- | --- |\n| id | uuid |');

    expect(scanTags(markup).some((t) => t.name === 'th' && t.attrs['scope'] === 'col')).toBe(true);

    // The scroll container, not the outer wrapper: the same SC 2.1.1 reasoning as the
    // code block above, and the reason a wide schema table stays readable by keyboard.
    const scroll = scanTags(markup).find((t) => t.attrs['class'] === 'ab-md__table-scroll');
    expect(scroll?.attrs['tabindex']).toBe('0');
    expect(scroll?.attrs['role']).toBe('group');
  });

  it('warns that an external link opens a new tab, when it does', () => {
    const markup = render('[docs](https://example.com)', { externalLinks: 'new-tab' });

    // SC 3.2.5: a change of context is announced before it happens, not after.
    expect(textOf(markup)).toContain('(opens in a new tab)');
    expect(findElement(markup, 'a').attrs['rel']).toBe('noopener noreferrer');
  });

  it('does not warn about a new tab when links stay in this one', () => {
    const markup = render('[docs](https://example.com)', { externalLinks: 'same-tab' });

    expect(textOf(markup)).not.toContain('opens in a new tab');
    expect(findElement(markup, 'a').attrs['target']).toBeUndefined();
  });

  it('leaves a relative link alone — it does not leave our origin', () => {
    expect(findElement(render('[a](/questions/1)'), 'a').attrs['rel']).toBeUndefined();
  });

  it('always gives an image an alt attribute, empty when the author meant decorative', () => {
    expect(findElement(render('![a schema](/s.png)'), 'img').attrs['alt']).toBe('a schema');
    expect(findElement(render('![](/s.png)'), 'img').attrs['alt']).toBe('');
  });
});

describe('the ordinary cases', () => {
  it('renders lists, quotes, rules and emphasis as their own elements', () => {
    const tags = scanTags(
      render('- one\n- two\n\n1. first\n\n> quoted\n\n---\n\n**bold** and *italic*'),
    ).map((t) => t.name);

    expect(tags).toContain('ul');
    expect(tags).toContain('ol');
    expect(tags).toContain('blockquote');
    expect(tags).toContain('hr');
    expect(tags).toContain('strong');
    expect(tags).toContain('em');
  });

  it('keeps an ordered list starting where the author started it', () => {
    expect(findElement(render('3. third\n4. fourth'), 'ol').attrs['start']).toBe('3');
  });

  it('renders an empty prompt as an empty block rather than throwing', () => {
    expect(() => render('')).not.toThrow();
    expect(textOf(render(''))).toBe('');
  });
});
