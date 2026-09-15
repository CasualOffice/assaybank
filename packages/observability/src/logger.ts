/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The structured JSON logger (docs/12 §7.1).
 *
 * One single-line JSON object per event on stdout, collected by the container runtime.
 * Every line carries `ts`, `level`, `service`, `env`, `msg`, and — whenever a span or a
 * request context is active — `trace_id` and `span_id`, which is what joins a support
 * ticket quoting `req_<trace_id>` to the trace that explains it.
 *
 * `msg` is a fixed string per call site. Values go in named fields; interpolating them
 * into the message makes every line unique and therefore unsearchable.
 *
 * Redaction is not optional and not per-call: every merged object, every child binding
 * and every error passes through the deny-list in redaction.ts before it is written.
 */

import { context as otelContext, trace } from '@opentelemetry/api';
import pino from 'pino';
import type { Bindings, DestinationStream, Logger as PinoLogger, LoggerOptions } from 'pino';

import { currentContext } from './context.js';
import { PINO_REDACT_PATHS, REDACTED, redactRecord, serialiseError } from './redaction.js';

/** The levels docs/12 §7.1 fixes, governed by `LOG_LEVEL`. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** The logger type every app and package passes around. */
export type Logger = PinoLogger;

/** Options for {@link createLogger}. */
export interface CreateLoggerOptions {
  /** Matches `OTEL_SERVICE_NAME`: `hiring-api`, `hiring-worker`, `hiring-collab`. */
  readonly service: string;
  /** From `APP_ENV`. Omitted rather than guessed — this package never reads the environment. */
  readonly env?: string | undefined;
  /** From `LOG_LEVEL`. `debug` in production is a redaction risk, not just a volume one. */
  readonly level?: LogLevel | undefined;
  /** Human-readable output for local development only. Never in a deployed environment. */
  readonly pretty?: boolean | undefined;
  /** Explicit sink. Used by tests; production writes to stdout. */
  readonly destination?: DestinationStream | undefined;
  /** Extra fixed fields on every line, e.g. `{ queue: 'grading.submit' }` in a worker. */
  readonly base?: Readonly<Record<string, string | number>> | undefined;
}

/**
 * Fields discovered from the ambient span and request context on every line.
 *
 * The active span wins over the stored context for `trace_id`: if a span is running,
 * its id is the one the collector will have, and a mismatch there is the thing that
 * makes a trace unfindable.
 */
function contextFields(): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  const spanContext = trace.getSpan(otelContext.active())?.spanContext();
  const stored = currentContext();

  const traceId = spanContext?.traceId ?? stored?.traceId;
  if (traceId !== undefined) fields['trace_id'] = traceId;
  if (spanContext !== undefined) fields['span_id'] = spanContext.spanId;
  // Domain identifiers belong on a log line (docs/12 §7.1); it is the metric labels
  // that must stay free of them.
  if (stored?.orgId !== undefined) fields['org_id'] = stored.orgId;
  if (stored?.userId !== undefined) fields['user_id'] = stored.userId;

  return fields;
}

function baseFields(opts: CreateLoggerOptions): Record<string, string | number> {
  const base: Record<string, string | number> = { service: opts.service };
  if (opts.env !== undefined) base['env'] = opts.env;
  return { ...base, ...(opts.base ?? {}) };
}

function loggerOptions(opts: CreateLoggerOptions): LoggerOptions {
  return {
    level: opts.level ?? 'info',
    // `base` replaces pino's default `{ pid, hostname }`: a container id is noise in
    // this deployment and a hostname can be an identifier in a single-tenant install.
    base: baseFields(opts),
    messageKey: 'msg',
    errorKey: 'err',
    // RFC 3339 UTC, matching the timestamps in the API envelope (docs/12 §7.1).
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level: (label: string) => ({ level: label }),
      bindings: (bindings: Bindings) => redactRecord(bindings),
      log: (object: Record<string, unknown>) => redactRecord(object),
    },
    mixin: () => contextFields(),
    // The second, independent mechanism. See PINO_REDACT_PATHS.
    redact: { paths: [...PINO_REDACT_PATHS], censor: REDACTED },
    serializers: { err: serialiseError, error: serialiseError, cause: serialiseError },
    hooks: {
      /**
       * `logger.error(err)` would otherwise put `err.message` in `msg` — and a Postgres
       * error's message can contain the parameter values of the failing statement,
       * which for an answer upsert is the candidate's answer. Rewriting the call to
       * `logger.error({ err }, 'error')` forces the error through the serialiser.
       */
      logMethod(this: Logger, args, method) {
        const first: unknown = args[0];
        if (first instanceof Error) {
          const second: unknown = args[1];
          const msg = typeof second === 'string' ? second : 'error';
          method.apply(this, [{ err: first }, msg] as unknown as Parameters<typeof method>);
          return;
        }
        method.apply(this, args);
      },
    },
  };
}

/**
 * Builds a logger. Every service builds exactly one at boot and passes it down; a module
 * that creates its own loses the service, environment and context fields.
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const options = loggerOptions(opts);

  if (opts.destination !== undefined) {
    return pino(options, opts.destination);
  }

  if (opts.pretty === true) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, messageKey: 'msg', translateTime: false },
      },
    });
  }

  return pino(options);
}

/**
 * The default instance, for code that runs before a service has configured its own —
 * a bootstrap failure, a CLI, a test. `service` and `level` are deliberately generic:
 * this package never reads `process.env` (that is `@assaybank/config`'s sole privilege),
 * so an app passes `LOG_LEVEL` and `APP_ENV` in through {@link createLogger}.
 */
export const logger: Logger = createLogger({ service: 'assaybank' });
