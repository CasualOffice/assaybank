/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The SDK is mocked rather than started for real: starting it installs require hooks
 * across the process and opens an exporter to a collector that is not running in CI.
 * What is worth asserting here is the contract the services depend on — start once,
 * shut down cleanly, and never throw at a caller whatever the collector is doing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn();
const shutdown = vi.fn(() => Promise.resolve());
const construct = vi.fn();

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    public constructor(config: unknown) {
      construct(config);
    }
    public start(): void {
      start();
    }
    public shutdown(): Promise<void> {
      return shutdown();
    }
  },
}));

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: vi.fn(() => []),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {},
}));

const { initTelemetry, shutdownTelemetry } = await import('./telemetry.js');

beforeEach(() => {
  start.mockClear();
  shutdown.mockClear();
  construct.mockClear();
});

afterEach(async () => {
  await shutdownTelemetry();
});

describe('initTelemetry', () => {
  it('starts the SDK once and names the service', async () => {
    await initTelemetry('hiring-api');

    expect(start).toHaveBeenCalledTimes(1);
    const config = construct.mock.calls[0]?.[0] as { serviceName?: string } | undefined;
    expect(config?.serviceName).toBe('hiring-api');
  });

  it('is idempotent, so a harness that boots an app twice is safe', async () => {
    await initTelemetry('hiring-api');
    await initTelemetry('hiring-api');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('registers the process metrics on the shared registry', async () => {
    await initTelemetry('hiring-worker');
    const { metrics } = await import('./metrics.js');
    expect(await metrics.metrics()).toContain('process_cpu_user_seconds_total');
  });

  it('never fails a boot when the SDK will not start', async () => {
    start.mockImplementationOnce(() => {
      throw new Error('collector unreachable');
    });
    await expect(initTelemetry('hiring-collab')).resolves.toBeUndefined();
  });
});

describe('shutdownTelemetry', () => {
  it('is a no-op when telemetry was never started', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('flushes the SDK', async () => {
    await initTelemetry('hiring-api');
    await shutdownTelemetry();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('swallows a shutdown failure rather than crashing the exit path', async () => {
    await initTelemetry('hiring-api');
    shutdown.mockImplementationOnce(() => Promise.reject(new Error('export failed')));
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
