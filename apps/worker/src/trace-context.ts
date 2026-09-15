/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The queue hop of the trace (docs/12 §5.2 rule 3).
 *
 * HLD §8 requires a trace id to survive from the candidate's request, through Valkey,
 * into the worker and the execution call — without it, "why did this candidate's score
 * differ on re-grade" has no answer. A queue breaks a trace by default, because the
 * producer and the consumer share no call stack. The fix is small and must be applied on
 * both sides: the producer injects W3C trace context into `job.data._otel`, the consumer
 * extracts it and starts its span as a child.
 *
 * A job that arrives without `_otel` is processed normally and starts a new trace, and
 * increments `bullmq_job_missing_context_total`. That metric is the whole point: silent
 * trace breakage changes nothing an operator can see until the day they need the trace.
 *
 * W3C `traceparent`/`tracestate` is the only propagation format (docs/12 §5.2 rule 1).
 * Nothing here is sent into the execution sandbox — Piston is uninstrumented by design
 * and receives nothing it did not need (rule 4).
 */

import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context, Span } from '@opentelemetry/api';
import { z } from 'zod';

/** The job-payload key carrying the propagated context. Fixed by docs/12 §5.2. */
export const OTEL_CARRIER_KEY = '_otel';

/** The instrumentation scope every worker span is recorded under. */
export const TRACER_NAME = '@assaybank/worker';

/**
 * The carrier as it is stored. Only the two W3C headers: anything else in there is
 * either a vendor format we do not accept or a payload field that wandered in.
 */
const CarrierSchema = z.object({
  traceparent: z.string().min(1),
  tracestate: z.string().optional(),
});

const CarrierEnvelopeSchema = z.object({ [OTEL_CARRIER_KEY]: CarrierSchema });

/** A W3C trace-context carrier, as it travels inside a job payload. */
export type TraceCarrier = z.infer<typeof CarrierSchema>;

/**
 * Adds the active trace context to a job payload.
 *
 * Used by the producer. `apps/api` will call the same function through its own copy of
 * this contract when it starts enqueueing; the shape is fixed by the document rather
 * than by this module, which is why the key is a constant and the schema is strict.
 *
 * With no SDK registered the global propagator is a no-op and the carrier comes back
 * empty, in which case nothing is added — an empty `_otel` would be indistinguishable
 * from a broken one at the consumer.
 */
export function injectTraceContext<T extends object>(payload: T): T {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  const parsed = CarrierSchema.safeParse(carrier);
  if (!parsed.success) return payload;

  return { ...payload, [OTEL_CARRIER_KEY]: parsed.data };
}

/** What {@link extractTraceContext} found. */
export interface ExtractedTraceContext {
  /** The parent context to start the job span under. The active context when absent. */
  readonly context: Context;
  /** False when the job arrived with no usable carrier — the trace is broken here. */
  readonly present: boolean;
}

/**
 * Recovers the producer's context from a job payload.
 *
 * `payload` is `unknown` on purpose: it came out of Valkey, it may have been written by
 * a previous release, and a malformed carrier must be treated exactly like a missing one
 * rather than throwing inside a processor.
 */
export function extractTraceContext(payload: unknown): ExtractedTraceContext {
  const parsed = CarrierEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return { context: context.active(), present: false };
  }

  const extracted = propagation.extract(context.active(), parsed.data[OTEL_CARRIER_KEY]);
  return { context: extracted, present: true };
}

/** Span attributes describing the job being consumed. All bounded, all operator-facing. */
export interface JobSpanAttributes {
  readonly queue: string;
  readonly jobName: string;
  readonly jobId: string;
  readonly attempt: number;
}

/**
 * Runs `fn` inside a consumer span parented to the producer's, and returns its result.
 *
 * The span is closed and its status set on both paths, including when `fn` throws — an
 * unclosed span is worse than no span, because it shows up as an in-flight operation
 * forever.
 */
export async function runInJobSpan<T>(
  parent: Context,
  attributes: JobSpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);

  return tracer.startActiveSpan(
    `${attributes.queue} ${attributes.jobName}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'bullmq',
        'messaging.destination.name': attributes.queue,
        'messaging.operation': 'process',
        'messaging.message.id': attributes.jobId,
        'bullmq.job_name': attributes.jobName,
        'bullmq.attempt': attributes.attempt,
      },
    },
    parent,
    async (span: Span): Promise<T> => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err: unknown) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.name : 'error',
        });
        if (err instanceof Error) span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * The trace id of the currently active span, or `undefined` when nothing is recording.
 *
 * `request_id` in the error envelope is `"req_" + trace_id` (docs/12 §5.3), so this is
 * the value a support ticket eventually resolves to.
 */
export function activeTraceId(): string | undefined {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  if (spanContext === undefined) return undefined;
  // An all-zero trace id is the invalid-context sentinel, not a trace.
  return /^0+$/u.test(spanContext.traceId) ? undefined : spanContext.traceId;
}
