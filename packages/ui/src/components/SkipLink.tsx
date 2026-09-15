/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ReactNode } from 'react';

import { cx } from './class-names.js';

/** Props for {@link SkipLink}. */
export interface SkipLinkProps {
  /**
   * The `id` of the element focus should land on. The target must carry `tabIndex={-1}`,
   * otherwise most browsers move the scroll position and leave focus where it was —
   * which is the failure mode that makes a skip link look implemented and not be.
   */
  targetId: string;
  /** The link text. "Skip to main content" by default. */
  children?: ReactNode;
  /** Additional class names, appended to `ab-skip-link`. */
  className?: string;
}

/**
 * The first focusable element on the page: a bypass block (SC 2.4.1).
 *
 * docs/15 §9.3 requires one per surface and names the variants the candidate app will
 * need — "Skip to question", "Skip to answer options", "Skip to test results", "Skip to
 * editor". They are all this component with a different target and a different label.
 *
 * Two properties decide whether it works, and both are in the markup rather than in a
 * script: it is **first in DOM order**, and it is **rendered at all times**, moving into
 * view on focus rather than being inserted on focus. A link that is `display: none` until
 * focused is not in the tab order, so it can never receive the focus that would reveal
 * it.
 */
export function SkipLink({
  targetId,
  children = 'Skip to main content',
  className,
}: SkipLinkProps): ReactNode {
  return (
    <a className={cx('ab-skip-link', className)} href={`#${targetId}`}>
      {children}
    </a>
  );
}
