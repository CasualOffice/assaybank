/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GET` and `PATCH /org/settings` — docs/03-API-spec.md §13.
 *
 * The first business endpoint in the tree, and the one P1 exists to prove: a request
 * carrying a session resolves to an organisation, passes a per-action permission check,
 * reads a row that row-level security scoped, writes an audit entry in the same
 * transaction, and returns the standard envelope when any step fails. Everything from
 * P2 onward is a variation on it, so the contract is written here in full rather than
 * inline in a handler — `packages/contracts` is the single source of API truth, and a
 * schema that lives beside a route is a schema the published document can disagree with.
 *
 * ## The response is a projection, never the stored row
 *
 * `organizations.settings` is a `jsonb` column. Serving it verbatim would be `SELECT *`
 * into a serialiser (docs/17 §12) with the added twist that the column has no schema at
 * all: whatever any past migration, any future feature or any hand-run `UPDATE` left in
 * the blob would ship to whoever called this endpoint. So {@link OrgSettingsSchema} names
 * every field and {@link projectOrgSettings} builds the response from those names alone.
 * A key in the blob that this build does not know about is not served, and a key this
 * build knows about that is missing from the blob is served as its default — which is
 * what makes the response shape stable for a client across a settings column that grows.
 *
 * The projection lives here rather than in `apps/api` because it is pure and because it
 * is the response shape: the property that matters — no unnamed key is ever served — is
 * then provable in a unit test with no database, and it holds for every future reader of
 * this column rather than for the one handler that remembered to filter.
 *
 * ## What is deliberately not here
 *
 * docs/03 §13 writes the body as `{retention_days, proctoring_defaults, branding}`.
 * `retention_days` is **not** accepted, and its absence is a decision rather than an
 * omission: docs/11 §4.2 supersedes that field with a typed object over five separate
 * clocks, each with a floor, a ceiling and a direction it may be moved in, *"all of which
 * are enforced by the `CHECK` constraints in §1.3 rather than by the API layer alone"*.
 * A `jsonb` blob carries no constraint, so accepting `retention_days` here would be
 * accepting a promise this endpoint cannot keep — a candidate told their data would be
 * gone in thirty days, and a number in a schemaless column as the only thing standing
 * behind it. It arrives with `org_retention_policy` and its constraints, in P7.
 *
 * A caller that sends it is refused rather than ignored. See {@link OrgSettingsPatchSchema}.
 *
 * ## ADR-007, restated as a type
 *
 * {@link OrgProctoringDefaultsSchema} carries three booleans and all three govern
 * *capture and consent*: whether a webcam is recorded, whether the screen is recorded,
 * whether an identity photograph is asked for. There is no field here — and there must
 * never be one — that rejects, voids, down-scores or gates an outcome on an integrity
 * signal. ADR-007 makes that a product constraint rather than a configuration option, so
 * the configuration surface is where it has to be visible: a reviewer reading this schema
 * can see the whole of what an organisation is allowed to decide about proctoring.
 */

import './openapi-extension.js';

import { z } from 'zod';

import { OrgIdSchema } from './ids.js';
import { Rfc3339Schema } from './primitives.js';

/**
 * The path, relative to `/api/v1`, exported so the route, the generated document and the
 * tests cannot drift apart over a string.
 */
export const ORG_SETTINGS_PATH = '/org/settings';

/** The longest display name this API will store. Long enough for a legal entity name. */
export const MAX_BRANDING_NAME_LENGTH = 120;

/** The longest logo URL. Bounded because the column is unbounded (docs/17 §10). */
export const MAX_LOGO_URL_LENGTH = 2048;

/**
 * A six-digit hexadecimal colour, lower case.
 *
 * One spelling rather than six. Accepting `#FFF`, `#ffffff`, `rgb(…)` and a CSS colour
 * name would mean the value a client reads back is not the value it wrote, and the
 * canonicalisation would then live in whichever of the console, the candidate runner and
 * the PDF renderer happened to implement it first.
 */
