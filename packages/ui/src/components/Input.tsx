/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ComponentPropsWithRef, type ReactNode } from 'react';

import { cx } from './class-names.js';

/** Props for {@link Input}. */
export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'className'> {
  /**
   * The value failed validation. Sets `aria-invalid`, which is what a screen reader
   * announces; the red border is reinforcement (SC 1.4.1) and never the signal.
   */
  invalid?: boolean;
  /** Additional class names, appended to `ab-input`. */
  className?: string;
}

/**
 * A text input.
 *
 * It carries no label of its own by design. A control labelled by a `placeholder` is a
 * control with no label the moment the user types, and `aria-label` hides the name from
 * a sighted user who would also like to know it. Use {@link Field}, which owns the
 * `<label for>` association, the description and the error wiring.
 *
 * `type` defaults to `text` rather than being left off: a bare `<input>` is a text input
 * anyway, and saying so keeps the rendered markup honest to what the tests assert.
 */
export function Input({ invalid, className, type = 'text', ...rest }: InputProps): ReactNode {
  return (
    <input
      {...rest}
      type={type}
      className={cx('ab-input', className)}
      aria-invalid={invalid === true ? true : rest['aria-invalid']}
    />
  );
}
