/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/candidate — the assessment runner and interview join surface.
 *
 * Owns: token redemption at /t/{token}, the attempt runner under /attempt/*, and the
 * interview join at /join/{room_code}.
 *
 * A separate bundle from apps/web on purpose: no shared chunk may carry staff routes,
 * bank queries or correct-answer logic, and it may not import db, auth, core-domain,
 * grading or exec-adapter (CODE-GRAPH L5, ADR-013). That is enforced three ways, not
 * documented and hoped for:
 *
 *   1. `eslint.config.js` in this workspace, and the matching block in the root config.
 *   2. `scripts/check-bundle.mjs`, which greps the *built* output for staff-only markers
 *      and fails the build if it finds one. A lint rule catches the import a developer
 *      writes; the bundle check catches the one a bundler resolves.
 *   3. The dependency closure itself — this workspace declares exactly two internal
 *      dependencies, `@assaybank/contracts` and `@assaybank/ui`.
 *
 * The countdown is derived from `server_time` and never from the local clock (ADR-006);
 * autosaves are buffered locally and replayed on reconnect so a bad network cannot lose
 * work; proctoring signals are emitted as advisory telemetry only and no integrity
 * verdict is rendered here (ADR-007).
 *
 * This module is the workspace's only entry point. `main.tsx` is the browser entry and is
 * not exported from here — an app is never imported by anything (CODE-GRAPH L1, L4), so
 * what follows exists for the workspace's own tests and for the root-level leak suite.
 */

export {
  COUNTDOWN_THRESHOLDS,
  CountdownClock,
  announcementForThreshold,
  formatRemaining,
  formatRemainingForSpeech,
  remainingMs,
  thresholdBoundaryMs,
  thresholdsCrossed,
} from './time/countdown';
export type {
  Announcement,
  AnnouncementRegion,
  CountdownClockOptions,
  CountdownSnapshot,
  CountdownThreshold,
  RemainingInputs,
  ServerTimeSample,
} from './time/countdown';

export { browserMonotonic, sampleServerTime, useCountdown } from './time/use-countdown';

export { CONNECTION_BANNER_TEXT, CONNECTION_MESSAGES, ConnectionMonitor } from './net/connection';
export type { ConnectionAnnouncement, ConnectionSnapshot, ConnectionState } from './net/connection';
export { useConnection } from './net/use-connection';

export { ANNOUNCEMENT_BUDGET_MS, Announcer, createBrowserAnnouncer } from './shell/announcer';
export type { AnnouncerChannel, AnnouncerOptions, AnnouncerSnapshot } from './shell/announcer';

export { ACCESSIBILITY_HREF, AppShell, HELP_HREF } from './shell/app-shell';
export type { AppShellProps } from './shell/app-shell';
export { CandidateShell } from './shell/candidate-shell';
export { ConnectionBanner } from './shell/connection-banner';
export { ErrorBoundary } from './shell/error-boundary';
export { LIVE_REGION_IDS, LiveRegions } from './shell/live-regions';
export {
  CandidateShellProvider,
  useCandidateShell,
  useRouteAnnouncement,
} from './shell/shell-context';
export type { CandidateShellApi } from './shell/shell-context';
export { TimeRemaining } from './shell/time-remaining';

export { CANDIDATE_ROUTE_PATHS, createCandidateRouter } from './router';
export type { CandidateRouter } from './router';

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth, and so this module has a
 * real export from the first commit.
 */
export const WORKSPACE_NAME = '@assaybank/candidate';
