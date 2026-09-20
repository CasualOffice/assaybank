/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The account block, and the sign-out failure that used to be silent (`H-193`).
 *
 * Watched in a browser against the real API: the sign-out request failed, the cache was
 * cleared as designed, the console re-fetched the session, got it — because the session was
 * never ended — and carried on exactly as before. The button appeared to do nothing, and the
 * person who pressed it on a shared machine had no way to know they were still signed in.
 *
 * Clearing the cache on a failure is right, and it is not the same as ending a session: the
 * session lives on the server. So the failure now says so, and these pin the wording.
 *
 * Rendered with `react-dom/server`, which is why the failure notice is its own component:
 * jsdom is not an approved dependency (ADR-001; `vitest.config.ts` has the reasoning), so
 * this workspace cannot click a button in a test. Pressing the button and seeing the message
 * appear belongs to the `@axe-core/playwright` suite of docs/15 §15.1 — what is covered here
 * is that the message exists, says the right thing, and is announced.
 */

import { LiveRegionProvider } from '@assaybank/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApiProvider } from '../api/api.js';
import { ApiClient } from '../api/client.js';
import { type StaffProfile } from '../api/session.js';
import { AccountMenu, SignOutFailure } from './AccountMenu.js';

const PROFILE: StaffProfile = {
  user: {
    id: '11111111-0000-4000-8000-000000000001',
    email: 'ada@example.test',
    full_name: 'Ada Lovelace',
    timezone: 'Europe/London',
  },
  org: { id: '22222222-0000-4000-8000-000000000001', name: 'Acme Talent', slug: 'acme' },
  permissions: ['question.read'],
  server_time: '2026-09-20T12:00:00.000Z',
};

function renderMenu(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ApiProvider
        client={
          new ApiClient({
            baseUrl: '/api/v1',
            fetch: () => Promise.reject(new Error('no request is made by a render')),
            csrfToken: () => undefined,
          })
        }
      >
        <LiveRegionProvider>
          <AccountMenu profile={PROFILE} />
        </LiveRegionProvider>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

const text = (markup: string): string =>
  markup
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&#x27;/gu, "'")
    .replace(/\s+/gu, ' ');

describe('the account block', () => {
  it('names the organisation above the person', () => {
    // A multi-tenant tool that never says which tenant you are in is one you cannot safely
    // act in, and "whose bank am I about to publish into" is the question actually asked.
    const body = text(renderMenu());

    expect(body.indexOf('Acme Talent')).toBeLessThan(body.indexOf('Ada Lovelace'));
  });

  it('says nothing about sign-out until a sign-out has failed', () => {
    // A warning that is always on screen is a warning nobody reads.
    expect(text(renderMenu())).not.toContain('Still signed in');
  });
});

describe('a sign-out that did not reach the server', () => {
  const markup = renderToStaticMarkup(
    <LiveRegionProvider>
      <SignOutFailure />
    </LiveRegionProvider>,
  );

  it('says the session is still open, which is the consequence rather than the cause', () => {
    // Not the server's prose. "Refused" describes the request; what the person needs to know
    // is that they are still signed in on this machine.
    const body = text(markup);

    expect(body).toContain('Sign-out did not reach the server');
    expect(body).toContain('Your session is still open');
    expect(body).toContain('close the browser');
  });

  it('is announced assertively, because it contradicts what the person just did', () => {
    // A polite live region waits for a pause in the screen reader's queue. This is the one
    // message on the screen that must not wait.
    expect(markup).toContain('aria-live="assertive"');
  });

  it('does not call itself an error', () => {
    // The `danger` tone labels itself "Error" by default, and this is not a malfunction —
    // it is the system reporting, correctly, that an action did not happen.
    expect(text(markup)).toContain('Still signed in');
    expect(text(markup)).not.toContain('ERROR');
  });
});
