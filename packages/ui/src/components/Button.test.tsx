/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { findElement, textOf } from '../test-support/markup.js';
import { Button } from './Button.js';

describe('Button', () => {
  it('defaults to type="button" so it cannot submit a form by accident', () => {
    const markup = renderToStaticMarkup(<Button>Save</Button>);
    expect(findElement(markup, 'button').attrs['type']).toBe('button');
  });

  it('still allows an explicit submit button', () => {
    const markup = renderToStaticMarkup(<Button type="submit">Save</Button>);
    expect(findElement(markup, 'button').attrs['type']).toBe('submit');
  });

  it('carries its tone as a class and its label as text', () => {
    const markup = renderToStaticMarkup(<Button tone="danger">Void attempt</Button>);
    const button = findElement(markup, 'button');

    expect(button.attrs['class']).toContain('ab-button');
    expect(button.attrs['class']).toContain('ab-button--danger');
    // The tone is visual; the meaning is in the label, which is why "Void attempt" is
    // the accessible name rather than a red icon.
    expect(textOf(markup)).toBe('Void attempt');
  });

  it('announces a busy action with aria-busy and keeps it focusable', () => {
    const markup = renderToStaticMarkup(
      <Button busy busyLabel="Publishing…">
        Publish
      </Button>,
    );
    const button = findElement(markup, 'button');

    expect(button.attrs['aria-busy']).toBe('true');
    expect(button.attrs['aria-disabled']).toBe('true');
    // Not the native `disabled`: that removes the control from the tab order under a
    // keyboard user who has just pressed it.
    expect(button.attrs['disabled']).toBeUndefined();
    // SC 1.4.1 — the busy state is text, not a spinning shape.
    expect(textOf(markup)).toBe('Publishing…');
  });

  it('sets neither busy attribute when it is not busy', () => {
    const button = findElement(renderToStaticMarkup(<Button>Publish</Button>), 'button');

    expect(button.attrs['aria-busy']).toBeUndefined();
    expect(button.attrs['aria-disabled']).toBeUndefined();
  });

  it('suppresses the click while busy, because aria-disabled does not', () => {
    const onClick = vi.fn();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    // The rendered element is what would receive the event; the handler is the unit
    // under test, so it is invoked directly rather than through a document.
    const element = Button({ busy: true, onClick, children: 'Publish' });
    const handler = extractClickHandler(element);

    handler({ preventDefault, stopPropagation });

    expect(onClick).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('forwards the click when it is not busy', () => {
    const onClick = vi.fn();
    const element = Button({ onClick, children: 'Publish' });
    const handler = extractClickHandler(element);
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    handler(event);

    expect(onClick).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledWith(event);
  });
});

/** The minimum shape the handler touches. */
interface ClickLike {
  preventDefault: () => void;
  stopPropagation: () => void;
}

/**
 * Digs the `onClick` prop out of the element `Button` returns.
 *
 * Unpleasant, and the honest way to test the behaviour without a document: the click
 * suppression lives in a handler, and jsdom is not on the ADR-001 approved dependency
 * list. The end-to-end suite of docs/15 §15.1 exercises the real event.
 */
function extractClickHandler(element: unknown): (event: ClickLike) => void {
  if (
    typeof element !== 'object' ||
    element === null ||
    !('props' in element) ||
    typeof element.props !== 'object' ||
    element.props === null ||
    !('onClick' in element.props) ||
    typeof element.props.onClick !== 'function'
  ) {
    throw new Error('Button did not render an element with an onClick handler');
  }

  return element.props.onClick as unknown as (event: ClickLike) => void;
}
