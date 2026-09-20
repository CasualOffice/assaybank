/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Nothing renders until we know who is asking (`H-177`).
 *
 * ## Three states, and the one that is usually wrong
 *
 * **Resolving** — we have asked `GET /auth/me` and have no answer. Neither the console nor
 * the sign-in form may render: showing the console is a shell around an empty session, and
 * showing sign-in flashes a login form at somebody who is signed in, every reload, forever.
 * So this state gets a third thing, and it is deliberately almost nothing.
 *
 * **Absent** — the server does not know us. Sign in, outside the chrome.
 *
 * **Present** — the console, with the profile in hand.
 *
 * Collapsing resolving into either of the others is the defect this component exists to
 * prevent, and it is the one that looks like it works in development, where the answer comes
 * back in two milliseconds off localhost.
 *
 * ## A 401 from any screen lands here
 *
 * A session expires mid-visit and the next query is the one that finds out. Rather than every
 * screen learning to recognise that, the `QueryCache` reports it once: an `unauthenticated`
 * error from any query clears the session, and the gate falls back to sign-in on the next
 * render. A screen added next year inherits this rather than forgetting it.
 *
 * ## What it is not
 *
 * Not authorisation. This answers "do we know who you are", and the server answers "may you
 * do this" per action on every request — a console that decided a permission for itself would
 * be a console somebody could decide differently with devtools open.
 */

import { useQuery } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import { sessionQuery, type StaffProfile } from '../api/session.js';
import { SignInScreen } from '../routes/SignInScreen.js';

/** Props for {@link SessionGate}. */
export interface SessionGateProps {
  /** Rendered only once a profile is in hand. */
  children: (profile: StaffProfile) => ReactNode;
}

export function SessionGate({ children }: SessionGateProps): ReactNode {
  const api = useApi();
  const session = useQuery(sessionQuery(api));

  if (session.isPending) {
    // Deliberately almost nothing. A skeleton of the console would be the shell this
    // component exists to withhold, and a spinner for a request that usually takes 30ms is
    // a flash. The live text is for a screen reader, which otherwise meets silence.
    return (
      <div className="ab-gate" role="status" aria-live="polite">
        <span className="ab-visually-hidden">Checking your session…</span>
      </div>
    );
  }

  // Any failure is treated as "not signed in", including one that is not a 401.
  //
  // That is the safe direction and the honest one: if the console cannot establish who it is
  // talking to — expired session, network gone, API down — it must not render a console. The
  // sign-in screen will fail to sign in and say so, which is a truthful outcome; a shell full
  // of screens whose queries all fail is not.
  if (session.isError || session.data === undefined) {
    return <SignInScreen />;
  }

  return children(session.data);
}
