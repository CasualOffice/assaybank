/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The guard (`H-177`).
 *
 * Three states, and the assertions are about keeping them three. The row this closes says an
 * unresolved principal must never reach a screen; what that means in practice is that the
 * console chrome is absent in two of the three states, and a test that only checked "does the
 * login form appear" would pass on a build that drew the sidebar behind it.
 */

import { LiveRegionProvider } from '@assaybank/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApiProvider } from '../api/api.js';
import { ApiClient, ApiRequestError } from '../api/client.js';
import { createQueryClient } from '../api/queryClient.js';
import { isUnauthenticated, SESSION_KEY, type StaffProfile } from '../api/session.js';
import { SessionGate } from './SessionGate.js';

const PROFILE: StaffProfile = {
  user: {
    id: '11111111-0000-4000-8000-000000000001',
    email: 'ada@acme.example',
    full_name: 'Ada Lovelace',
    timezone: 'Europe/London',
  },
  org: { id: '22222222-0000-4000-8000-000000000001', name: 'Acme', slug: 'acme' },
  permissions: ['question.read', 'question.write'],
  server_time: '2026-09-20T09:00:00.000Z',
};

const CONSOLE = 'THE CONSOLE SHELL';

/** A client whose queries neither retry nor go stale during a test. */
const freshClient = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

/** Renders the gate against a client already in the state under test. */
function render(client: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ApiProvider client={new ApiClient({ baseUrl: '/api/v1' })}>
        <LiveRegionProvider>
          <SessionGate>{() => <div>{CONSOLE}</div>}</SessionGate>
        </LiveRegionProvider>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const text = (markup: string): string =>
  markup
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&#x27;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ');

const unauthenticated = (): ApiRequestError =>
  new ApiRequestError(
    { error: { code: 'unauthenticated', message: 'Sign in.', request_id: 'r' } },
    401,
  );

describe('resolving', () => {
  const markup = render(freshClient());

  it('renders neither the console nor the sign-in form', () => {
    // The state everybody collapses. Showing the console here is a shell around an empty
    // session; showing sign-in flashes a login form at a signed-in user on every reload.
    expect(text(markup)).not.toContain(CONSOLE);
    expect(text(markup)).not.toContain('Sign in');
  });

  it('says what it is doing, for anyone who cannot see that it is doing nothing', () => {
    expect(markup).toContain('aria-live="polite"');
    expect(text(markup)).toContain('Checking your session');
  });
});

// Put the session query into a real error state by letting a real fetch fail, rather than by
// writing cache internals — a hand-built state is a state the library need not agree with, and
// these tests are about what the gate does with the library's own answer. At module level
// because `describe` takes a synchronous callback.
const refused = freshClient();
await refused
  .fetchQuery({ queryKey: SESSION_KEY, queryFn: () => Promise.reject(unauthenticated()) })
  .catch(() => undefined);

describe('absent', () => {
  const markup = render(refused);

  it('shows sign-in and none of the console chrome', () => {
    expect(text(markup)).toContain('Sign in');
    expect(text(markup)).not.toContain(CONSOLE);
    // The specific failure the tracker row names: a shell around an empty session.
    expect(markup).not.toContain('ab-console__sidebar');
    expect(markup).not.toContain('ab-console__nav');
  });

  it('refuses without naming which half was wrong', () => {
    // docs/14 H-176: a login that distinguishes "no such user" from "wrong password"
    // enumerates the staff list, and the server already answers both identically.
    expect(text(markup)).not.toContain('No such');
    expect(text(markup)).not.toContain('Unknown email');
  });
});

describe('present', () => {
  const client = freshClient();
  client.setQueryData(SESSION_KEY, PROFILE);
  const markup = render(client);

  it('renders the console', () => {
    expect(text(markup)).toContain(CONSOLE);
    expect(text(markup)).not.toContain('Checking your session');
  });
});

describe('a 401 from any other screen', () => {
  it('clears the session, so the gate falls back to sign-in', async () => {
    const client = createQueryClient();
    client.setQueryData(SESSION_KEY, PROFILE);

    // A question-bank query fails the way an expired session makes it fail.
    await client
      .fetchQuery({
        queryKey: ['questions', { page: 1 }],
        queryFn: () => Promise.reject(unauthenticated()),
        retry: false,
      })
      .catch(() => undefined);

    expect(client.getQueryData(SESSION_KEY)).toBeUndefined();
  });

  it('does not clear it on a failure that is not about identity', async () => {
    const client = createQueryClient();
    client.setQueryData(SESSION_KEY, PROFILE);

    await client
      .fetchQuery({
        queryKey: ['questions', { page: 2 }],
        queryFn: () =>
          Promise.reject(
            new ApiRequestError(
              { error: { code: 'internal', message: 'Boom.', request_id: 'r' } },
              500,
            ),
          ),
        retry: false,
      })
      .catch(() => undefined);

    // Signing somebody out because the bank list 500'd would be a worse bug than the 500.
    expect(client.getQueryData(SESSION_KEY)).toEqual(PROFILE);
  });

  it('does not clear the session when the session query itself fails', async () => {
    // Removing the entry whose error state the gate is reading would put the gate back into
    // "resolving" — a spinner that never resolves.
    const client = createQueryClient();

    await client
      .fetchQuery({
        queryKey: SESSION_KEY,
        queryFn: () => Promise.reject(unauthenticated()),
        retry: false,
      })
      .catch(() => undefined);

    expect(client.getQueryCache().find({ queryKey: SESSION_KEY })?.state.status).toBe('error');
  });
});

describe('isUnauthenticated', () => {
  it('branches on the code rather than on the status or the message', () => {
    expect(isUnauthenticated(unauthenticated())).toBe(true);
    expect(
      isUnauthenticated(
        new ApiRequestError({ error: { code: 'forbidden', message: 'No.', request_id: 'r' } }, 403),
      ),
    ).toBe(false);
    expect(isUnauthenticated(new Error('unauthenticated'))).toBe(false);
    expect(isUnauthenticated(undefined)).toBe(false);
  });
});
