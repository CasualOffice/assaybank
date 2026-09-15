/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `/t/{token}` — invitation redemption. **Placeholder; built in M1.**
 *
 * What this screen will do: exchange the single-use invitation token from the emailed
 * link for a short-lived attempt token, show the candidate what they are about to sit —
 * duration, sections, whether it is proctored — and the instructions they need *before*
 * the clock starts, then start the attempt on an explicit action.
 *
 * Three rules this screen is already bound by, recorded here because they are easy to
 * violate while building it and expensive to discover afterwards:
 *
 * 1. **No CAPTCHA, ever** (docs/15 §2.3, SC 3.3.8 Accessible Authentication). A puzzle
 *    on redemption is a cognitive function test standing between a candidate and a job.
 *    Abuse is handled by per-IP rate limiting (20/hour, docs/03 §2) and by the token
 *    being single-use and stored hashed — never by escalating to a challenge.
 * 2. **The clock starts on the server, at start, not here.** `deadline_at` comes back
 *    from `POST /attempt/start` with `duration_seconds` and any recorded accommodation
 *    already applied (ADR-006). This screen renders what the server says the duration
 *    is; it does not compute one.
 * 3. **The pre-assessment instructions are part of the accessibility baseline.** The
 *    editor's keyboard-escape advisory (docs/15 §4.2) is shown here, before the clock is
 *    running, so a candidate meets it in their own time rather than during the attempt.
 *
 * The token is deliberately not logged, not put in a page title and not echoed into the
 * route announcement — it is a bearer credential for the whole attempt.
 */

import type { JSX } from 'react';

import { useRouteAnnouncement } from '../shell/shell-context';
import { PhaseNotice } from './phase-notice';

export interface RedeemRouteProps {
  /** The opaque invitation token from the emailed link. Never rendered or logged. */
  readonly token: string;
}

export function RedeemRoute(props: RedeemRouteProps): JSX.Element {
  useRouteAnnouncement('Assessment invitation');

  return (
    <article className="route route--redeem">
      <h1>Your assessment invitation</h1>
      <p>
        This link opens your assessment. You will see what it covers and how long it takes before
        the timer starts.
      </p>
      <p className="route__detail">
        {/* Length only. The token itself is a bearer credential and is never displayed. */}
        Invitation reference received ({String(props.token.length)} characters).
      </p>
      <PhaseNotice
        milestone="M1"
        summary="Redeems the single-use invitation token, shows the assessment briefing and the editor keyboard advisory, and starts the attempt on an explicit action."
        specifiedBy="docs/03-API-spec.md §6 and docs/15-accessibility-conformance.md §2.3"
      />
    </article>
  );
}
