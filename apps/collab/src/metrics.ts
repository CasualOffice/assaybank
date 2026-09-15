/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What this service tells an on-call engineer (docs/12 §4, §6).
 *
 * Four numbers, chosen because each one answers a question somebody asks at 02:00 during
 * an interview that is going wrong:
 *
 * - `collab_connections` — is anyone connected at all?
 * - `collab_reconnects_total` — rising on its own is the shape of a flapping network.
 * - `collab_handshakes_rejected_total{reason}` — is the API minting tickets this service
 *   will not accept? A spike on `expired` is clock skew between the two tiers; a spike on
 *   `signature_invalid` is a secret that was rotated in one place.
 * - `collab_rooms` — how many documents this instance is holding, which is what its
 *   memory is proportional to.
 *
 * **No room code, session id or candidate id appears as a label.** Every one of them is
 * unbounded, and `@assaybank/observability` throws at construction rather than letting a
 * per-room series set take the metrics tier down at peak. Room-level detail belongs on
 * the span and the log line, where it already is.
 *
 * Metrics are declared per registry and memoised, because `prom-client` refuses a
 * duplicate registration and a test suite builds several servers in one process.
 */

import {
  type CounterMetric,
  counter,
  type GaugeMetric,
  gauge,
  metrics,
  type MetricsRegistry,
} from '@assaybank/observability';
import { AUTH_ERROR_REASONS } from '@assaybank/auth';

/**
 * Why a handshake was refused, as a closed set.
 *
 * The seven credential reasons come from `@assaybank/auth` so this list cannot drift from
 * the verifier; the three local ones are the refusals this service makes before the
 * verifier is even reached.
 *
 * Note that this detail is a *server-side* label, not a client-facing one: every refusal
 * below is served to the holder as the same opaque 401 (docs/14 T-011). The metric is
 * allowed to know why; the socket is not.
 */
export const REJECTION_REASONS: readonly string[] = Object.freeze([
  ...AUTH_ERROR_REASONS,
  /** No `ticket` query parameter at all. */
  'no_ticket',
  /** A ticket that verified, but had already been redeemed. */
  'replayed',
  /** The upgrade did not address `/collab/{room_code}`. */
  'unknown_path',
  /** The process is draining and is not taking new rooms. */
  'shutting_down',
]);

/** The metric handles this service observes through. */
export interface CollabMetrics {
  /** Currently open, authenticated WebSocket connections. */
  readonly connections: GaugeMetric;
  /** Yjs documents this instance is holding, including those kept briefly after the last peer left. */
  readonly rooms: GaugeMetric;
  /** Upgrades that completed. */
  readonly handshakesAccepted: CounterMetric;
  /** Upgrades refused, by server-side reason. */
  readonly handshakesRejected: CounterMetric<'reason'>;
  /** Connections accepted into a room this instance was already holding. */
  readonly reconnects: CounterMetric;
  /** Frames dropped: a text frame, an oversized frame, or one that would not decode. */
  readonly framesDropped: CounterMetric<'reason'>;
}

const perRegistry = new WeakMap<MetricsRegistry, CollabMetrics>();

/**
 * The metric handles for `registry`, built once per registry.
 *
 * Defaults to the process-wide registry that `/metrics` serves. A test passes its own so
 * that two servers in one process do not accumulate into each other's counters.
 */
export function collabMetrics(registry: MetricsRegistry = metrics): CollabMetrics {
  const existing = perRegistry.get(registry);
  if (existing !== undefined) return existing;

  const built: CollabMetrics = {
    connections: gauge({
      name: 'collab_connections',
      help: 'Open authenticated WebSocket connections held by this collaboration instance.',
      registry,
    }),
    rooms: gauge({
      name: 'collab_rooms',
      help: 'Yjs documents held in memory by this instance, including rooms briefly retained after the last peer disconnected.',
      registry,
    }),
    handshakesAccepted: counter({
      name: 'collab_handshakes_accepted_total',
      help: 'WebSocket upgrades completed against a valid, unredeemed ticket.',
      registry,
    }),
    handshakesRejected: counter({
      name: 'collab_handshakes_rejected_total',
      help: 'WebSocket upgrades refused before completing, by server-side reason. The holder is told none of this (docs/14 T-011).',
      labelNames: ['reason'] as const,
      labelValues: { reason: REJECTION_REASONS },
      registry,
    }),
    reconnects: counter({
      name: 'collab_reconnects_total',
      help: 'Connections accepted into a room this instance was already holding a document for. Rising while collab_connections stays flat is a peer reconnecting in a loop. It also counts a genuine second participant joining a live room; P5 separates the two with a per-participant identity in the ticket.',
      registry,
    }),
    framesDropped: counter({
      name: 'collab_frames_dropped_total',
      help: 'Inbound frames discarded: not binary, over the size ceiling, or undecodable.',
      labelNames: ['reason'] as const,
      labelValues: { reason: ['not_binary', 'too_large', 'undecodable'] },
      registry,
    }),
  };

  perRegistry.set(registry, built);
  return built;
}
