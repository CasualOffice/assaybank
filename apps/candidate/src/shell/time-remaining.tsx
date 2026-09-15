/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The time-remaining region in the candidate shell.
 *
 * ## THE CLIENT CLOCK IS DISPLAY ONLY (ADR-006)
 *
 * This component renders a number the *server* computed. `deadline_at` is fixed at
 * `POST /attempt/start` from `duration_seconds` plus any recorded accommodation, is
 * persisted, and is never recomputed from client input. The value shown here is an
 * estimate of the server's clock derived from `server_time` and a monotonic counter (see
 * `src/time/countdown.ts`), and if it disagrees with the server the server is right.
 * Reaching zero here is a prompt to submit, not the act of expiry — expiry is a
 * server-side state transition and nothing in this bundle performs it.
 *
 * ## Why this element is not a live region
 *
 * docs/15 §3.3 is explicit, and it is the rule most often broken: the timer element
 * itself is **never `aria-live`**. A region that announces every second renders a screen
 * reader useless for the hour the candidate most needs it. It is a plain element with
 * `role="timer"`, left un-live, and the four threshold announcements (50%, 10 minutes,
 * 5 minutes, 1 minute) are published to the shared regions by the countdown clock.
 *
 * What the criterion actually requires is that the remaining time be *available on
 * demand*, which it is three ways: visibly on screen, in this element's accessible name
 * spelled out in words, and through the "Assessment status" summary control in the
 * header (docs/15 §5.3).
 *
 * ## Why the warning is not just red
 *
 * SC 1.4.1 forbids conveying information by colour alone, and SC 2.3.1 forbids flashing.
 * Under ten minutes the region gains a text label and a marker glyph alongside the
 * number; it never pulses, never flashes and never changes to red as its only signal.
 */

import type { JSX } from 'react';

import type { CountdownSnapshot } from '../time/countdown';
import { formatRemaining, formatRemainingForSpeech } from '../time/countdown';

/** Below this, the region shows its warning treatment. */
const WARNING_THRESHOLD_MS = 10 * 60 * 1_000;

export interface TimeRemainingProps {
  /** `null` before the server has issued a deadline — see `useCountdown`. */
  readonly countdown: CountdownSnapshot | null;
  /** "Assessment" or a section name, so a candidate knows which clock they are hearing. */
  readonly label?: string | undefined;
}

export function TimeRemaining(props: TimeRemainingProps): JSX.Element {
  const { countdown } = props;
  const label = props.label ?? 'Assessment';

  if (countdown === null) {
    // No deadline has been issued. The application must not invent a placeholder
    // countdown: a number the server did not authorise is a number that will be wrong.
    return (
      <p className="time-remaining time-remaining--idle" data-testid="time-remaining">
        {label} timer starts when you begin.
      </p>
    );
  }

  const warning = !countdown.expired && countdown.remainingMs <= WARNING_THRESHOLD_MS;
  const spoken = countdown.expired
    ? `${label} time is up. Submitting your work.`
    : `${label} time remaining: ${formatRemainingForSpeech(countdown.remainingMs)}`;

  return (
    <p
      className={warning ? 'time-remaining time-remaining--warning' : 'time-remaining'}
      data-testid="time-remaining"
    >
      <span className="time-remaining__label" aria-hidden="true">
        {label}
      </span>
      {warning ? (
        // Text and a glyph, not colour alone (SC 1.4.1). `aria-hidden` on the glyph
        // because the accessible name below already carries the whole message.
        <span className="time-remaining__warning-mark" aria-hidden="true">
          ⏳ Low time
        </span>
      ) : null}
      <span
        // role="timer" without aria-live: announced on demand, never on every tick.
        role="timer"
        className="time-remaining__value"
        aria-label={spoken}
      >
        {countdown.expired ? '0:00' : formatRemaining(countdown.remainingMs)}
      </span>
    </p>
  );
}
