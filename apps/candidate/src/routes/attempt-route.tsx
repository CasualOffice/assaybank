/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `/attempt` — the assessment runner. **Placeholder; MCQ in M1, coding in M2.**
 *
 * What this screen will do: render the served question set for the attempt in progress,
 * autosave every change, and submit. It is where a candidate spends the hour, and it is
 * the screen the rest of this application exists to protect.
 *
 * The invariants it is already bound by:
 *
 * - **The served set is materialised once, at attempt start, and never re-rolled**
 *   (ADR-004). Refreshing this page, losing the network, or resuming on another machine
 *   yields the same questions in the same order. The runner reads
 *   `attempt_questions`; it does not ask for a draw.
 * - **The countdown is display only** (ADR-006). It is derived from `server_time` and a
 *   monotonic counter (`src/time/countdown.ts`), it never reads the wall clock, and
 *   reaching zero here prompts a submit rather than performing an expiry. Expiry is a
 *   server-side state transition.
 * - **Nothing here knows an answer.** No correct-answer flag, no hidden test-case
 *   content, no reference solution and no scoring weight reaches a candidate-scoped
 *   response (FR-12), and the code that would know them is not linked into this bundle
 *   at all (ADR-013, CODE-GRAPH L5). Run results show pass/fail and a label for hidden
 *   cases, never their content.
 * - **Autosave buffers locally and replays on reconnect** (FR-9). Losing the network
 *   must not lose work; see `src/net/connection.ts`.
 * - **Proctoring signals are advisory telemetry only.** This screen emits them and
 *   renders no integrity verdict; no signal rejects, voids or down-scores an attempt
 *   (ADR-007, ADR-017).
 *
 * Accessibility obligations that land with the runner rather than with the shell: MCQ as
 * native `fieldset`/`radio` groups (docs/15 §6), the editor keyboard advisory and escape
 * route (§4.2), and the plain accessible editor mode (§4.3).
 */

import type { JSX } from 'react';

import { useRouteAnnouncement } from '../shell/shell-context';
import { PhaseNotice } from './phase-notice';

export function AttemptRoute(): JSX.Element {
  useRouteAnnouncement('Assessment');

  return (
    <article className="route route--attempt">
      <h1>Assessment</h1>
      <p>
        Your questions, your answers and your time remaining appear here once your attempt has
        started.
      </p>
      <PhaseNotice
        milestone="M1 (multiple choice) and M2 (coding)"
        summary="Renders the question set materialised at attempt start, autosaves every change with a local buffer that replays on reconnect, and submits."
        specifiedBy="docs/01-PRD.md FR-9 and FR-12, docs/04-ADRs.md ADR-004 and ADR-006"
      />
    </article>
  );
}
