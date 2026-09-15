/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ReactNode } from 'react';

import { cx } from './class-names.js';

/** The four tones an alert comes in. */
export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

/**
 * How loudly the alert announces itself when it appears.
 *
 * `off` is the default and is the right answer for content that is rendered as part of a
 * page. `polite` and `assertive` are for content that appears in response to something
 * the user did, and they are a budgeted resource — see `useAnnounce`.
 */
export type AlertLiveness = 'off' | 'polite' | 'assertive';

/** Props for {@link Alert}. */
export interface AlertProps {
  /** The tone. `info` by default. */
  tone?: AlertTone;
  /** A short heading. Optional; the body alone is a valid alert. */
  title?: ReactNode;
  /** The body. */
  children?: ReactNode;
  /** Whether appearing announces itself, and how. `off` by default. */
  live?: AlertLiveness;
  /**
   * The word that names the tone, rendered as visible text. Defaults to the tone's own
   * name. Override it for wording, never to remove it.
   */
  toneLabel?: string;
  /** An id, so the alert can be the target of an `aria-describedby`. */
  id?: string;
  /** Additional class names, appended to the component's own. */
  className?: string;
}

/** The visible word each tone carries, so the tone is never colour alone. */
const TONE_LABELS: Readonly<Record<AlertTone, string>> = Object.freeze({
  info: 'Information',
  success: 'Success',
  warning: 'Warning',
  danger: 'Error',
});

/**
 * A block of text that says something went right, went wrong, or needs attention.
 *
 * **The tone is always spelled out in text.** A tinted box with a coloured left border
 * tells a screen-reader user nothing and tells a user with a colour-vision deficiency
 * the same nothing. SC 1.4.1 is not satisfied by choosing an accessible red; it is
 * satisfied by the word "Error" being present. docs/15 §6.3 lists this as one of the
 * seven places this product will be tempted to break the criterion.
 *
 * **`live` defaults to `off`.** An alert that is part of the page when the page renders
 * has nothing to announce — the user will reach it by reading. A live role on every
 * alert is how an application ends up with four simultaneous regions of which a screen
 * reader reads one at random, which docs/15 §5.1 names directly. Turn it on for an alert
 * that appears in response to an action, and prefer `useAnnounce` for anything transient.
 */
export function Alert({
  tone = 'info',
  title,
  children,
  live = 'off',
  toneLabel,
  id,
  className,
}: AlertProps): ReactNode {
  const liveProps =
    live === 'assertive'
      ? ({ role: 'alert', 'aria-live': 'assertive', 'aria-atomic': true } as const)
      : live === 'polite'
        ? ({ role: 'status', 'aria-live': 'polite', 'aria-atomic': true } as const)
        : ({} as const);

  return (
    <div {...liveProps} id={id} className={cx('ab-alert', `ab-alert--${tone}`, className)}>
      <span className="ab-alert__tone">{toneLabel ?? TONE_LABELS[tone]}</span>
      {title === undefined || title === null ? null : (
        <span className="ab-alert__title">{title}</span>
      )}
      {children === undefined || children === null ? null : <div>{children}</div>}
    </div>
  );
}
