/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The six canonical queue names, and nothing else.
 *
 * These live in their own leaf module — imported by everything, importing nothing —
 * because `metrics.ts` needs the closed label set at module scope and `dlq.ts` needs the
 * name derivation, while `queues.ts` (the registry that declares concurrency, attempts,
 * backoff and dead-letter policy) needs both of those in turn. Putting the names beside
 * the registry would make that a module cycle whose failure mode is a temporal-dead-zone
 * `ReferenceError` at boot, in whichever import order the entry point happens to pick.
 *
 * `queues.ts` re-exports everything here, so application code has one import site.
 *
 * The names are fixed by `code-graph.json`'s `queues` array. Renaming one renames a
 * Prometheus label value, a dashboard panel, an alert rule and a runbook step, so it is
 * a deliberate multi-file edit rather than a refactor.
 */

/**
 * Every queue in the system, in the order `code-graph.json` declares them.
 *
 * `grading.run` and `grading.submit` are separate on purpose (ADR-008): a batch grading
 * backlog must never delay a candidate waiting on sample output from the editor.
 */
export const QUEUE_NAMES = [
  'grading.run',
  'grading.submit',
  'webhooks.deliver',
  'notifications.email',
  'bank.jobs',
  'maintenance.cron',
] as const;

/** One of the six queues. There is no seventh without an edit to `code-graph.json`. */
export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * The `priority` label on `bullmq_queue_depth` and `bullmq_time_in_queue_seconds`
 * (docs/12 §4.1). Its value set is closed at two, and the distinction it draws is the
 * operational one: is a human sitting in front of a spinner waiting for this job?
 */
export type QueuePriority = 'interactive' | 'batch';

/**
 * The scheduling class `code-graph.json` records for each queue. Distinct from
 * {@link QueuePriority}, which is the metric label and has only two values: `bank.jobs`
 * and `maintenance.cron` are both `batch` for metrics but `low` for scheduling.
 */
export type QueueTier = 'high' | 'normal' | 'low';

/**
 * Which queues a human is waiting on.
 *
 * Only `grading.run` is interactive: the candidate pressed "Run" and is looking at the
 * editor. Everything else — including `grading.submit`, where the candidate has already
 * moved on — is batch, and the alerting thresholds in docs/12 §4.1 differ accordingly.
 */
export const QUEUE_PRIORITY: { readonly [K in QueueName]: QueuePriority } = {
  'grading.run': 'interactive',
  'grading.submit': 'batch',
  'webhooks.deliver': 'batch',
  'notifications.email': 'batch',
  'bank.jobs': 'batch',
  'maintenance.cron': 'batch',
};

/** Appended to a queue name to name its dead-letter queue. */
export const DLQ_SUFFIX = '.dlq';

/** The name of a dead-letter queue: `grading.submit.dlq`, and its five siblings. */
export type DeadLetterQueueName = `${QueueName}${typeof DLQ_SUFFIX}`;

/**
 * The dead-letter queue for `name`.
 *
 * Derived rather than configured: a dead-letter queue whose name can be set separately
 * is a dead-letter queue that can be pointed at the wrong place, and the failure is
 * invisible until the day something needs retrieving from it.
 */
export function deadLetterQueueName(name: QueueName): DeadLetterQueueName {
  return `${name}${DLQ_SUFFIX}`;
}

/** Every dead-letter queue, in the same order as {@link QUEUE_NAMES}. */
export const DEAD_LETTER_QUEUE_NAMES: readonly DeadLetterQueueName[] =
  QUEUE_NAMES.map(deadLetterQueueName);

/** Narrows an unknown string — a job payload field, an operator argument — to a queue name. */
export function isQueueName(value: unknown): value is QueueName {
  return typeof value === 'string' && (QUEUE_NAMES as readonly string[]).includes(value);
}
