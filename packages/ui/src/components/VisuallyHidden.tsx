/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ReactNode } from 'react';

import { cx } from './class-names.js';

/** The elements {@link VisuallyHidden} will render as. A closed set, so nothing is `any`. */
export type VisuallyHiddenElement = 'span' | 'div' | 'p';

/** Props for {@link VisuallyHidden}. */
export interface VisuallyHiddenProps {
  /** The text that is read but not seen. */
  children: ReactNode;
  /** The element to render. `span` by default; `div` or `p` where the parent is block-level. */
  as?: VisuallyHiddenElement;
  /** Additional class names, appended to `ab-visually-hidden`. */
  className?: string;
  /** An id, so the hidden text can be the target of an `aria-describedby`. */
  id?: string;
}

/**
 * Text available to assistive technology and not to the eye.
 *
 * This is the mechanism behind the rule in docs/15 §6.3: *no information is available to
 * a sighted user that is not available in text to a screen-reader user*. Where a design
 * carries meaning in a glyph, a position or a colour, the equivalent text goes here.
 *
 * It is **not** `display: none` and it is **not** `visibility: hidden`. Both of those
 * remove the element from the accessibility tree, which is the opposite of the intent;
 * the clip-path form in `styles/base.css` is the one that keeps it.
 */
export function VisuallyHidden({
  children,
  as = 'span',
  className,
  id,
}: VisuallyHiddenProps): ReactNode {
  const classes = cx('ab-visually-hidden', className);

  if (as === 'div') {
    return (
      <div className={classes} id={id}>
        {children}
      </div>
    );
  }

  if (as === 'p') {
    return (
      <p className={classes} id={id}>
        {children}
      </p>
    );
  }

  return (
    <span className={classes} id={id}>
      {children}
    </span>
  );
}
