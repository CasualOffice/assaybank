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
 */

import { Button } from '@assaybank/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import { logoutRequest, type StaffProfile } from '../api/session.js';

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
    </div>
  );
}
