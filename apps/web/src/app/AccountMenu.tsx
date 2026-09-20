/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who is signed in, and the way out (`H-177`).
 *
 * The console has had no account context at all, which is one of the things that made it read
 * as a prototype: a multi-tenant tool that never says which tenant you are in is a tool you
 * cannot safely act in. The organisation is named above the person, because the question a
 * recruiter with two customers actually asks is "whose bank am I about to publish into".
 *
 * ## Signing out discards the cache, not just the cookie
 *
 * `queryClient.clear()` rather than removing the session entry. Every cached question, role
 * and attribution belongs to the organisation that was signed in, and leaving it behind means
 * the next person to sign in on this browser sees the previous one's data rendered from cache
 * before their own arrives. `queryClient.ts` names this as the reason it is a factory rather
 * than a singleton.
 *
 * It clears the cache even when the request fails. A logout that leaves data on screen
 * because the network was down is a logout that did not happen, and the person who pressed it
 * has already walked away from the laptop.
 *
 * ## A failed sign-out has to say so (`H-193`)
 *
 * Clearing the cache is not ending the session — the session lives on the server, and if the
 * request did not reach it the person is still signed in. Watched in a browser: the request
 * failed, the cache emptied, the console re-fetched the session, got it, and carried on as
 * though the button had never been pressed. Silent, and exactly backwards from what somebody
 * pressing **Sign out** on a shared machine needs to know.
 *
 * So a failure is said out loud, `assertive` because it contradicts what the person believes
 * they just did, and the button stays where it is so the obvious second press is the right
 * one.
 */

import { Alert, Button } from '@assaybank/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import { logoutRequest, type StaffProfile } from '../api/session.js';

/**
 * What a failed sign-out says.
 *
 * A component of its own so it can be rendered and asserted without a click: jsdom is not on
 * the approved dependency list (ADR-001, and `vitest.config.ts` gives the reasoning), so this
 * workspace renders with `react-dom/server` and leaves interaction to the Playwright suite.
 * Splitting the message out is what lets the wording — the part that matters, and the part a
 * refactor would quietly lose — be covered here rather than only in a browser.
 *
 * `assertive`, because it contradicts what the person believes they just did. A polite live
 * region waits for a pause in the screen reader's queue, and this is the one message on the
 * screen that must not wait.
 */
export function SignOutFailure(): ReactNode {
  return (
    <Alert
      tone="danger"
      toneLabel="Still signed in"
      title="Sign-out did not reach the server"
      live="assertive"
    >
      <p>Your session is still open. Try again, and close the browser if it keeps failing.</p>
    </Alert>
  );
}

/** Props for {@link AccountMenu}. */
export interface AccountMenuProps {
  profile: StaffProfile;
}

export function AccountMenu({ profile }: AccountMenuProps): ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();

  const signOut = useMutation({
    mutationFn: () => logoutRequest(api),
    onSettled: () => {
      queryClient.clear();
    },
  });

  // Not `displayMessage`. The server's prose for a failed logout is about the request; what
  // the person needs is the consequence, which is that they are still signed in.
  const failed = signOut.isError;

  return (
    <div className="ab-account">
      <p className="ab-account__org" title={profile.org.name}>
        {profile.org.name}
      </p>
      <p className="ab-account__user" title={profile.user.email}>
        {profile.user.full_name}
      </p>
      <Button
        className="ab-account__signout"
        busy={signOut.isPending}
        onClick={() => {
          signOut.mutate();
        }}
      >
        Sign out
      </Button>

      {failed ? <SignOutFailure /> : null}
    </div>
  );
}