const HEX_COLOUR = /^#[0-9a-f]{6}$/u;

/**
 * An `https` URL with no whitespace or markup characters.
 *
 * `https` only: the console and the candidate runner are served over TLS, so an `http`
 * logo is a mixed-content block rather than a logo. The excluded characters are the ones
 * that would let a stored value break out of the attribute it is rendered into —
 * question and branding content is untrusted input (docs/17 §7), and a logo URL is
 * rendered by both browser applications.
 */
const HTTPS_URL = /^https:\/\/[^\s<>"'\\]+$/u;

/** A display name with at least one visible character. */
const VISIBLE_TEXT = /\S/u;

// --- branding ----------------------------------------------------------------

/**
 * How an organisation presents itself to its candidates.
 *
 * Every field is nullable and `null` means "not set" rather than "empty string". The
 * distinction matters at the point of rendering: a runner showing a blank heading where
 * it should have shown nothing is a visible defect, and an empty string is what an
 * over-helpful form sends.
 */
export const OrgBrandingSchema = z
  .object({
    display_name: z
      .string()
      .min(1)
      .max(MAX_BRANDING_NAME_LENGTH)
      .regex(VISIBLE_TEXT, 'A display name must contain at least one visible character.')
      .nullable()
      .describe('The name shown to candidates, when it differs from the organisation name.'),
    primary_colour: z
      .string()
      .regex(HEX_COLOUR, 'A colour is six lower-case hexadecimal digits, e.g. #1f6feb.')
      .nullable()
      .describe('Accent colour for candidate-facing surfaces, as #rrggbb.'),
    logo_url: z
      .string()
      .max(MAX_LOGO_URL_LENGTH)
      .regex(HTTPS_URL, 'A logo URL must be an https URL.')
      .nullable()
      .describe('An https URL for the logo shown on the candidate runner.'),
  })
  .describe('Candidate-facing presentation for one organisation.')
  .openapi('OrgBranding');

/** How an organisation presents itself to its candidates. */
export type OrgBranding = z.infer<typeof OrgBrandingSchema>;

// --- proctoring defaults -----------------------------------------------------

/**
 * The organisation's default answer to "what is captured during a proctored sitting".
 *
 * Defaults, not decisions. Each flag turns a capture on or off for assessments created
 * afterwards; none of them can reject a candidate, void a sitting or move a score, and
 * ADR-007 forbids a field here that could. Consent is captured before any capture begins
 * and a non-proctored alternative is always offered — that is the candidate app's
 * responsibility, not a setting an organisation may switch off.
 */
export const OrgProctoringDefaultsSchema = z
  .object({
    require_webcam: z
      .boolean()
      .describe('Capture webcam frames during proctored sittings, with consent.'),
    require_screen_recording: z
      .boolean()
      .describe('Capture the shared screen during proctored sittings, with consent.'),
    require_id_check: z
      .boolean()
      .describe('Ask for an identity photograph before a proctored sitting begins.'),
  })
  .describe('Default capture settings for proctored sittings. Signals only (ADR-007).')
  .openapi('OrgProctoringDefaults');

/** Default capture settings for proctored sittings. */
export type OrgProctoringDefaults = z.infer<typeof OrgProctoringDefaultsSchema>;

// --- the settings document ---------------------------------------------------

/** Everything `GET /org/settings` reports, and the whole of what `PATCH` may change. */
export const OrgSettingsSchema = z
  .object({
    branding: OrgBrandingSchema,
    proctoring_defaults: OrgProctoringDefaultsSchema,
  })
  .describe('One organisation’s settings, projected from the stored document.')
  .openapi('OrgSettings');

/** One organisation's settings. */
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

/**
 * What an organisation that has never touched a setting has.
 *
 * A function rather than a frozen constant so that a caller spreading it cannot hand a
 * shared object to two requests, and so the defaults are constructed in one place rather
 * than restated by every `?? fallback` in the projection. Proctoring is off by default:
 * capturing a candidate's webcam is a decision somebody has to make on purpose.
 */
export function defaultOrgSettings(): OrgSettings {
  return {
    branding: { display_name: null, primary_colour: null, logo_url: null },
    proctoring_defaults: {
      require_webcam: false,
      require_screen_recording: false,
      require_id_check: false,
    },
  };
}

/** The organisation a settings response belongs to, so a client can label what it shows. */
export const OrgIdentitySchema = z
  .object({
    id: OrgIdSchema,
    name: z.string().describe('The organisation’s own name, as an administrator set it.'),
    slug: z.string().describe('The URL-safe identifier used in per-organisation console URLs.'),
  })
  .describe('Which organisation this response is about.')
  .openapi('OrgIdentity');

/** The body of `GET /org/settings` and of a successful `PATCH`. */
export const OrgSettingsResponseSchema = z
  .object({
    org: OrgIdentitySchema,
    settings: OrgSettingsSchema,
    /** ADR-006: the server owns the clock and says so on every response. */
    server_time: Rfc3339Schema,
  })
  .describe('The organisation’s settings as they now stand.')
  .openapi('OrgSettingsResponse');

/** The body of `GET /org/settings` and of a successful `PATCH`. */
export type OrgSettingsResponse = z.infer<typeof OrgSettingsResponseSchema>;

// --- the patch ---------------------------------------------------------------

/**
 * A partial branding change. Every field is optional; `null` clears one.
 *
 * `strictObject`, so an unrecognised key is a `422` naming it rather than a silently
 * discarded field. That is the whole reason this schema is parsed in the handler instead
 * of being handed to Fastify's validator: `@fastify/ajv-compiler` sets
 * `removeAdditional: true`, which turns `additionalProperties: false` into "quietly strip
 * it" rather than "refuse it". For a login body that is harmless. For a settings change
 * it is not — the caller is told the request succeeded, the audit row records that
 * nothing changed, and the two agree with each other and with nobody's expectations.
 */
export const OrgBrandingPatchSchema = z
  .strictObject({
    display_name: OrgBrandingSchema.shape.display_name.optional(),
    primary_colour: OrgBrandingSchema.shape.primary_colour.optional(),
    logo_url: OrgBrandingSchema.shape.logo_url.optional(),
  })
  .describe('Branding fields to change. Omitted fields are left alone; null clears one.')
  .openapi('OrgBrandingPatch');

/** A partial proctoring-defaults change. */
export const OrgProctoringDefaultsPatchSchema = z
  .strictObject({
    require_webcam: OrgProctoringDefaultsSchema.shape.require_webcam.optional(),
    require_screen_recording: OrgProctoringDefaultsSchema.shape.require_screen_recording.optional(),
    require_id_check: OrgProctoringDefaultsSchema.shape.require_id_check.optional(),
  })
  .describe('Proctoring capture defaults to change. Omitted fields are left alone.')
  .openapi('OrgProctoringDefaultsPatch');

/**
 * The body of `PATCH /org/settings`.
 *
 * `PATCH` is partial (docs/03 §2), and partial here is per field rather than per section:
 * sending `{branding: {logo_url: null}}` clears the logo and leaves the display name and
 * the colour as they were. A body naming no known section at all is refused rather than
 * treated as a no-op, because an audited action that records "nothing changed" is a row
 * in a seven-year log that answers no question anybody will ever ask.
 */
export const OrgSettingsPatchSchema = z
  .strictObject({
    branding: OrgBrandingPatchSchema.optional(),
    proctoring_defaults: OrgProctoringDefaultsPatchSchema.optional(),
  })
  .refine((patch) => patch.branding !== undefined || patch.proctoring_defaults !== undefined, {
    error: 'Name at least one settings section to change.',
  })
  .describe('A partial settings change (docs/03 §13).')
  .openapi('OrgSettingsPatch');

/** The parsed body of `PATCH /org/settings`. */
export type OrgSettingsPatch = z.infer<typeof OrgSettingsPatchSchema>;

// --- projection and merge ----------------------------------------------------

/** True for a plain JSON object, which is the only shape a settings section can take. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Projects one section of a stored document over its defaults.
 *
 * Two things happen and both matter. The section is merged *over* the defaults, so a
 * document written before a field existed reads back with that field at its default
 * rather than as `undefined`. And the merged object goes through the schema, which — for
 * a plain zod object — strips every key it does not name, so a key in the stored
 * document cannot reach a response however it got there.
 *
 * A section that fails the schema outright falls back to the defaults rather than
 * throwing. The alternative is a 500 on `GET /org/settings` for a whole organisation
 * because one value in one blob is malformed, which turns a cosmetic defect into an
 * outage for the administrator best placed to fix it.
 */
function section<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  value: unknown,
  fallback: T,
): T {
  const parsed = schema.safeParse({ ...fallback, ...(isRecord(value) ? value : {}) });
  return parsed.success ? parsed.data : fallback;
}

