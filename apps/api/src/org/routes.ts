/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GET` and `PATCH /org/settings` — docs/03-API-spec.md §13, and the vertical slice P1
 * exists to prove (P1 plan, step 7).
 *
 * ```
 * GET   /api/v1/org/settings                                    org.admin
 * PATCH /api/v1/org/settings   {branding?, proctoring_defaults?} org.admin
 * ```
 *
 * The plan states the path this file is the first instance of:
 *
 * > A request arrives carrying a session, resolves to an organisation, passes a
 * > per-action permission check, reads a row that row-level security scoped, writes an
 * > audit entry in the same transaction, and returns the standard error envelope when any
 * > step fails.
 *
 * Every stage of that sentence is somebody else's code, and that is the point — this file
 * is short because the spine is built. The session became a principal in
 * `../auth/staff-session.ts`, the permission was checked by `../authorisation.ts` before
 * this handler ran, `request.audited` in `../audit.ts` opens the one transaction that
 * carries both the change and its record, and `withOrg` in `@assaybank/db` is what makes
 * the read see one tenant. A route that had to *do* any of that would be a route the next
 * twenty endpoints would each re-implement slightly differently.
 *
 * ## Why settings, and not something more interesting
 *
 * Because it is the smallest endpoint that is genuinely org-scoped, genuinely
 * permission-gated and genuinely worth auditing, and it needs no question bank to exist.
 * P2 builds the bank on top of this spine; proving the spine with the bank would have
 * meant proving two things at once and being unable to say which one was wrong.
 *
 * ## Why the read is not audited and the write is
 *
 * docs/12 §9 and docs/17 §9: the audit log is a domain record kept for seven years, not
 * telemetry. A row per `GET` would make the busiest table in the system a log of people
 * looking at a settings page, and would bury the rows that answer a real question — who
 * changed this, when, and from what to what. Reads are answered by the access log under
 * the same trace id. Every write on this path carries `before` and `after`.
 *
 * ## `Idempotency-Key`, and why it is not read here
 *
 * docs/03 §2 requires every mutating endpoint to accept the header and replay the original
 * response. The replay needs a store of request fingerprints and their responses, which
 * does not exist yet and is not this endpoint's to invent — one route with a private
 * idempotency cache is how two incompatible implementations of a cross-cutting guarantee
 * get written. The header is already on the CORS allow-list, so a client may send it, and
 * it is ignored rather than rejected.
 *
 * What it would buy here is small, which is why this endpoint is not the one that should
 * force the decision: a `PATCH` of named fields to named values is naturally idempotent —
 * a retry sets the same fields to the same values and answers the same body. The only
 * observable difference is a second `audit_log` row, and two rows saying an administrator
 * set the same value twice is a truthful record of what arrived.
 */

import type { FastifyInstance } from 'fastify';

import {
  API_BASE_PATH,
  ApiError,
  ORG_SETTINGS_PATH,
  OrgSettingsPatchSchema,
  mergeOrgSettings,
  parseRequestPart,
  type OrgSettings,
  type OrgSettingsResponse,
} from '@assaybank/contracts';
import { withOrg, type Database } from '@assaybank/db';

import { requirePermission } from '../authorisation.js';
import { staffOnly } from '../principal.js';
import { rateLimitFor } from '../rate-limit.js';
import { assertServable, readOrg, writeOrgSettings, type StoredOrg } from './settings.js';

/** The registered path, including the version prefix. */
export const ORG_SETTINGS_ROUTE = `${API_BASE_PATH}${ORG_SETTINGS_PATH}`;

/**
 * The `audit_log.action` a settings change is recorded under.
 *
 * `org.settings.update`, matching the shape docs/11 §4.2 uses for the retention clocks
 * (`org.retention.update`) so that `action LIKE 'org.%'` is a usable query when an
 * administrator asks what changed about their configuration. Exported because the
 * integration suite reads the row back by this exact string, and a literal repeated in
 * two places is a literal that will eventually be two different strings.
 */
export const ORG_SETTINGS_UPDATE_ACTION = 'org.settings.update';

/** What the routes need from the composition root. */
export interface OrgRouteOptions {
  /** The connection handle. `request.audited` opens its own transaction from the same one. */
  readonly db: Database;
  /** ADR-006: `server_time` comes from here, never from the wall clock in this file. */
  readonly now: () => Date;
}

/**
 * The staff principal behind this request.
 *
 * Unreachable as a refusal: `can()` denies a candidate principal every permission,
 * including ones invented after it was written, so an attempt token never reaches a route
 * that declares `org.admin` (the standing leak suite asserts exactly this, over the whole
 * route table). It is written as a refusal rather than a cast because a narrowing that is
 * enforced by an `if` stays true when somebody moves the route onto the public allow-list
 * by mistake, and a cast does not.
 */

/**
 * The response body, built field by field from the row and the settings document.
 *
 * An explicit serialiser rather than a spread of the row (docs/17 §3): the fields are
 * named here, so a column added to `organizations` — or a key added to its `settings`
 * blob — cannot ship to a client because somebody widened a `select`.
 */
function toResponse(org: StoredOrg, settings: OrgSettings, at: Date): OrgSettingsResponse {
  return {
    org: { id: org.id, name: org.name, slug: org.slug },
    settings,
    server_time: at.toISOString(),
  };
}

/**
 * Registers both routes.
 *
 * Called from `server.ts` inside `app.after()`, for the reason recorded there: the rate
 * limiter and the authorisation table both install themselves through `onRoute` hooks,
 * which Fastify runs synchronously as each route is declared, so a route added before
 * they exist is silently unlimited and — worse — silently unchecked.
 */
export function registerOrgRoutes(app: FastifyInstance, options: OrgRouteOptions): void {
  const { db, now } = options;

  // --- GET /org/settings -------------------------------------------------------
  app.get(
    ORG_SETTINGS_ROUTE,
    { config: { ...rateLimitFor('staff_api'), ...requirePermission('org.admin') } },
    async (request): Promise<OrgSettingsResponse> => {
      const principal = staffOnly(request);

      const org = await withOrg(db, principal.orgId, (tx) => readOrg(tx, principal.orgId));

      // `not_found`, never `forbidden`, and never a 500. The session named an
      // organisation this transaction could not see — erased, or never there. A 403 would
      // confirm that somebody holds the row, which is a cross-tenant disclosure made of
      // nothing but a status code (ADR-010, docs/14 `H-154`).
      if (org === undefined) throw ApiError.notFound();

      return toResponse(org, org.settings, now());
    },
  );

  // --- PATCH /org/settings -----------------------------------------------------
  app.patch(
    ORG_SETTINGS_ROUTE,
    { config: { ...rateLimitFor('staff_api'), ...requirePermission('org.admin') } },
    async (request): Promise<OrgSettingsResponse> => {
      const principal = staffOnly(request);

      // Parsed before the transaction opens, so a malformed body costs no lock and no
      // round trip, and the 422 it produces describes the body rather than the outcome of
      // work that was already half done. `parseRequestPart` rather than Fastify's own
      // validator because ajv is configured with `removeAdditional: true` here, which
      // would strip `retention_days` and answer 200 — telling an administrator their
      // retention policy had changed when nothing had (see @assaybank/contracts/parse).
      const patch = parseRequestPart(OrgSettingsPatchSchema, request.body, 'body');

      // One transaction, carrying the read, the write and the audit row. If any of the
      // three fails they all roll back, so the record cannot claim a change the database
      // does not have — and the change cannot happen without the record.
      //
      // The row is not compared against the patch first: a `PATCH` that sets a field to
      // the value it already had is still an administrator deciding that value, and the
      // audit row saying so is the record of a decision rather than of a diff.
      return request.audited(
        {
          action: ORG_SETTINGS_UPDATE_ACTION,
          entityType: 'organization',
          entityId: principal.orgId,
        },
        async (tx, entry) => {
          // `FOR UPDATE`: this is a read-modify-write over a document, and two
          // administrators changing different fields at once would otherwise lose one of
          // the changes silently. See `./settings.ts`.
          const org = await readOrg(tx, principal.orgId, { forUpdate: true });
          if (org === undefined) throw ApiError.notFound();

          const next = assertServable(mergeOrgSettings(org.settings, patch));
          await writeOrgSettings(tx, org, next);

          // FR-21's shape, applied to configuration: both states survive in the record,
          // so "who turned webcam capture on, and what was it before" is answerable from
          // one row years later. Amended rather than passed in the spec because `after`
          // does not exist until the merge has run.
          entry.amend({ before: org.settings, after: next });

          return toResponse(org, next, now());
        },
      );
    },
  );
}
