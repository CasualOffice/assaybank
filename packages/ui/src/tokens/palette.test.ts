/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gate that makes the token layer a claim rather than an intention.
 *
 * Four things are asserted, and each is a thing that silently rots otherwise:
 *
 * 1. Every text pair clears SC 1.4.3 at 4.5:1 and every control pair clears SC 1.4.11 at
 *    3:1, **in both themes**. A dark theme built by eye is where contrast failures live.
 * 2. `styles/tokens.css` and `palette.ts` agree in both directions. A colour changed in
 *    one and not the other is a half-applied theme.
 * 3. The brand's own values still fail where the palette says they fail — the caution
 *    yellow is not readable as text on paper, which is why `warning` is darker than
 *    `--ab-caution`. If somebody "corrects" it back to the brand value, a test says why.
 * 4. The rules brand/README.md states in prose — the accent never appears in the mark,
 *    the accent is never body text — are asserted rather than reviewed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { contrastRatio, parseColour, toHex, WCAG_AA_NON_TEXT, WCAG_AA_TEXT } from './contrast.js';
import {
  BRAND_COLOURS,
  cssVariable,
  cssVariableName,
  DARK_PALETTE,
  FOCUS_RING_SURFACES,
  LIGHT_PALETTE,
  NON_TEXT_CONTRAST_PAIRS,
  type Palette,
  PALETTES,
  SEMANTIC_TOKENS,
  type SemanticToken,
  TEXT_CONTRAST_PAIRS,
  type ThemeName,
} from './palette.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = readFileSync(join(HERE, '..', 'styles', 'tokens.css'), 'utf8');

const THEME_NAMES: readonly ThemeName[] = ['light', 'dark'];

/** Whitespace inside `oklch(...)` is not meaningful; neither is the case of a hex digit. */
function normalise(colour: string): string {
  return colour.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** A colour and its sRGB form, so a failure message says what the eye would have seen. */
function describeColour(token: SemanticToken, palette: Palette): string {
  return `${token} ${palette[token]} (${toHex(parseColour(palette[token]))})`;
}

/**
 * Pulls the `--ab-*: light-dark(a, b)` declarations out of the marked block.
 *
 * Parsing the stylesheet rather than importing a generated module is deliberate: the
 * thing that has to be correct is the file the browser loads.
 */
function parseLightDarkBlock(): Map<string, { light: string; dark: string }> {
  const block = /\/\* @ab-tokens light-dark \*\/([\s\S]*?)\/\* @ab-tokens end \*\//u.exec(
    TOKENS_CSS,
  );
  const body = block?.[1];
  if (body === undefined) {
    throw new Error('tokens.css must contain the @ab-tokens light-dark block');
  }

  const declarations = new Map<string, { light: string; dark: string }>();
  const pattern = /(--ab-[a-z-]+):\s*light-dark\(\s*(oklch\([^)]*\))\s*,\s*(oklch\([^)]*\))\s*\)/gu;

  for (const match of body.matchAll(pattern)) {
    const [, name, light, dark] = match;
    if (name === undefined || light === undefined || dark === undefined) {
      continue;
    }
    declarations.set(name, { light: normalise(light), dark: normalise(dark) });
  }

  return declarations;
}

/** Pulls the plain `--ab-*: oklch(...)` declarations out of the no-light-dark fallback. */
function parseFallbackBlock(): Map<string, string> {
  const block = /\/\* @ab-tokens fallback-light \*\/([\s\S]*?)\/\* @ab-tokens end \*\//u.exec(
    TOKENS_CSS,
  );
  const body = block?.[1];
  if (body === undefined) {
    throw new Error('tokens.css must contain the @ab-tokens fallback-light block');
  }

  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/(--ab-[a-z-]+):\s*(oklch\([^)]*\))\s*;/gu)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) {
      continue;
    }
    declarations.set(name, normalise(value));
  }

  return declarations;
}

