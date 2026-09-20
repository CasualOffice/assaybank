/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ComponentPropsWithRef, type ReactNode } from 'react';

import { cx } from './class-names.js';

/** Props for {@link Select}. */
export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'className'> {
  /** Marks the control invalid. The message belongs in the {@link Field} around it. */
  invalid?: boolean;
  className?: string;
}

/**
 * A single-choice control, built on the native `<select>`.
 *
 * Native on purpose. A custom listbox has to reimplement type-ahead, `Home`/`End`, page
 * up and down, the mobile wheel, the Windows high-contrast treatment and the screen-reader
 * announcements — and the reimplementation is where combobox accessibility bugs live. The
 * native control gets all of that from the platform and costs a slightly less fashionable
 * arrow.
 *
 * Like {@link Input} it carries no label of its own: {@link Field} owns the association.
 *
 * The wrapper exists for the arrow. Drawing it as a `background-image` on the control —
 * the usual trick — leaves the control with a background an automated contrast checker
 * cannot resolve, so `color-contrast` comes back as "needs review" on every select in the
 * product and the one criterion most likely to regress stops being checkable. The arrow is
 * a pseudo-element on the wrapper instead, and the control keeps a flat background colour.
 */
export function Select({ invalid, className, children, ...rest }: SelectProps): ReactNode {
  return (
    <span className="ab-select-shell">
      <select
        {...rest}
        className={cx('ab-select', className)}
        aria-invalid={invalid === true ? true : rest['aria-invalid']}
      >
        {children}
      </select>
    </span>
  );
}
