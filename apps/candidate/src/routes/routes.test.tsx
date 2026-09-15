/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The placeholder routes, and the two things about them that are not placeholders:
 * they name the milestone that builds them, and they already respect the disclosure
 * rules that will still apply when the real screen replaces them.
 */

import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ConnectionMonitor } from '../net/connection';
import { ErrorBoundary } from '../shell/error-boundary';
import type { CandidateShellApi } from '../shell/shell-context';
import { CandidateShellProvider } from '../shell/shell-context';
import { AttemptRoute } from './attempt-route';
import { JoinRoute } from './join-route';
import { NotFoundRoute } from './not-found-route';
import { RedeemRoute } from './redeem-route';
import { WelcomeRoute } from './welcome-route';

function shellApi(): CandidateShellApi {
  return {
    announce: vi.fn(),
    setRouteAnnouncement: vi.fn(),
    setCountdownClock: vi.fn(),
    connection: new ConnectionMonitor(),
  };
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <CandidateShellProvider value={shellApi()}>{node}</CandidateShellProvider>,
  );
}

describe('placeholder routes', () => {
  it('each names the milestone that builds it', () => {
    expect(render(<RedeemRoute token="abc" />)).toContain('<strong>M1</strong>');
    expect(render(<AttemptRoute />)).toContain('M1 (multiple choice) and M2 (coding)');
    expect(render(<JoinRoute roomCode="TRY-4821" />)).toContain('<strong>M3</strong>');
  });

  it('each points at the document that specifies it', () => {
    // A placeholder that says only "coming soon" is indistinguishable from an unfinished
    // screen somebody forgot. These are auditable against project/ROADMAP.md.
    expect(render(<RedeemRoute token="abc" />)).toContain('docs/03-API-spec.md');
    expect(render(<AttemptRoute />)).toContain('ADR-004 and ADR-006');
    expect(render(<JoinRoute roomCode="TRY-4821" />)).toContain('docs/02-HLD.md');
  });
});

describe('/t/{token} — the invitation token', () => {
  it('never renders the token itself', () => {
    const token = 'inv_9f2c41d6b07e4a1fa3c85e77d2b09c14';
    const html = render(<RedeemRoute token={token} />);

    // It is a bearer credential for a whole attempt. Its length is enough to confirm
    // the link arrived intact; the value belongs nowhere but the URL.
    expect(html).not.toContain(token);
    expect(html).toContain('36 characters');
  });

  it('offers no puzzle, challenge or code entry (SC 3.3.8)', () => {
    const html = render(<RedeemRoute token="abc" />).toLowerCase();

    // A CAPTCHA on redemption is a cognitive function test standing between a candidate
    // and a job. Abuse is handled by per-IP rate limiting, never by escalating to a
    // challenge (docs/15 §2.3).
    for (const forbidden of ['captcha', 'verify you are human', 'enter the code', 'puzzle']) {
      expect(html).not.toContain(forbidden);
    }
  });
});

describe('/', () => {
  it('offers no sign-in, because a candidate has no account', () => {
    const html = render(<WelcomeRoute />).toLowerCase();

    for (const forbidden of ['password', 'sign in', 'log in', '<input']) {
      expect(html).not.toContain(forbidden);
    }
  });
});

describe('the not-found screen', () => {
  it('does not enumerate the routes it knows about', () => {
    const html = render(<NotFoundRoute />);

    // A 404 that helpfully lists the application's routes is a map handed to anyone who
    // guesses a URL, and this bundle is served to the open internet.
    for (const path of ['/attempt', '/join', '/t/', '/bank', '/admin']) {
      expect(html).not.toContain(`href="${path}`);
    }
  });
});

describe('the error boundary', () => {
  it('passes children through when nothing has failed', () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary>
        <p>The assessment</p>
      </ErrorBoundary>,
    );
    expect(html).toContain('The assessment');
  });

  it('switches to the fallback when a render throws', () => {
    // Error boundaries do not catch during server rendering — `renderToStaticMarkup`
    // rethrows — so the two halves are exercised directly rather than through a DOM
    // harness that is not on the ADR-001 dependency list.
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it('reports the failure to the observability tier without rendering it', () => {
    const onError = vi.fn();
    const boundary = new ErrorBoundary({ children: null, onError });
    const failure = new Error('ENOENT: /srv/assaybank/apps/candidate/src/secret-module.ts');

    boundary.componentDidCatch(failure, { componentStack: '\n    at Runner (attempt.tsx:41)' });
    expect(onError).toHaveBeenCalledWith(failure, '\n    at Runner (attempt.tsx:41)');

    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render() as ReactElement);

    expect(html).toContain('Your answers are saved.');
    expect(html).toContain('role="alert"');
    // A stack trace here names internal modules in front of an untrusted user on an
    // internet-facing origin. The trace id in the error envelope is what a support
    // ticket needs, and the candidate never has to read it.
    expect(html).not.toContain('secret-module');
    expect(html).not.toContain('ENOENT');
    expect(html).not.toContain('attempt.tsx');
  });
});
