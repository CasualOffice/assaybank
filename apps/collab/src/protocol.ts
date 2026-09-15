/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The y-websocket wire format: `lib0` variable-length integers wrapping the Yjs sync
 * protocol and the awareness protocol (ADR-005).
 *
 * **Why this is written out rather than imported.** `y-websocket@3` ships only the
 * browser provider; the server helpers that used to live in `y-websocket/bin/utils`
 * moved to a separate package, and the encoders they used (`lib0`, `y-protocols`) are
 * transitive dependencies of the provider rather than dependencies this workspace
 * declares. Reaching through a transitive dependency is how a patch release of somebody
 * else's package breaks an interview, so the framing — which is forty lines of base-128
 * integers and a message tag — is implemented here against the published format and
 * pinned by the round-trip tests next to it.
 *
 * The format is not ours to choose. Every constant below is the value a stock
 * `y-websocket` browser client sends, so this module is a transcription, not a design:
 *
 * ```
 * message   := varUint(messageType) payload
 * sync      := varUint(0) varUint(syncStep) varUint8Array(bytes)
 * awareness := varUint(1) varUint8Array(bytes)
 * ```
 *
 * Nothing here interprets a document. Sync step 1 carries a state vector and sync step 2
 * carries an update, and this module's only opinion about either is how long it is.
 */

/** The top-level message tags a `y-websocket` client and server exchange. */
export const MESSAGE_SYNC = 0;
/** Awareness: cursors, selections and presence. Relayed, never interpreted (P0). */
export const MESSAGE_AWARENESS = 1;
/** Permission denied, sent by servers that authenticate after the upgrade. We never do. */
export const MESSAGE_AUTH = 2;
/** A peer asking for the awareness state of everyone already in the room. */
export const MESSAGE_QUERY_AWARENESS = 3;

/** "Here is my state vector; send me what I am missing." */
export const SYNC_STEP_1 = 0;
/** "Here is everything you were missing." */
export const SYNC_STEP_2 = 1;
/** "Here is one new update." */
export const SYNC_UPDATE = 2;

/** Seven payload bits per byte. */
const BITS_7 = 0b0111_1111;
/** The continuation bit: set means another byte follows. */
const BIT_8 = 0b1000_0000;
/** The radix of the encoding, so the arithmetic below reads as base-128. */
const BASE = 128;

/**
 * A frame that does not decode.
 *
 * Distinct from every other failure in this service because the response to it is
 * specific: close the socket with 1002 (protocol error) rather than logging and
 * carrying on. A peer sending bytes we cannot parse is not going to start making sense
 * on the next frame.
 */
export class ProtocolError extends Error {
  public override readonly name: string = 'ProtocolError';

  public constructor(message: string) {
    super(message);
  }
}

/**
 * Encodes one unsigned integer, base-128, least-significant group first.
 *
 * Rejects anything that is not a non-negative safe integer. A negative length or a
 * float here would encode into something a peer decodes as a different, larger number,
 * and the first place that shows up is an allocation.
 */
export function writeVarUint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError(`varUint must be a non-negative safe integer, got ${String(value)}.`);
  }

  const bytes: number[] = [];
  let remaining = value;

  while (remaining > BITS_7) {
    bytes.push(BIT_8 | (BITS_7 & remaining));
    remaining = Math.floor(remaining / BASE);
  }
  bytes.push(BITS_7 & remaining);

  return Uint8Array.from(bytes);
}

/** Joins encoded fragments into the single frame that goes on the wire. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A length-prefixed byte string: the shape both sync steps carry their payload in. */
export function writeVarUint8Array(bytes: Uint8Array): Uint8Array {
  return concatBytes([writeVarUint(bytes.length), bytes]);
}

/**
 * A cursor over a received frame.
 *
 * Every read is bounds-checked and a short frame throws {@link ProtocolError}, because
 * the alternative — reading past the end and getting `undefined` coerced to zero — turns
 * a truncated frame into a plausible-looking message.
 */
export class FrameReader {
  private position = 0;

  public constructor(private readonly bytes: Uint8Array) {}

  /** True once every byte of the frame has been consumed. */
  public get exhausted(): boolean {
    return this.position >= this.bytes.length;
  }

