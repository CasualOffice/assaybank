/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The container that owns the shell's three stores and feeds {@link AppShell}.
 *
 * The split is deliberate: `AppShell` is pure and renders under `react-dom/server` in a
 * plain Node test, and everything stateful — the countdown clock, the connection state
 * machine, the announcement queue — is created and subscribed here. That way the
 * rendering is testable without a DOM and the state machines are testable without a
 * renderer, which between them covers the behaviour that matters.
 *
 * The client clock is DISPLAY ONLY; the server owns the deadline (ADR-006). This
 * component installs whatever clock a route hands it through the shell context and never
 * constructs one from local time.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { ConnectionMonitor } from '../net/connection';
import { useConnection } from '../net/use-connection';
import type { CountdownClock } from '../time/countdown';
import { formatRemainingForSpeech } from '../time/countdown';
import { useCountdown } from '../time/use-countdown';
import type { AnnouncerChannel } from './announcer';
import { createBrowserAnnouncer } from './announcer';
import { AppShell } from './app-shell';
import type { CandidateShellApi } from './shell-context';
import { CandidateShellProvider } from './shell-context';

export interface CandidateShellProps {
  readonly children?: ReactNode;
}

export function CandidateShell(props: CandidateShellProps): ReactNode {
  // Lazy initialisers, so StrictMode's double render does not build two of each.
  const [monitor] = useState(() => new ConnectionMonitor());
  const [announcer] = useState(() => createBrowserAnnouncer());
  const [clock, setClock] = useState<CountdownClock | null>(null);
  const [routeAnnouncement, setRouteAnnouncement] = useState('');

  const connection = useConnection(monitor);
  const countdown = useCountdown(clock);
  const announcements = useSyncExternalStore(
    announcer.subscribe,
    announcer.getSnapshot,
    announcer.getSnapshot,
  );

  useEffect(
    () => () => {
      announcer.dispose();
    },
    [announcer],
  );

  const announce = useCallback(
    (channel: AnnouncerChannel, message: string) => {
      announcer.announce(channel, message);
    },
    [announcer],
  );

  // Only transitions into and out of the failure states are announced; routine success
  // is silent (docs/15 §5.2). The state machine decides which, so this is a pass-through.
  useEffect(() => {
    if (connection.announcement === null) return;
    announcer.announce(connection.announcement.region, connection.announcement.message);
  }, [announcer, connection.announcement]);

  /**
   * The on-demand status summary (docs/15 §5.3).
   *
   * This is what makes the silence elsewhere defensible: withholding announcements is
   * only reasonable if the information is reachable on request. Question counts join it
   * in M1, when there are questions.
   */
  const onRequestStatus = useCallback(() => {
    const time =
      countdown === null
        ? 'The assessment has not started.'
        : countdown.expired
          ? 'No time remaining.'
          : `Time remaining: ${formatRemainingForSpeech(countdown.remainingMs)}.`;
    const link =
      connection.state === 'online'
        ? 'Connected. Your work is saved.'
        : `Connection: ${connection.state}. ${
            connection.pendingWrites === 1
              ? '1 change is waiting to sync.'
              : `${String(connection.pendingWrites)} changes are waiting to sync.`
          }`;
    announcer.announce('polite', `${time} ${link}`);
  }, [announcer, connection.pendingWrites, connection.state, countdown]);

  const api = useMemo<CandidateShellApi>(
    () => ({
      announce,
      setRouteAnnouncement,
      setCountdownClock: setClock,
      connection: monitor,
    }),
    [announce, monitor],
  );

  return (
    <CandidateShellProvider value={api}>
      <AppShell
        countdown={countdown}
        connection={connection}
        announcements={announcements}
        routeAnnouncement={routeAnnouncement}
        onRequestStatus={onRequestStatus}
      >
        {props.children}
      </AppShell>
    </CandidateShellProvider>
  );
}
