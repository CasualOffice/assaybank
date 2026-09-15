/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shell rendering tests.
 *
 * Rendered with `react-dom/server` rather than a DOM harness: jsdom and
 * `@testing-library/react` are both outside the ADR-001 dependency allow-list, and the
 * shell is pure and synchronous precisely so that this is possible. What cannot be
 * asserted from static markup — focus order, the skip link appearing on focus, axe —
 * belongs to the Playwright suite from P0 step 12 and is noted where it applies.
 */

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ConnectionSnapshot } from '../net/connection';
import type { CountdownSnapshot } from '../time/countdown';
import type { AnnouncerSnapshot } from './announcer';
import { AppShell } from './app-shell';
import { LIVE_REGION_IDS } from './live-regions';

const MINUTE = 60_000;

const ONLINE: ConnectionSnapshot = { state: 'online', pendingWrites: 0, announcement: null };
const NO_ANNOUNCEMENTS: AnnouncerSnapshot = { polite: '', assertive: '' };

function countdown(remaining: number): CountdownSnapshot {
  return {
    remainingMs: remaining,
    remainingSeconds: Math.ceil(remaining / 1_000),
    expired: remaining <= 0,
    deadlineAtMs: Date.parse('2026-10-12T09:45:00.000Z'),
    totalMs: 45 * MINUTE,
  };
}

interface RenderOverrides {
  /** Present-and-null is meaningful (no deadline yet), so this is not merged with `??`. */
  readonly countdown?: CountdownSnapshot | null;
  readonly connection?: ConnectionSnapshot;
  readonly announcements?: AnnouncerSnapshot;
  readonly routeAnnouncement?: string;
  readonly children?: ReactNode;
}

function render(overrides: RenderOverrides = {}): string {
  return renderToStaticMarkup(
    <AppShell
      countdown={overrides.countdown === undefined ? countdown(30 * MINUTE) : overrides.countdown}
      connection={overrides.connection ?? ONLINE}
      announcements={overrides.announcements ?? NO_ANNOUNCEMENTS}
      routeAnnouncement={overrides.routeAnnouncement ?? ''}
    >
      {overrides.children ?? <h1>Assessment</h1>}
    </AppShell>,
  );
}

describe('AppShell — the accessibility baseline every screen inherits', () => {
  it('renders the skip link before anything else focusable', () => {
    const html = render();
    const skipLink = html.indexOf('href="#main-content"');
    const firstButton = html.indexOf('<button');

    expect(skipLink).toBeGreaterThan(-1);
    expect(html).toContain('Skip to content');
    // A skip link that is not first is a skip link you have to tab past something to
    // reach, which is the thing it exists to avoid.
    expect(skipLink).toBeLessThan(firstButton);
  });

  it('renders exactly one main landmark, programmatically focusable', () => {
    const html = render();
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toContain('id="main-content"');
    // tabIndex=-1 so a route change can move focus here without putting an inert
    // container into the tab order.
    expect(html).toContain('tabindex="-1"');
  });

  it('mounts the three live regions, empty', () => {
    const html = render();

    for (const id of Object.values(LIVE_REGION_IDS)) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-live="assertive"');
    // Empty at mount: a region created at the same moment its content changes is
    // frequently not announced at all (docs/15 §5.1).
    for (const id of Object.values(LIVE_REGION_IDS)) {
      expect(html).toMatch(new RegExp(`<div id="${id}"[^>]*></div>`));
    }
    expect(html).not.toContain('>undefined<');
  });

  it('publishes announcements into the regions it was given', () => {
    const html = render({
      announcements: { polite: 'Your answer is saved.', assertive: '1 minute remaining.' },
      routeAnnouncement: 'Assessment',
    });

    expect(html).toContain('Your answer is saved.');
    expect(html).toContain('1 minute remaining.');
  });

  it('carries no staff navigation of any kind', () => {
    const html = render();

    // Not "hidden behind a role check" — absent. A route guard gates rendering, not the
    // bundle (ADR-013), so the shell for the candidate application does not link to a
    // staff surface at all.
    for (const staffPath of [
      '/bank',
      '/assessments',
      '/candidates',
      '/reports',
      '/admin',
      '/scorecards',
      '/sessions',
      '/audit-log',
    ]) {
      expect(html).not.toContain(`href="${staffPath}`);
    }
    expect(html).not.toContain('<nav');
  });

  it('offers help in the same place on every screen (SC 3.2.6)', () => {
    expect(render()).toContain('Help and contact');
    expect(render({ children: <p>Anything else</p> })).toContain('Help and contact');
  });
});

describe('AppShell — the time-remaining region (ADR-006, docs/15 §3.3)', () => {
  it('renders a timer that is not itself a live region', () => {
    const html = render({ countdown: countdown(30 * MINUTE) });

    expect(html).toContain('role="timer"');
    expect(html).toContain('30:00');

    // The rule most often broken: a timer that announces every second renders a screen
    // reader useless for the hour the candidate most needs it.
    const timerTag = /<span[^>]*role="timer"[^>]*>/.exec(html)?.[0] ?? '';
    expect(timerTag).not.toContain('aria-live');
  });

  it('spells the remaining time out in the accessible name', () => {
    const html = render({ countdown: countdown(12 * MINUTE + 4_000) });
    expect(html).toContain('aria-label="Assessment time remaining: 12 minutes 4 seconds"');
  });

  it('marks low time with text and a glyph, never colour alone (SC 1.4.1)', () => {
    const calm = render({ countdown: countdown(30 * MINUTE) });
    const low = render({ countdown: countdown(4 * MINUTE) });

    expect(calm).not.toContain('time-remaining--warning');
    expect(low).toContain('time-remaining--warning');
    expect(low).toContain('Low time');
  });

  it('shows no countdown at all before the server has issued a deadline', () => {
    const html = render({ countdown: null });

    // A number the server did not authorise is a number that will be wrong.
    expect(html).not.toContain('role="timer"');
    expect(html).toContain('timer starts when you begin');
  });
});

describe('AppShell — the connection banner', () => {
  it('shows nothing while the connection is healthy', () => {
    expect(render({ connection: ONLINE })).not.toContain('connection-banner');
  });

  it('toggles on when the candidate goes offline, and says their work is safe', () => {
    const html = render({
      connection: { state: 'offline', pendingWrites: 3, announcement: null },
    });

    expect(html).toContain('data-state="offline"');
    expect(html).toContain('saved on this device');
    expect(html).toContain('3 changes are waiting to sync.');
    // Not a second live region: the announcement goes through the shared polite region
    // so it is subject to the same budget as everything else.
    const banner = /<section[^>]*connection-banner[^>]*>/.exec(html)?.[0] ?? '';
    expect(banner).not.toContain('aria-live');
    expect(banner).toContain('aria-label="Connection status"');
  });

  it('toggles back off once everything has synced', () => {
    const reconnecting = render({
      connection: { state: 'reconnecting', pendingWrites: 1, announcement: null },
    });
    const syncing = render({
      connection: { state: 'syncing', pendingWrites: 1, announcement: null },
    });
    const done = render({ connection: ONLINE });

    expect(reconnecting).toContain('data-state="reconnecting"');
    expect(reconnecting).toContain('1 change is waiting to sync.');
    expect(syncing).toContain('data-state="syncing"');
    expect(done).not.toContain('connection-banner');
  });

  it('renders before the main landmark so it is met on the way in', () => {
    const html = render({
      connection: { state: 'offline', pendingWrites: 0, announcement: null },
    });
    expect(html.indexOf('connection-banner')).toBeLessThan(html.indexOf('<main'));
  });
});