/**
 * The stored `organizations.settings` document, as this build understands it.
 *
 * Total: every input produces a valid {@link OrgSettings}, including `null`, a string
 * and an array — all of which are legal `jsonb` and none of which is a settings
 * document. It is the step that makes the response a projection rather than the row
 * (docs/17 §3, §12), and it is pure, so the property "no unnamed key is ever served" is
 * provable without a database.
 */
export function projectOrgSettings(stored: unknown): OrgSettings {
  const raw = isRecord(stored) ? stored : {};
  const defaults = defaultOrgSettings();

  return {
    branding: section(OrgBrandingSchema, raw['branding'], defaults.branding),
    proctoring_defaults: section(
      OrgProctoringDefaultsSchema,
      raw['proctoring_defaults'],
      defaults.proctoring_defaults,
    ),
  };
}

/** The patched value when the patch names the field, and the current one when it does not. */
function chosen<T>(patched: T | undefined, current: T): T {
  return patched === undefined ? current : patched;
}

/**
 * Applies a partial change to a settings document.
 *
 * Per field rather than per section: `{branding: {logo_url: null}}` clears the logo and
 * leaves the display name alone. `undefined` — the shape an absent optional field takes —
 * means "unchanged", and `null` means "cleared", which is the whole reason this is a
 * field-by-field construction rather than an object spread: a spread cannot tell the two
 * apart under `exactOptionalPropertyTypes`, and `??` would read a deliberate `null` as an
 * absence and quietly refuse to clear anything.
 *
 * Writing every field out has a second effect worth having. The object literals below are
 * exhaustive, so a field added to {@link OrgSettingsSchema} is a compile error here until
 * somebody decides what patching it means — rather than a setting that is silently
 * readable and not writable.
 */
export function mergeOrgSettings(current: OrgSettings, patch: OrgSettingsPatch): OrgSettings {
  const branding = patch.branding;
  const proctoring = patch.proctoring_defaults;

  return {
    branding: {
      display_name: chosen(branding?.display_name, current.branding.display_name),
      primary_colour: chosen(branding?.primary_colour, current.branding.primary_colour),
      logo_url: chosen(branding?.logo_url, current.branding.logo_url),
    },
    proctoring_defaults: {
      require_webcam: chosen(
        proctoring?.require_webcam,
        current.proctoring_defaults.require_webcam,
      ),
      require_screen_recording: chosen(
        proctoring?.require_screen_recording,
        current.proctoring_defaults.require_screen_recording,
      ),
      require_id_check: chosen(
        proctoring?.require_id_check,
        current.proctoring_defaults.require_id_check,
      ),
    },
  };
}
