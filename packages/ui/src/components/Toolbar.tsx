/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ReactNode } from 'react';

import { cx } from './class-names.js';

/** Props for {@link Toolbar}. */
export interface ToolbarProps {
  /**
   * Names the group of controls: "Filter questions". Required — a region of unlabelled
   * controls is a region a screen-reader user has to read through to identify.
   */
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * The row of controls above a list: search, filters, and the actions that act on the list.
 *
 * A labelled `<search>` landmark rather than `role="toolbar"`. The ARIA toolbar role brings
 * a contract with it — arrow-key roving focus between its controls, one tab stop for the
 * group — and a toolbar that declares the role without implementing that behaviour is worse
 * than no role: it tells the user to press arrow keys that do nothing. These controls are
 * ordinary form fields, each its own tab stop, which is what a filter row should be.
 */
export function Toolbar({ label, children, className }: ToolbarProps): ReactNode {
  return (
    <search className={cx('ab-toolbar', className)} aria-label={label}>
      {children}
    </search>
  );
}
