/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { findElement, scanTags, textOf } from '../test-support/markup.js';
import { Input } from './Input.js';
import { Skeleton } from './Skeleton.js';
import { SkipLink } from './SkipLink.js';
import { VisuallyHidden } from './VisuallyHidden.js';

describe('VisuallyHidden', () => {
  it('keeps the text in the accessibility tree rather than hiding it', () => {
    const markup = renderToStaticMarkup(<VisuallyHidden>Question 6, answered</VisuallyHidden>);
    const span = findElement(markup, 'span');

    expect(span.attrs['class']).toBe('ab-visually-hidden');
    expect(textOf(markup)).toBe('Question 6, answered');
    // display:none and visibility:hidden remove the element from the accessibility tree,
    // and hidden/aria-hidden do the same. None of them may appear here.
    expect(span.attrs['aria-hidden']).toBeUndefined();
    expect(span.attrs['hidden']).toBeUndefined();
    expect(markup).not.toContain('style=');
  });

  it('renders as a block element when the parent needs one', () => {
    expect(renderToStaticMarkup(<VisuallyHidden as="div">x</VisuallyHidden>)).toContain('<div');
    expect(renderToStaticMarkup(<VisuallyHidden as="p">x</VisuallyHidden>)).toContain('<p');
  });

  it('takes an id so the hidden text can be an aria-describedby target', () => {
    const markup = renderToStaticMarkup(
      <VisuallyHidden id="editor-help">Press Escape twice to leave the editor.</VisuallyHidden>,
    );
    expect(findElement(markup, 'span').attrs['id']).toBe('editor-help');
  });
});

describe('SkipLink', () => {
  it('links to the target fragment and labels itself', () => {
    const markup = renderToStaticMarkup(<SkipLink targetId="main-content" />);
    const link = findElement(markup, 'a');

    expect(link.attrs['href']).toBe('#main-content');
    expect(link.attrs['class']).toContain('ab-skip-link');
    expect(textOf(markup)).toBe('Skip to main content');
  });

  it('accepts the other bypass labels the candidate app needs', () => {
    const markup = renderToStaticMarkup(<SkipLink targetId="editor">Skip to editor</SkipLink>);

    expect(findElement(markup, 'a').attrs['href']).toBe('#editor');
    expect(textOf(markup)).toBe('Skip to editor');
  });

  it('renders as a real anchor at all times, so it is in the tab order', () => {
    const markup = renderToStaticMarkup(<SkipLink targetId="main-content" />);

    // A skip link that is display:none until focused can never receive the focus that
    // would reveal it. The offset lives in a transform in styles/base.css.
    expect(markup).not.toContain('hidden');
    expect(markup).not.toContain('style=');
  });
});

describe('Skeleton', () => {
  it('is hidden from assistive technology and has no live role', () => {
    const markup = renderToStaticMarkup(<Skeleton />);
    const span = findElement(markup, 'span');

    // A skeleton is a picture of content that does not exist. Exposing twelve of them
    // reads as nothing, twelve times; the loading state is announced once instead.
    expect(span.attrs['aria-hidden']).toBe('true');
    expect(markup).not.toContain('aria-live');
    expect(markup).not.toContain('role=');
  });

  it('takes its dimensions as CSS so a caller can shape it to the content', () => {
    const markup = renderToStaticMarkup(<Skeleton width="12rem" height="2rem" radius="999px" />);
    const style = findElement(markup, 'span').attrs['style'] ?? '';

    expect(style).toContain('width:12rem');
    expect(style).toContain('height:2rem');
    expect(style).toContain('border-radius:999px');
  });
});

describe('Input', () => {
  it('names its type rather than relying on the implicit default', () => {
    expect(findElement(renderToStaticMarkup(<Input />), 'input').attrs['type']).toBe('text');
  });

  it('sets aria-invalid from the invalid prop', () => {
    const markup = renderToStaticMarkup(<Input invalid />);
    expect(findElement(markup, 'input').attrs['aria-invalid']).toBe('true');
  });

  it('leaves aria-invalid off when the value is fine', () => {
    expect(
      findElement(renderToStaticMarkup(<Input />), 'input').attrs['aria-invalid'],
    ).toBeUndefined();
  });

  it('passes through the attributes a form needs', () => {
    const markup = renderToStaticMarkup(
      <Input id="slug" name="slug" autoComplete="off" maxLength={64} />,
    );
    const input = findElement(markup, 'input');

    expect(input.attrs['id']).toBe('slug');
    expect(input.attrs['name']).toBe('slug');
    expect(input.attrs['autocomplete']).toBe('off');
    expect(input.attrs['maxlength']).toBe('64');
  });
});

describe('the baseline in DOM order', () => {
  it('puts the skip link before the main landmark it targets', () => {
    const markup = renderToStaticMarkup(
      <div>
        <SkipLink targetId="main-content" />
        <header>
          <a href="/questions">Questions</a>
        </header>
        <main id="main-content" tabIndex={-1}>
          <h1>Dashboard</h1>
        </main>
      </div>,
    );

    const tags = scanTags(markup);
    const skip = tags.findIndex((tag) => tag.attrs['class'] === 'ab-skip-link');
    const nav = tags.findIndex((tag) => tag.name === 'header');
    const main = tags.findIndex((tag) => tag.name === 'main');

    // Focus order follows DOM order, so this ordering *is* the bypass block working:
    // among everything in the tab order, the skip link has to come first.
    const tabbable = tags.filter(
      (tag) =>
        (tag.name === 'a' && tag.attrs['href'] !== undefined) ||
        tag.name === 'button' ||
        tag.name === 'input',
    );
    expect(tabbable[0]?.attrs['class']).toBe('ab-skip-link');
    expect(skip).toBeLessThan(nav);
    expect(nav).toBeLessThan(main);

    // And the target has to be focusable, or the browser moves the scroll position and
    // leaves focus where it was — the failure that makes a skip link look implemented.
    const mainTag = tags[main];
    expect(mainTag?.attrs['id']).toBe('main-content');
    expect(mainTag?.attrs['tabindex']).toBe('-1');
  });
});
