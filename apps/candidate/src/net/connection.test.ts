/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';

import { CONNECTION_MESSAGES, ConnectionMonitor } from './connection';

describe('ConnectionMonitor', () => {
  it('starts online and silent', () => {
    const snapshot = new ConnectionMonitor().getSnapshot();
    expect(snapshot.state).toBe('online');
    expect(snapshot.pendingWrites).toBe(0);
    expect(snapshot.announcement).toBeNull();
  });

  it('announces going offline with what it means for the candidate’s work', () => {
    const monitor = new ConnectionMonitor();
    monitor.goOffline();

    // "Offline" alone is a status. The candidate is asking whether the last twenty
    // minutes still exist, and this is the sentence that answers them.
    expect(monitor.getSnapshot().state).toBe('offline');
    expect(monitor.getSnapshot().announcement).toEqual({
      region: 'polite',
      message: CONNECTION_MESSAGES.offline,
    });
  });

  it('does not re-announce while it stays offline', () => {
    const monitor = new ConnectionMonitor();
    const listener = vi.fn();
    monitor.subscribe(listener);

    monitor.goOffline();
    monitor.goOffline();
    monitor.goOffline();

    // A backoff loop that retries every two seconds must not narrate itself.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('waits for the buffer to drain before saying everything is saved', () => {
    const monitor = new ConnectionMonitor();

    monitor.goOffline();
    monitor.noteBufferedWrite();
    monitor.noteBufferedWrite();
    expect(monitor.getSnapshot().pendingWrites).toBe(2);

    monitor.beginReconnect();
    expect(monitor.getSnapshot().state).toBe('reconnecting');

    // The transport is back, but two answers are still only on this device. Telling the
    // candidate "all answers saved" here would be a reassurance we cannot yet make.
    monitor.goOnline();
    expect(monitor.getSnapshot().state).toBe('syncing');
    expect(monitor.getSnapshot().announcement).toBeNull();

    monitor.noteFlushedWrite();
    expect(monitor.getSnapshot().state).toBe('syncing');

    monitor.noteFlushedWrite();
    expect(monitor.getSnapshot().state).toBe('online');
    expect(monitor.getSnapshot().pendingWrites).toBe(0);
    expect(monitor.getSnapshot().announcement).toEqual({
      region: 'polite',
      message: CONNECTION_MESSAGES.reconnected,
    });
  });

  it('goes straight back to online when nothing was buffered', () => {
    const monitor = new ConnectionMonitor();
    monitor.goOffline();
    monitor.goOnline();

    expect(monitor.getSnapshot().state).toBe('online');
    expect(monitor.getSnapshot().announcement?.message).toBe(CONNECTION_MESSAGES.reconnected);
  });

  it('never announces a routine save', () => {
    const monitor = new ConnectionMonitor();

    monitor.noteBufferedWrite();
    monitor.noteFlushedWrite();

    // Autosave fires within five seconds of the last change (FR-9). Announcing each
    // success means a screen-reader user hears "Saved" every five seconds for an hour,
    // over the top of whatever they were actually reading (docs/15 §5.2).
    expect(monitor.getSnapshot().announcement).toBeNull();
    expect(monitor.getSnapshot().state).toBe('online');
  });

  it('notifies subscribers and stops when unsubscribed', () => {
    const monitor = new ConnectionMonitor();
    const listener = vi.fn();
    const unsubscribe = monitor.subscribe(listener);

    monitor.goOffline();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    monitor.goOnline();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never drops the pending count below zero', () => {
    const monitor = new ConnectionMonitor();
    monitor.noteFlushedWrite();
    expect(monitor.getSnapshot().pendingWrites).toBe(0);
  });
});
