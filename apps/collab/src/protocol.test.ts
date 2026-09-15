/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  concatBytes,
  decodeFrame,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  FrameReader,
  MESSAGE_AUTH,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
  ProtocolError,
  SYNC_STEP_1,
  writeVarUint,
  writeVarUint8Array,
} from './protocol.js';

/** Round-trips one integer through the encoder and the reader. */
function roundTrip(value: number): number {
  return new FrameReader(writeVarUint(value)).readVarUint();
}

describe('writeVarUint / readVarUint', () => {
  it('round-trips the boundary values of every group width', () => {
    // 127 is the last single-byte value, 128 the first two-byte one, and so on. These are
    // the values an off-by-one in the continuation bit gets wrong and no other value does.
    for (const value of [0, 1, 42, 127, 128, 129, 16_383, 16_384, 2_097_151, 2_097_152]) {
      expect(roundTrip(value)).toBe(value);
    }
  });

  it('round-trips a value larger than 32 bits', () => {
    expect(roundTrip(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('encodes the documented base-128 little-endian form', () => {
    // Pinned against the lib0 encoding a stock y-websocket client uses. If this changes,
    // every browser in an interview stops understanding this server.
    expect([...writeVarUint(0)]).toEqual([0]);
    expect([...writeVarUint(127)]).toEqual([127]);
    expect([...writeVarUint(128)]).toEqual([0b1000_0000, 1]);
    expect([...writeVarUint(300)]).toEqual([0b1010_1100, 2]);
  });

  it('refuses a negative or fractional length rather than encoding something else', () => {
    expect(() => writeVarUint(-1)).toThrow(ProtocolError);
    expect(() => writeVarUint(1.5)).toThrow(ProtocolError);
  });

  it('throws rather than reading past the end of a truncated frame', () => {
    // A continuation bit with nothing after it. Reading past the end would yield a
    // plausible number from a frame that is not one.
    expect(() => new FrameReader(Uint8Array.from([0b1000_0000])).readVarUint()).toThrow(
      ProtocolError,
    );
  });
});

describe('writeVarUint8Array / readVarUint8Array', () => {
  it('round-trips a payload', () => {
    const payload = Uint8Array.from([1, 2, 3, 250, 0, 255]);
    const reader = new FrameReader(writeVarUint8Array(payload));
    expect([...reader.readVarUint8Array()]).toEqual([...payload]);
    expect(reader.exhausted).toBe(true);
  });

  it('round-trips an empty payload', () => {
    const reader = new FrameReader(writeVarUint8Array(new Uint8Array(0)));
    expect(reader.readVarUint8Array().length).toBe(0);
  });

  it('refuses a length that overruns the frame', () => {
    // Declares 200 bytes and supplies two. Trusting the declared length is how a peer
    // makes a server allocate on demand.
    const frame = concatBytes([writeVarUint(200), Uint8Array.from([1, 2])]);
    expect(() => new FrameReader(frame).readVarUint8Array()).toThrow(ProtocolError);
  });
});

describe('decodeFrame', () => {
  it('decodes each sync step back to what was encoded', () => {
    const stateVector = Uint8Array.from([9, 8, 7]);
    const update = Uint8Array.from([1, 1, 2, 3, 5]);

    expect(decodeFrame(encodeSyncStep1(stateVector))).toEqual({
      kind: 'sync_step_1',
      stateVector,
    });
    expect(decodeFrame(encodeSyncStep2(update))).toEqual({ kind: 'sync_step_2', update });
    expect(decodeFrame(encodeSyncUpdate(update))).toEqual({ kind: 'sync_update', update });
  });

  it('decodes an awareness frame without opening the payload', () => {
    const payload = Uint8Array.from([4, 5, 6]);
    expect(decodeFrame(encodeAwareness(payload))).toEqual({ kind: 'awareness', payload });
  });

  it('decodes a bare awareness query', () => {
    expect(decodeFrame(writeVarUint(MESSAGE_QUERY_AWARENESS))).toEqual({ kind: 'query_awareness' });
  });

  it('places the message tags where a stock y-websocket client expects them', () => {
    expect(MESSAGE_SYNC).toBe(0);
    expect(MESSAGE_AWARENESS).toBe(1);
    expect(MESSAGE_AUTH).toBe(2);
    expect(MESSAGE_QUERY_AWARENESS).toBe(3);
    expect([...encodeSyncStep1(new Uint8Array(0))]).toEqual([MESSAGE_SYNC, SYNC_STEP_1, 0]);
  });

  it('ignores an unknown message type instead of failing the connection', () => {
    // The protocol is versioned by addition. A newer client sending a tag this build has
    // never heard of must not have its interview terminated.
    expect(decodeFrame(writeVarUint(97))).toEqual({ kind: 'ignored', messageType: 97 });
  });

  it('throws on an unknown sync step, which is structurally undecodable', () => {
    const frame = concatBytes([writeVarUint(MESSAGE_SYNC), writeVarUint(9)]);
    expect(() => decodeFrame(frame)).toThrow(ProtocolError);
  });

  it('throws on an empty frame', () => {
    expect(() => decodeFrame(new Uint8Array(0))).toThrow(ProtocolError);
  });
});