describe('the palette clears WCAG AA', () => {
  for (const theme of THEME_NAMES) {
    const palette = PALETTES[theme];

    describe(`${theme} theme`, () => {
      it.each(
        TEXT_CONTRAST_PAIRS.map((pair): [SemanticToken, SemanticToken] => [pair[0], pair[1]]),
      )('%s on %s clears 4.5:1 (SC 1.4.3)', (foreground, background) => {
        const ratio = contrastRatio(palette[foreground], palette[background]);
        expect(
          ratio,
          `${describeColour(foreground, palette)} on ${describeColour(background, palette)} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
      });

      it.each(
        NON_TEXT_CONTRAST_PAIRS.map((pair): [SemanticToken, SemanticToken] => [pair[0], pair[1]]),
      )('%s on %s clears 3:1 (SC 1.4.11)', (foreground, background) => {
        const ratio = contrastRatio(palette[foreground], palette[background]);
        expect(
          ratio,
          `${describeColour(foreground, palette)} on ${describeColour(background, palette)} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
      });

      it.each(FOCUS_RING_SURFACES.map((surface): [SemanticToken] => [surface]))(
        'the two-tone focus ring is visible on %s',
        (surface) => {
          // The ring is an outline in `focus` with an adjacent ring in `focus-offset`.
          // It is visible when *either* tone clears 3:1 — which is the whole reason the
          // indicator is two-tone rather than one colour that happens to work on the page
          // background and vanish on an inverse panel.
          const ring = contrastRatio(palette.focus, palette[surface]);
          const halo = contrastRatio(palette['focus-offset'], palette[surface]);

          expect(
            Math.max(ring, halo),
            `focus ${ring.toFixed(2)}:1 / offset ${halo.toFixed(2)}:1 against ${surface}`,
          ).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
        },
      );

      it('has a parseable value for every semantic token', () => {
        for (const token of SEMANTIC_TOKENS) {
          expect(() => parseColour(palette[token]), `${theme} ${token}`).not.toThrow();
        }
      });

      it('declares no token the semantic list does not name', () => {
        expect(Object.keys(palette).sort()).toEqual([...SEMANTIC_TOKENS].sort());
      });
    });
  }
});

describe('surface-inverse is the one surface the accent may not touch', () => {
  it('is excluded from the validated non-text pairs on purpose', () => {
    const pairs = NON_TEXT_CONTRAST_PAIRS.map(([a, b]) => `${a}|${b}`);

    expect(pairs).not.toContain('accent|surface-inverse');
    expect(pairs).not.toContain('focus|surface-inverse');
  });

  it('is excluded because no single accent value can clear 3:1 on it in both themes', () => {
    // The light theme's inverse panel is ink and the dark theme's is paper, so the pair
    // asks one blue to work at both ends. Asserting the failure that motivates the
    // exclusion is what stops the exclusion being mistaken for an oversight.
    const light = contrastRatio(LIGHT_PALETTE.accent, LIGHT_PALETTE['surface-inverse']);
    const dark = contrastRatio(DARK_PALETTE.accent, DARK_PALETTE['surface-inverse']);

    expect(Math.min(light, dark)).toBeLessThan(WCAG_AA_NON_TEXT);
  });

  it('still carries readable text, which is all it is for', () => {
    for (const theme of THEME_NAMES) {
      const palette = PALETTES[theme];
      expect(
        contrastRatio(palette['text-inverse'], palette['surface-inverse']),
      ).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    }
  });
});

describe('the brand rules, asserted rather than reviewed', () => {
  it('keeps ink and paper as the two poles of both themes', () => {
    expect(normalise(LIGHT_PALETTE.surface)).toBe(normalise(BRAND_COLOURS.paper));
    expect(normalise(LIGHT_PALETTE.text)).toBe(normalise(BRAND_COLOURS.ink));
    expect(normalise(DARK_PALETTE.surface)).toBe(normalise(BRAND_COLOURS.ink));
    expect(normalise(DARK_PALETTE.text)).toBe(normalise(BRAND_COLOURS.paper));
  });

  it('uses the brand signal as the light theme accent, unmodified', () => {
    expect(normalise(LIGHT_PALETTE.accent)).toBe(normalise(BRAND_COLOURS.signal));
    expect(normalise(LIGHT_PALETTE.focus)).toBe(normalise(BRAND_COLOURS.signal));
  });

  it('never uses the accent as a text token in either theme', () => {
    // brand/README.md: the accent is "Interactive state only — focus, selection, active
    // nav". `accent-text` exists for a link label and is a different, darker value.
    const textTokens = ['text', 'text-muted', 'text-inverse'] as const;
    for (const theme of THEME_NAMES) {
      for (const token of textTokens) {
        expect(normalise(PALETTES[theme][token])).not.toBe(normalise(PALETTES[theme].accent));
      }
    }
  });

  it('publishes no token that invites the accent into the mark', () => {
    // The mark is drawn from --ab-ink, --ab-paper or currentColor, and "the accent never
    // appears in the logo" is the first misuse brand/README.md names. The token layer
    // therefore publishes ink and paper and offers no "brand accent" alias to reach for.
    expect(TOKENS_CSS).toContain('--ab-ink:');
    expect(TOKENS_CSS).toContain('--ab-paper:');
    expect(TOKENS_CSS).not.toMatch(/--ab-mark[a-z-]*:/u);
    expect(TOKENS_CSS).not.toMatch(/--ab-logo[a-z-]*:/u);
  });

  it('darkens the caution hue for text rather than shipping the brand lightness', () => {
    const paper = LIGHT_PALETTE.surface;

    expect(contrastRatio(BRAND_COLOURS.caution, paper)).toBeLessThan(WCAG_AA_TEXT);
    expect(contrastRatio(LIGHT_PALETTE.warning, paper)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it('lightens the critical hue for the dark theme rather than reusing one status ramp', () => {
    const ink = DARK_PALETTE.surface;

    expect(contrastRatio(BRAND_COLOURS.critical, ink)).toBeLessThan(WCAG_AA_TEXT);
    expect(contrastRatio(DARK_PALETTE.danger, ink)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });
});

describe('styles/tokens.css matches palette.ts', () => {
  const lightDark = parseLightDarkBlock();
  const fallback = parseFallbackBlock();

  it('declares the three brand constants verbatim', () => {
    expect(TOKENS_CSS).toContain(`--ab-ink: ${BRAND_COLOURS.ink};`);
    expect(TOKENS_CSS).toContain(`--ab-paper: ${BRAND_COLOURS.paper};`);
    expect(TOKENS_CSS).toContain(`--ab-signal: ${BRAND_COLOURS.signal};`);
  });

  it.each(SEMANTIC_TOKENS.map((token): [SemanticToken] => [token]))(
    '%s has the same light and dark value in both files',
    (token) => {
      const declared = lightDark.get(cssVariableName(token));
      expect(declared, `tokens.css does not declare ${cssVariableName(token)}`).toBeDefined();
      expect(declared?.light).toBe(normalise(LIGHT_PALETTE[token]));
      expect(declared?.dark).toBe(normalise(DARK_PALETTE[token]));
    },
  );

  it('declares nothing the palette does not name — the other direction of the drift check', () => {
    const expected = SEMANTIC_TOKENS.map((token) => cssVariableName(token)).sort();
    expect([...lightDark.keys()].sort()).toEqual(expected);
  });

  it('degrades to the light theme where light-dark() is unsupported', () => {
    const expected = new Map(
      SEMANTIC_TOKENS.map((token) => [cssVariableName(token), normalise(LIGHT_PALETTE[token])]),
    );
    expect(Object.fromEntries(fallback)).toEqual(Object.fromEntries(expected));
  });

  it('switches theme with color-scheme rather than by redeclaring colours', () => {
    // If a future edit duplicates the palette under [data-ab-theme='dark'], the drift
    // check above stops covering the values a dark-mode user actually sees.
    expect(TOKENS_CSS).toContain("data-ab-theme='light'");
    expect(TOKENS_CSS).toContain("data-ab-theme='dark'");
    expect(TOKENS_CSS).toMatch(/:root\[data-ab-theme='dark'\]\s*\{\s*color-scheme:\s*dark;\s*\}/u);
  });
});

describe('css variable helpers', () => {
  it('names a token as its custom property', () => {
    expect(cssVariableName('surface-raised')).toBe('--ab-surface-raised');
  });

  it('wraps it for use in an attribute', () => {
    expect(cssVariable('accent')).toBe('var(--ab-accent)');
  });
});
