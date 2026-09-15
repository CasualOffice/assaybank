/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Connection state for the candidate runner.
 *
 * ## Why this is a first-class module and not a boolean
 *
 * FR-9 requires autosave within five seconds of the last change and lossless resume
 * after disconnection, and CODE-GRAPH lists "buffers autosaves locally and replays them
 * on reconnect" among this application's invariants. A candidate losing work is the
 * failure that ends trust in an assessment platform — there is no apology for it, and no
 * way to give the time back.
 *
 * docs/15 §3.4 makes the same point from the accessibility side, and it is the sharper
 * version: a candidate using speech recognition, a switch device or an on-screen
 * keyboard produces input slowly and irrecoverably. Five lost minutes is a far larger
 * proportional loss for them than for a fast typist, and it happens while a server-owned
 * clock keeps running.
 *
 * So the connection has four states rather than two, and the banner tells the candidate
 * which one they are in and what it means for their work. "Offline" alone is a status;
 * "offline, your work is being saved on this device" is an answer.
 *
 * This module is pure: no `navigator`, no `fetch`, no event listeners. The browser
 * wiring lives in `use-connection.ts`, so the state machine is testable without a DOM.
 */

/**
 * The four states, in the order a bad network walks through them.
 *
 * `syncing` is separate from `online` on purpose. The moment the socket comes back is
 * not the moment the candidate's work is safe; the buffered writes still have to land,
 * and telling someone "reconnected" while their answers are still in a local buffer is a
 * reassurance the application cannot yet make.
 */
export type ConnectionState = 'online' | 'offline' | 'reconnecting' | 'syncing';

/** What the banner renders and what the live regions announce. */
export interface ConnectionSnapshot {
  readonly state: ConnectionState;
  /** Edits captured locally and not yet acknowledged by the server. */
  readonly pendingWrites: number;
  /**
   * The announcement owed to the candidate for the transition that produced this
   * snapshot, or `null` when the transition is not one docs/15 §5.2 announces.
   *
   * Routine success is silent. Only entries into and exits from the failure state are
   * announced, because those are the only ones where the candidate might need to act.
   */
  readonly announcement: ConnectionAnnouncement | null;
}

/** An announcement bound for one of the two regions in docs/15 §5.1. */
export interface ConnectionAnnouncement {
  readonly region: 'polite' | 'assertive';
  readonly message: string;
}

/**
 * The wording, lifted verbatim from the table in docs/15 §5.2.
 *
 * Verbatim matters. The strings were chosen to say what the candidate needs — that their
 * work is safe — rather than to describe the network, and a paraphrase drifts back
 * towards describing the network.
 */
export const CONNECTION_MESSAGES = {
  offline:
    'You are offline. Your work is being saved on this device and will sync when you reconnect.',
  reconnected: 'Reconnected. All answers saved.',
  reconnecting: 'Reconnecting. Your work is being saved on this device.',
} as const;

/** The visible banner text, which is not the same string as the announcement. */
export const CONNECTION_BANNER_TEXT: Readonly<Record<ConnectionState, string | null>> = {
  online: null,
  offline: 'You are offline. Your work is saved on this device and will sync when you reconnect.',
  reconnecting: 'Reconnecting. Your work is saved on this device.',
  syncing: 'Reconnected. Saving your work to the server.',
};

const INITIAL: ConnectionSnapshot = { state: 'online', pendingWrites: 0, announcement: null };

/**
 * A subscribable connection state machine.
 *
 * Plain class, same reasoning as `CountdownClock`: the transitions are the part worth
 * testing, and they should be testable without a renderer.
 */
export class ConnectionMonitor {
  readonly #listeners = new Set<() => void>();
  #snapshot: ConnectionSnapshot = INITIAL;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): ConnectionSnapshot => this.#snapshot;

  /** The network went away, or a request failed in a way that means it has. */
  goOffline(): void {
    if (this.#snapshot.state === 'offline') return;
    this.#set({
      state: 'offline',
      pendingWrites: this.#snapshot.pendingWrites,
      announcement: { region: 'polite', message: CONNECTION_MESSAGES.offline },
    });
  }

  /**
   * A reconnection attempt is in flight.
   *
   * Announced politely and only on the way in, so a backoff loop that retries every two
   * seconds does not narrate itself.
   */
  beginReconnect(): void {
    if (this.#snapshot.state === 'reconnecting' || this.#snapshot.state === 'syncing') return;
    this.#set({
      state: 'reconnecting',
      pendingWrites: this.#snapshot.pendingWrites,
      announcement: { region: 'polite', message: CONNECTION_MESSAGES.reconnecting },
    });
  }

  /**
   * The transport is back.
   *
   * If anything is buffered the state becomes `syncing`, not `online`, and stays there
   * until the buffer drains. The candidate is told "all answers saved" once, when it is
   * true.
   */
  goOnline(): void {
    if (this.#snapshot.pendingWrites > 0) {
      if (this.#snapshot.state === 'syncing') return;
      this.#set({
        state: 'syncing',
        pendingWrites: this.#snapshot.pendingWrites,
        announcement: null,
      });
      return;
    }
    if (this.#snapshot.state === 'online') return;
    this.#set({
      state: 'online',
      pendingWrites: 0,
      announcement: { region: 'polite', message: CONNECTION_MESSAGES.reconnected },
    });
  }

  /** An edit was captured locally and is not yet acknowledged by the server. */
  noteBufferedWrite(): void {
    this.#set({
      state: this.#snapshot.state,
      pendingWrites: this.#snapshot.pendingWrites + 1,
      announcement: null,
    });
  }

  /**
   * The server acknowledged one buffered write.
   *
   * Draining the last one while syncing is the moment — and the only moment — the
   * "Reconnected. All answers saved." announcement is honest, so it is made here.
   */
  noteFlushedWrite(): void {
    const pending = Math.max(0, this.#snapshot.pendingWrites - 1);
    if (pending === 0 && this.#snapshot.state === 'syncing') {
      this.#set({
        state: 'online',
        pendingWrites: 0,
        announcement: { region: 'polite', message: CONNECTION_MESSAGES.reconnected },
      });
      return;
    }
    this.#set({ state: this.#snapshot.state, pendingWrites: pending, announcement: null });
  }

  #set(next: ConnectionSnapshot): void {
    const previous = this.#snapshot;
    if (
      next.state === previous.state &&
      next.pendingWrites === previous.pendingWrites &&
      next.announcement === previous.announcement
    ) {
      return;
    }
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}
