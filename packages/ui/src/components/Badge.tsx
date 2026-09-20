/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ComponentPropsWithRef, type ReactNode } from 'react';

import { cx } from './class-names.js';

/** What a badge is saying. `neutral` is the default and carries no judgement. */
export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Props for {@link Badge}. */
export interface BadgeProps extends Omit<ComponentPropsWithRef<'span'>, 'className'> {
  tone?: BadgeTone;
  /**
   * A word for assistive technology that the visible text leaves implicit.
   *
   * A badge reading "Published" in a status column is unambiguous on screen and ambiguous
   * when a screen reader reaches it out of context, so a table passes `label="Status"` and
   * the badge announces "Status: Published".
   */
  label?: string;
  className?: string;
}

/**
 * A short, bounded state: a lifecycle status, a question kind, a difficulty.
 *
 * **The text is the information; the colour repeats it.** SC 1.4.1 forbids colour as the
 * only carrier of meaning, and the usual workaround — adding an icon — trades one
 * non-textual signal for another. A badge here always renders its word, so a monochrome
 * display, a colour-blind reader and a screen reader all receive the same thing, and the
 * tone is reinforcement for the reader who can use it.
 *
 * It is deliberately not a button. A badge that can be clicked is a filter control wearing
 * a badge's clothes, and it will be missed by anyone navigating by control.
 */
export function Badge({
  tone = 'neutral',
  label,
  className,
  children,
  ...rest
}: BadgeProps): ReactNode {
  return (
    <span {...rest} className={cx('ab-badge', `ab-badge--${tone}`, className)}>
      {label === undefined ? null : <span className="ab-badge__label">{label}: </span>}
      {children}
    </span>
  );
}
