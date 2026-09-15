/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One Yjs document per interview room, and the peers attached to it (ADR-005, HLD §3.3).
 *
 * **The room is keyed by the session the ticket names, never by the path segment the
 * client typed.** A ticket admits its holder to exactly one session; if the document were
 * keyed by the client-supplied room code, a valid ticket for session A would open the
 * document of room B. The path segment is still required and still validated — it is what
 * a person shares and what a log line is searched by — but it is not what decides which
 * document you get. P5 resolves `room_code → session_id` against `interview_sessions` and
 * refuses a mismatch outright; until that table is readable from here, deriving the key
 * from the credential is the version of this that cannot be wrong.
 *
 * **What is deliberately not here.** No snapshotting to `interview_sessions.doc_state`, no
 * `session_events` append, no Valkey fan-out. Those are P5, and each is the reason this
 * registry keeps a room alive for a short while after the last peer leaves: today that
 * grace window is all that survives a candidate's tunnel dropping, and when the snapshot
 * exists it becomes an optimisation rather than the guarantee.
 */

import { Doc } from 'yjs';

/** How long a room is kept after its last peer disconnects. */
export const DEFAULT_ROOM_RETENTION_MS = 5 * 60 * 1000;

/** A peer attached to a room: whatever the registry needs to fan a frame out to it. */
export interface RoomPeer {
  /** Sends one binary frame. Implementations must not throw on a closed socket. */
  send(frame: Uint8Array): void;
}

/**
 * One live document and its peers.
 *
 * `Room` owns no I/O and no socket: it is handed peers that can `send`, which is what
 * lets the server's connection handling be tested without reaching in here.
 */
export class Room {
  /** The peers currently attached. */
  public readonly peers = new Set<RoomPeer>();

  /** The awareness payload each peer last published, replayed to whoever joins next. */
  public readonly lastAwareness = new Map<RoomPeer, Uint8Array>();

  /** The document. Empty until a peer sends the first update; nothing seeds it in P0. */
  public readonly doc: Doc;

  /** True once a peer has ever attached, which is what makes the next arrival a rejoin. */
  private joined = false;

  /** Set while the room is empty and waiting to be collected. */
  private reaper: NodeJS.Timeout | undefined;

  public constructor(public readonly key: string) {
    this.doc = new Doc({ guid: key });
  }

  /** True when this peer is not the first ever to attach to this room. */
  public get hasBeenJoined(): boolean {
    return this.joined;
  }

  /** Marks the room as having had a peer. Called by the registry on attach. */
  public markJoined(): void {
    this.joined = true;
  }

  /** Cancels a pending collection, if any. */
  public cancelReaper(): void {
    if (this.reaper !== undefined) {
      clearTimeout(this.reaper);
      this.reaper = undefined;
    }
  }

  /** Schedules collection. Unreferenced, so an idle room never holds the process open. */
  public scheduleReaper(delayMs: number, collect: () => void): void {
    this.cancelReaper();
    const timer = setTimeout(collect, delayMs);
    timer.unref();
    this.reaper = timer;
  }

  /** Sends `frame` to every peer except `origin`. */
  public broadcast(frame: Uint8Array, origin: RoomPeer | undefined): void {
    for (const peer of this.peers) {
      if (peer === origin) continue;
      peer.send(frame);
    }
  }

  /** Releases the document. After this the room must not be used again. */
  public destroy(): void {
    this.cancelReaper();
    this.peers.clear();
    this.lastAwareness.clear();
    this.doc.destroy();
  }
}

/** The rooms this instance is holding. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  public constructor(
    private readonly retentionMs: number = DEFAULT_ROOM_RETENTION_MS,
    /** Called whenever the room count changes, so the gauge has one place to be set from. */
    private readonly onSizeChanged: (size: number) => void = () => undefined,
  ) {}

  /** How many documents are held, including empty rooms awaiting collection. */
  public get size(): number {
    return this.rooms.size;
  }

  /** The room for `key`, created if this instance is not already holding it. */
  public acquire(key: string): Room {
    const existing = this.rooms.get(key);
    if (existing !== undefined) {
      existing.cancelReaper();
      return existing;
    }

    const room = new Room(key);
    this.rooms.set(key, room);
    this.onSizeChanged(this.rooms.size);
    return room;
  }

  /** Attaches `peer` to `room`. Returns true when this is a rejoin rather than a first join. */
  public attach(room: Room, peer: RoomPeer): boolean {
    const rejoin = room.hasBeenJoined;
    room.cancelReaper();
    room.peers.add(peer);
    room.markJoined();
    return rejoin;
  }

  /**
   * Detaches `peer`. An emptied room is kept for the retention window rather than dropped,
   * so a peer whose network blinked rejoins the document it left instead of an empty one.
   */
  public detach(room: Room, peer: RoomPeer): void {
    room.peers.delete(peer);
    room.lastAwareness.delete(peer);
    if (room.peers.size > 0) return;

    room.scheduleReaper(this.retentionMs, () => {
      if (room.peers.size === 0) this.release(room.key);
    });
  }

  /** Drops a room and its document immediately. */
  public release(key: string): void {
    const room = this.rooms.get(key);
    if (room === undefined) return;
    this.rooms.delete(key);
    room.destroy();
    this.onSizeChanged(this.rooms.size);
  }

  /** Drops every room. Called on shutdown, after the sockets have been closed. */
  public clear(): void {
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
    this.onSizeChanged(0);
  }
}
