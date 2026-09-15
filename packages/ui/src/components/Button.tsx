/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ComponentPropsWithRef, type MouseEvent, type ReactNode } from 'react';

import { cx } from './class-names.js';

/** The visual weights a button comes in. */
export type ButtonTone = 'primary' | 'secondary' | 'danger';

/** Props for {@link Button}. */
export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'className'> {
  /** Visual weight. `secondary` by default, because most buttons are not the main action. */
  tone?: ButtonTone;
  /**
   * The action is in flight. The control stays focusable and announces itself as busy,
   * rather than leaving the tab order under the user's cursor.
   */
  busy?: boolean;
  /** The label shown while `busy`. Text, never a spinner alone. */
  busyLabel?: ReactNode;
  /** Additional class names, appended to the component's own. */
  className?: string;
}

/**
 * A button.
 *
 * Three decisions here are accessibility decisions rather than styling ones.
 *
 * **`type` defaults to `button`.** HTML's default is `submit`, so a button rendered
 * inside a form and given an `onClick` submits the form as well. In an assessment
 * builder that is a saved draft nobody asked for; in a submit-confirmation dialog it is
 * worse.
 *
 * **Busy is `aria-disabled`, not `disabled`.** A `disabled` button is removed from the
 * tab order, so a keyboard user who pressed it and is waiting loses their place and is
 * told nothing. `aria-disabled` keeps the control focusable and announces the state,
 * and the click is suppressed here instead of by the browser.
 *
 * **The busy state has a text label.** SC 1.4.1: a spinner is a shape and a colour, and
 * a control whose only change is that it started spinning has told a screen-reader user
 * nothing. Transient progress belongs in the polite live region — see `useAnnounce`.
 */
export function Button({
  tone = 'secondary',
  busy = false,
  busyLabel = 'Working…',
  className,
  children,
  type = 'button',
  onClick,
  ...rest
}: ButtonProps): ReactNode {
  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    if (busy) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    onClick?.(event);
  }

  return (
    <button
      {...rest}
      type={type}
      className={cx('ab-button', `ab-button--${tone}`, className)}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={handleClick}
    >
      {busy ? busyLabel : children}
    </button>
  );
}