  /** How many bytes are left. */
  public get remaining(): number {
    return Math.max(0, this.bytes.length - this.position);
  }

  /** Reads one base-128 unsigned integer. */
  public readVarUint(): number {
    let value = 0;
    let multiplier = 1;

    for (;;) {
      const byte = this.bytes[this.position];
      if (byte === undefined) {
        throw new ProtocolError('frame ended inside a varUint.');
      }
      this.position += 1;

      value += (byte & BITS_7) * multiplier;

      if (byte < BIT_8) {
        if (!Number.isSafeInteger(value)) {
          throw new ProtocolError('varUint exceeds the safe integer range.');
        }
        return value;
      }

      multiplier *= BASE;
      if (multiplier > Number.MAX_SAFE_INTEGER) {
        throw new ProtocolError('varUint exceeds the safe integer range.');
      }
    }
  }

  /** Reads one length-prefixed byte string. */
  public readVarUint8Array(): Uint8Array {
    const length = this.readVarUint();
    if (length > this.remaining) {
      throw new ProtocolError(
        `frame declares ${String(length)} bytes but only ${String(this.remaining)} remain.`,
      );
    }
    const slice = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }
}

/** `sync / step 1` — this side's state vector, asking for the difference. */
export function encodeSyncStep1(stateVector: Uint8Array): Uint8Array {
  return concatBytes([
    writeVarUint(MESSAGE_SYNC),
    writeVarUint(SYNC_STEP_1),
    writeVarUint8Array(stateVector),
  ]);
}

/** `sync / step 2` — the difference the peer asked for. */
export function encodeSyncStep2(update: Uint8Array): Uint8Array {
  return concatBytes([
    writeVarUint(MESSAGE_SYNC),
    writeVarUint(SYNC_STEP_2),
    writeVarUint8Array(update),
  ]);
}

/** `sync / update` — one incremental update, the frame a live edit travels in. */
export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  return concatBytes([
    writeVarUint(MESSAGE_SYNC),
    writeVarUint(SYNC_UPDATE),
    writeVarUint8Array(update),
  ]);
}

/** An awareness frame, wrapping a payload this service never opens. */
export function encodeAwareness(payload: Uint8Array): Uint8Array {
  return concatBytes([writeVarUint(MESSAGE_AWARENESS), writeVarUint8Array(payload)]);
}

/** The decoded shape of an inbound frame, as far as this service understands one. */
export type InboundFrame =
  | { readonly kind: 'sync_step_1'; readonly stateVector: Uint8Array }
  | { readonly kind: 'sync_step_2'; readonly update: Uint8Array }
  | { readonly kind: 'sync_update'; readonly update: Uint8Array }
  | { readonly kind: 'awareness'; readonly payload: Uint8Array }
  | { readonly kind: 'query_awareness' }
  /** A well-formed frame of a type this service has no behaviour for. Ignored, not fatal. */
  | { readonly kind: 'ignored'; readonly messageType: number };

/**
 * Parses one inbound frame.
 *
 * An unrecognised *message type* is `ignored` rather than an error: the protocol is
 * versioned by addition, and a newer client sending a tag we have never heard of must
 * not have its interview terminated. An unrecognised *sync step*, by contrast, is
 * structurally undecodable, so it throws.
 */
export function decodeFrame(bytes: Uint8Array): InboundFrame {
  const reader = new FrameReader(bytes);
  const messageType = reader.readVarUint();

  switch (messageType) {
    case MESSAGE_SYNC: {
      const step = reader.readVarUint();
      switch (step) {
        case SYNC_STEP_1:
          return { kind: 'sync_step_1', stateVector: reader.readVarUint8Array() };
        case SYNC_STEP_2:
          return { kind: 'sync_step_2', update: reader.readVarUint8Array() };
        case SYNC_UPDATE:
          return { kind: 'sync_update', update: reader.readVarUint8Array() };
        default:
          throw new ProtocolError(`unknown sync step ${String(step)}.`);
      }
    }
    case MESSAGE_AWARENESS:
      return { kind: 'awareness', payload: reader.readVarUint8Array() };
    case MESSAGE_QUERY_AWARENESS:
      return { kind: 'query_awareness' };
    case MESSAGE_AUTH:
    default:
      return { kind: 'ignored', messageType };
  }
}
