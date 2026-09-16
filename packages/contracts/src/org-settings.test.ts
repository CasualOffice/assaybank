/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The organisation-settings contract (docs/03 §13).
 *
 * Three properties are worth a test here rather than at the route, because they are
 * properties of the schema and would still have to hold if the route were rewritten:
 * that a parse strips whatever it does not name, that a `PATCH` refuses a field it does
 * not recognise instead of discarding it, and that the emitted document describes both
 * operations with the shared error envelope.
 */

import { describe, expect, it } from 'vitest';

import {
  ORG_SETTINGS_PATH,
  OrgBrandingSchema,
  OrgSettingsPatchSchema,
  OrgSettingsResponseSchema,
  OrgSettingsSchema,
  buildOpenApiDocument,
  defaultOrgSettings,
  mergeOrgSettings,
  projectOrgSettings,
} from './index.js';

describe('defaultOrgSettings()', () => {
  it('is everything unset and nothing captured', () => {
    expect(defaultOrgSettings()).toEqual({
      branding: { display_name: null, primary_colour: null, logo_url: null },
      proctoring_defaults: {
        require_webcam: false,
        require_screen_recording: false,
        require_id_check: false,
      },
    });
  });

  it('hands back a fresh object, so one request cannot mutate another request’s defaults', () => {
    const first = defaultOrgSettings();
    first.branding.display_name = 'mutated';
    expect(defaultOrgSettings().branding.display_name).toBeNull();
  });

  it('parses against its own schema, which is what makes it usable as a fallback', () => {
    expect(OrgSettingsSchema.safeParse(defaultOrgSettings()).success).toBe(true);
  });
});

describe('OrgSettingsSchema', () => {
  it('strips a key it does not name, which is what stops the stored blob leaking', () => {
    // The failure this guards: `organizations.settings` is schemaless, so a key left
    // there by a past migration or a future feature would be served to whoever called
    // the endpoint if the response were the row rather than a projection (docs/17 §12).
    const parsed = OrgSettingsSchema.parse({
      ...defaultOrgSettings(),
      internal_billing_plan: 'enterprise',
      sso_enforcement_secret: 'not-for-a-client',
    });

    expect(Object.keys(parsed).sort()).toEqual(['branding', 'proctoring_defaults']);
    expect(JSON.stringify(parsed)).not.toContain('enterprise');
  });

  it('names exactly the proctoring settings an organisation may decide (ADR-007)', () => {
    // Pinned deliberately. A field added here is a field that can change what happens to
    // a candidate, and ADR-007 allows capture settings and forbids decisions — so the
    // list is reviewed as a list rather than inside the diff of whatever wanted it.
    expect(Object.keys(defaultOrgSettings().proctoring_defaults).sort()).toEqual([
      'require_id_check',
      'require_screen_recording',
      'require_webcam',
    ]);
  });
});

