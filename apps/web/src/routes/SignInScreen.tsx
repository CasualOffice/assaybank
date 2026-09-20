/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The sign-in screen (`H-177`).
 *
 * ## It is outside the shell, and that is the security property
 *
 * There is no sidebar here, no navigation and no page bar, because none of those may render
 * for somebody we cannot identify. A login form drawn *inside* the console chrome is the
 * defect the tracker row names: a shell around an empty session, with links to screens whose
 * queries are about to 401.
 *
 * ## What the form does and does not say
 *
 * One message for every refusal, and it names neither the address nor the password. docs/14
 * `H-176` is the reason: a login that distinguishes "no such user" from "wrong password"
 * enumerates the staff list, and the server already answers both identically after burning
 * the same Argon2 work. A form that guessed more specifically than the server would give back
 * exactly what the server spent effort withholding.
 *
 * The error is a live region and the heading takes focus on arrival, because a failed sign-in
 * that only changes a colour is a failed sign-in a screen-reader user does not learn about
 * (SC 3.3.1).
 */

import { Alert, Button, Field, Input } from '@assaybank/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import { loginRequest, SESSION_KEY } from '../api/session.js';
import { APP_NAME, SURFACE_NAME } from '../app/routes.js';
import { Lockup } from '../app/Lockup.js';

/**
 * The one thing a refused sign-in says.
 *
 * Deliberately not derived from the server's message. The server is careful to answer
 * identically whatever went wrong; rendering its prose would work today and would leak the
 * day somebody makes one of those branches more helpful.
 */
const REFUSED = 'That email and password do not match an account. Check both and try again.';

export function SignInScreen(): ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => loginRequest(api, { email, password }),
    onSuccess: (profile) => {
      // The login response *is* the profile, so the session is known without a second
      // request — and the shell re-renders into the console rather than flashing its
      // resolving state on the way there.
      queryClient.setQueryData(SESSION_KEY, profile);
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!signIn.isPending) signIn.mutate();
  };

  return (
    <main className="ab-signin" id="main-content" tabIndex={-1}>
      <div className="ab-signin__card">
        <Lockup className="ab-signin__lockup" title={`${APP_NAME} ${SURFACE_NAME}`} />

        <h1 className="ab-signin__title" id="page-heading" tabIndex={-1}>
          Sign in
        </h1>
        <p className="ab-signin__lede">{SURFACE_NAME}. Candidates do not sign in here.</p>

        {signIn.isError ? (
          <Alert tone="danger" title="Sign-in failed" live="assertive">
            <p>{REFUSED}</p>
          </Alert>
        ) : null}

        <form className="ab-signin__form" onSubmit={submit} noValidate>
          <Field label="Email" id={`${fieldId}-email`} required>
            {(control) => (
              <Input
                {...control}
                type="email"
                // The browser's own credential handling. A console that opts out of it
                // teaches people to type passwords by hand, which is how they get shorter.
                autoComplete="username"
                value={email}
                onChange={(event) => {
                  setEmail(event.currentTarget.value);
                }}
              />
            )}
          </Field>

          <Field label="Password" id={`${fieldId}-password`} required>
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.currentTarget.value);
                }}
              />
            )}
          </Field>

          <Button type="submit" tone="primary" busy={signIn.isPending}>
            Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
