/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * React and browser wiring for {@link ConnectionMonitor}.
 *
 * The state machine is in `connection.ts` and knows nothing about the browser. This file
 * is the only place that touches `navigator.onLine` and the `online`/`offline` events,
 * which keeps the transitions testable and keeps the well-known unreliability of
 * `navigator.onLine` in exactly one place.
 *
 * `navigator.onLine` reports whether there is a network interface, not whether the API
 * is reachable — a captive portal, a dropped VPN and a dead backend all read as "online".
 * It is therefore treated as a hint that moves the state machine, never as the source of
 * truth. From M1 the authority is a failed request or a closed socket calling
 * `goOffline()` directly; this listener only makes the common case fast.
 */

import { useEffect, useSyncExternalStore } from 'react';

import type { ConnectionMonitor, ConnectionSnapshot } from './connection';

/** Subscribe to the monitor and mirror the browser's own coarse signal into it. */
export function useConnection(monitor: ConnectionMonitor): ConnectionSnapshot {
  const snapshot = useSyncExternalStore(
    monitor.subscribe,
    monitor.getSnapshot,
    monitor.getSnapshot,
  );

  useEffect(() => {
    const handleOffline = (): void => {
      monitor.goOffline();
    };
    const handleOnline = (): void => {
      monitor.goOnline();
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    // The listeners only fire on a change, so an application that mounts while already
    // offline would otherwise render as online until the network came back.
    if (!navigator.onLine) monitor.goOffline();
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [monitor]);

  return snapshot;
}
