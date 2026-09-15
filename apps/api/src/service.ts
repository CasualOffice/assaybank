/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two names this service answers to, in one place so a log line, a span resource,
 * a health payload and a `package.json` cannot drift apart.
 */

/** The workspace's own package name. */
export const WORKSPACE_NAME = '@assaybank/api';

/**
 * The service name used for telemetry when configuration does not supply one. It matches
 * the `OTEL_SERVICE_NAME` default in `@assaybank/config` and the dashboards in
 * `infra/grafana`; changing it orphans both.
 */
export const DEFAULT_SERVICE_NAME = 'hiring-api';