describe('OrgBrandingSchema', () => {
  it('accepts a fully populated branding block', () => {
    expect(
      OrgBrandingSchema.parse({
        display_name: 'Acme Talent',
        primary_colour: '#1f6feb',
        logo_url: 'https://cdn.example.test/acme.svg',
      }),
    ).toEqual({
      display_name: 'Acme Talent',
      primary_colour: '#1f6feb',
      logo_url: 'https://cdn.example.test/acme.svg',
    });
  });

  it.each([
    ['upper-case hex', '#1F6FEB'],
    ['three-digit shorthand', '#fff'],
    ['a CSS colour name', 'rebeccapurple'],
    ['an rgb() function', 'rgb(31, 111, 235)'],
  ])('refuses %s, so a value read back is the value that was written', (_label, colour) => {
    expect(OrgBrandingSchema.shape.primary_colour.safeParse(colour).success).toBe(false);
  });

  it.each([
    ['plain http', 'http://cdn.example.test/logo.svg'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['a quote that would break out of an attribute', 'https://x.test/a"onload=alert(1)'],
  ])('refuses %s as a logo URL', (_label, url) => {
    expect(OrgBrandingSchema.shape.logo_url.safeParse(url).success).toBe(false);
  });

  it('refuses a display name made only of whitespace', () => {
    expect(OrgBrandingSchema.shape.display_name.safeParse('   ').success).toBe(false);
  });

  it('treats null as “not set” rather than as an empty string', () => {
    expect(
      OrgBrandingSchema.parse({ display_name: null, primary_colour: null, logo_url: null }),
    ).toEqual({ display_name: null, primary_colour: null, logo_url: null });
    expect(OrgBrandingSchema.shape.display_name.safeParse('').success).toBe(false);
  });
});

describe('OrgSettingsPatchSchema', () => {
  it('accepts a single field and leaves the rest of the body absent', () => {
    expect(OrgSettingsPatchSchema.parse({ branding: { display_name: 'Acme Talent' } })).toEqual({
      branding: { display_name: 'Acme Talent' },
    });
  });

  it('accepts null as the way to clear a field', () => {
    expect(OrgSettingsPatchSchema.parse({ branding: { logo_url: null } })).toEqual({
      branding: { logo_url: null },
    });
  });

  it('refuses retention_days rather than discarding it', () => {
    // docs/11 §4.2 supersedes the docs/03 §13 spelling with five separately constrained
    // clocks, and a jsonb column carries no constraint — so this endpoint declines the
    // field rather than accepting a promise it cannot keep. Refusing is the point: a
    // stripped field would tell an administrator their retention policy had changed.
    const outcome = OrgSettingsPatchSchema.safeParse({
      branding: { display_name: 'Acme Talent' },
      retention_days: 30,
    });

    expect(outcome.success).toBe(false);
    // zod reports an unrecognised key against the object that carried it, naming the key
    // in `keys` rather than in `path` — which is why the route's issue mapping has a
    // branch for this code rather than joining the path and calling it a field name.
    expect(
      outcome.error?.issues.flatMap((issue) =>
        issue.code === 'unrecognized_keys' ? issue.keys : [],
      ),
    ).toEqual(['retention_days']);
  });

  it('refuses an unrecognised field inside a section too', () => {
    const outcome = OrgSettingsPatchSchema.safeParse({
      proctoring_defaults: { require_webcam: true, auto_void_on_focus_loss: true },
    });

    expect(outcome.success).toBe(false);
    const [issue] = outcome.error?.issues ?? [];
    expect(issue?.path.join('/')).toBe('proctoring_defaults');
    expect(issue?.code === 'unrecognized_keys' ? issue.keys : []).toEqual([
      'auto_void_on_focus_loss',
    ]);
  });

  it('refuses a body that names no section, so no audit row records a non-change', () => {
    expect(OrgSettingsPatchSchema.safeParse({}).success).toBe(false);
  });

  it('refuses a bad value with a path a client can act on', () => {
    const outcome = OrgSettingsPatchSchema.safeParse({
      branding: { primary_colour: 'not-a-colour' },
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error?.issues.map((issue) => issue.path.join('/'))).toEqual([
      'branding/primary_colour',
    ]);
  });
});

describe('projectOrgSettings()', () => {
  it('reads an empty document as the defaults', () => {
    expect(projectOrgSettings({})).toEqual(defaultOrgSettings());
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'settings'],
    ['an array', [1, 2, 3]],
    ['a number', 7],
  ])('reads %s as the defaults rather than throwing', (_label, stored) => {
    // Every one of these is legal jsonb and none of them is a settings document. A
    // GET that 500s because the column holds something odd is an outage for the one
    // administrator who could fix it.
    expect(projectOrgSettings(stored)).toEqual(defaultOrgSettings());
  });

  it('fills a field the stored document predates', () => {
    const projected = projectOrgSettings({ branding: { display_name: 'Acme Talent' } });

    expect(projected.branding).toEqual({
      display_name: 'Acme Talent',
      primary_colour: null,
      logo_url: null,
    });
  });

  it('never serves a key the schema does not name', () => {
    const projected = projectOrgSettings({
      branding: { display_name: 'Acme Talent', internal_note: 'do not show a client' },
      retention_days: 30,
      billing: { plan: 'enterprise' },
    });

    expect(JSON.stringify(projected)).not.toContain('internal_note');
    expect(JSON.stringify(projected)).not.toContain('enterprise');
    expect(Object.keys(projected).sort()).toEqual(['branding', 'proctoring_defaults']);
  });

  it('falls back to a section’s defaults when its stored value is malformed', () => {
    const projected = projectOrgSettings({
      branding: { primary_colour: 'chartreuse' },
      proctoring_defaults: { require_webcam: true },
    });

    // The bad section falls back; the good one beside it is unaffected, so one corrupt
    // value does not cost an administrator the rest of their configuration.
    expect(projected.branding).toEqual(defaultOrgSettings().branding);
    expect(projected.proctoring_defaults.require_webcam).toBe(true);
  });

  it('always produces something the response schema accepts', () => {
    for (const stored of [{}, null, 'x', { branding: 12 }, { proctoring_defaults: [] }]) {
      expect(OrgSettingsSchema.safeParse(projectOrgSettings(stored)).success).toBe(true);
    }
  });
});

describe('mergeOrgSettings()', () => {
  const current = {
    branding: {
      display_name: 'Acme Talent',
      primary_colour: '#1f6feb',
      logo_url: 'https://cdn.example.test/acme.svg',
    },
    proctoring_defaults: {
      require_webcam: true,
      require_screen_recording: false,
      require_id_check: false,
    },
  };

  it('changes one field and leaves its neighbours alone', () => {
    expect(mergeOrgSettings(current, { branding: { primary_colour: '#0b7285' } })).toEqual({
      ...current,
      branding: { ...current.branding, primary_colour: '#0b7285' },
    });
  });

  it('clears a field with null rather than deleting the key', () => {
    const next = mergeOrgSettings(current, { branding: { logo_url: null } });
    expect(next.branding.logo_url).toBeNull();
    expect(next.branding.display_name).toBe('Acme Talent');
  });

  it('leaves a section the patch does not mention exactly as it was', () => {
    expect(mergeOrgSettings(current, { branding: {} }).proctoring_defaults).toEqual(
      current.proctoring_defaults,
    );
  });

  it('does not mutate the document it was given', () => {
    mergeOrgSettings(current, { branding: { display_name: 'Something Else' } });
    expect(current.branding.display_name).toBe('Acme Talent');
  });
});

describe('OrgSettingsResponseSchema', () => {
  it('requires the organisation, the settings and the server clock (ADR-006)', () => {
    const body = {
      org: {
        id: '4a1c9e70-2b83-4d51-8f6a-0c7d5e91b204',
        name: 'Acme Ltd',
        slug: 'acme',
      },
      settings: defaultOrgSettings(),
      server_time: '2026-10-14T09:00:00Z',
    };

    expect(OrgSettingsResponseSchema.safeParse(body).success).toBe(true);
    expect(OrgSettingsResponseSchema.safeParse({ ...body, server_time: undefined }).success).toBe(
      false,
    );
  });
});

describe('the generated document', () => {
  const document = buildOpenApiDocument();

  it('describes both operations at the documented path', () => {
    const path = document.paths?.[ORG_SETTINGS_PATH];
    expect(path).toBeDefined();
    expect(Object.keys(path ?? {}).sort()).toEqual(['get', 'patch']);
  });

  it('states that both require a staff session', () => {
    expect(document.paths?.[ORG_SETTINGS_PATH]?.get?.security).toEqual([{ staffSession: [] }]);
    expect(document.paths?.[ORG_SETTINGS_PATH]?.patch?.security).toEqual([{ staffSession: [] }]);
  });

  it('answers not_found rather than forbidden for a row another tenant holds (ADR-010)', () => {
    // The 404 in the document is load-bearing: it is the difference between "no such
    // organisation" and "somebody else's organisation", and the whole point is that a
    // client cannot tell which.
    for (const operation of ['get', 'patch'] as const) {
      expect(document.paths?.[ORG_SETTINGS_PATH]?.[operation]?.responses?.['404']).toEqual({
        $ref: '#/components/responses/NotFound',
      });
    }
  });

  it('documents the validation failure only where a body can fail (docs/03 §2)', () => {
    expect(document.paths?.[ORG_SETTINGS_PATH]?.patch?.responses?.['422']).toEqual({
      $ref: '#/components/responses/ValidationFailed',
    });
    expect(document.paths?.[ORG_SETTINGS_PATH]?.get?.responses?.['422']).toBeUndefined();
  });

  it('publishes the settings schemas as components rather than inlining them twice', () => {
    const schemas = document.components?.schemas ?? {};
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'OrgSettingsResponse',
        'OrgSettings',
        'OrgBranding',
        'OrgProctoringDefaults',
        'OrgSettingsPatch',
        'OrgIdentity',
      ]),
    );
  });
});
