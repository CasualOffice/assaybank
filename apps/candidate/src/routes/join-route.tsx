/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `/join/{room_code}` — live interview join. **Placeholder; built in M3.**
 *
 * What this screen will do: exchange the room code for a WebSocket ticket via
 * `POST /join/{room_code}`, then join the shared Yjs document served by `apps/collab`
 * and the audio/video room. It is a candidate's first thirty seconds of a live
 * interview, so it does the boring things well — device check, a name to confirm, and a
 * clear statement of what is recorded.
 *
 * What it is bound by:
 *
 * - **A ticket, not a session.** The candidate authenticates with a short-lived ticket
 *   minted by the API; this bundle never holds staff credentials and never mints
 *   anything (ADR-013).
 * - **The candidate joins the same document as the interviewer, with candidate scope.**
 *   Interviewer notes, scorecards and any answer key are not in that document — they are
 *   not filtered out of it on the client, they are not put into it on the server
 *   (FR-12).
 * - **Recording is disclosed before it starts**, not in a footnote
 *   (docs/11-data-retention-and-dpia.md).
 */

import type { JSX } from 'react';

import { useRouteAnnouncement } from '../shell/shell-context';
import { PhaseNotice } from './phase-notice';

export interface JoinRouteProps {
  /** The human-typeable room code from the interview invitation. */
  readonly roomCode: string;
}

export function JoinRoute(props: JoinRouteProps): JSX.Element {
  useRouteAnnouncement('Join interview');

  return (
    <article className="route route--join">
      <h1>Join your interview</h1>
      <p>Room code {props.roomCode}.</p>
      <p>You will be able to check your microphone and camera before anyone can see or hear you.</p>
      <PhaseNotice
        milestone="M3"
        summary="Exchanges the room code for a WebSocket ticket, runs a device check, discloses what is recorded, and joins the shared editor and the audio/video room."
        specifiedBy="docs/03-API-spec.md §8 and docs/02-HLD.md §3.4"
      />
    </article>
  );
}
