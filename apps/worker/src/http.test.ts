/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTelemetryServer, WORKER_METRICS_PORT } from './http.js';
import type { RunningTelemetryServer } from './http.js';
import { recordQueueDepth } from './metrics.js';

let server: RunningTelemetryServer;

beforeEach(async () => {
  // Port 0: an ephemeral port, so the suite never fights the real 9464 or itself.
  server = await startTelemetryServer({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await server.close();
});

function url(path: string): string {
  return `http://127.0.0.1:${String(server.port)}${path}`;
}

describe('the worker telemetry listener', () => {
  it('scrapes on the port Prometheus is configured to reach', () => {
    // infra/prometheus/prometheus.yml: targets: ["worker:9464"], and the compose health
    // check hits the same port. Changing this constant is a three-file edit.
    expect(WORKER_METRICS_PORT).toBe(9464);
  });

  it('answers /healthz without touching Valkey', async () => {
    const response = await fetch(url('/healthz'));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok\n');
  });

  it('serves the Prometheus exposition on /metrics', async () => {
    recordQueueDepth('grading.submit', { waiting: 3, delayed: 0 });

    const response = await fetch(url('/metrics'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    const body = await response.text();
    expect(body).toContain('bullmq_queue_depth');
    expect(body).toContain('# HELP bullmq_dlq_depth');
  });

  it('ignores a query string on the scrape path', async () => {
    const response = await fetch(url('/metrics?collect=all'));
    expect(response.status).toBe(200);
  });

  it('serves nothing else — there is no candidate-facing surface here', async () => {
    for (const path of ['/', '/attempts', '/readyz', '/metrics/../etc']) {
      const response = await fetch(url(path));
      expect(response.status).toBe(404);
    }
  });

  it('refuses a write method', async () => {
    const response = await fetch(url('/metrics'), { method: 'POST' });
    expect(response.status).toBe(405);
  });
});
