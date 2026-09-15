/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The design tokens, as data.
 *
 * brand/README.md gives six colours and a position about them: *the identity is
 * monochrome*, ink on paper and paper on ink, with one accent that is a user-interface
 * concern rather than an identity one. Six colours is a brand, not a design system, so
 * this module is the layer between — a semantic alias for every role a screen actually
 * needs, with a light and a dark value for each, derived from the brand's six by moving
 * lightness and leaving hue alone. That derivation is the reason the brand authors in
 * OKLCH: a lightness ramp in a perceptually uniform space looks like a ramp, which is
 * not true in HSL and matters the moment you generate one.
 *
 * **This file is the source of truth and `../styles/tokens.css` is a transcription of
 * it.** `palette.test.ts` parses that stylesheet and fails if the two disagree in either
 * direction, so a colour cannot be changed in one place and not the other. The same test
 * computes every contrast pair; a token set that does not clear AA does not ship.
 *
 * **Three rules from brand/README.md are encoded here rather than remembered:**
 *
 * 1. *The accent never appears in the mark.* The lockup and the mark take `currentColor`
 *    or the ink and paper tokens, and there is no code path in this package that puts
 *    `--ab-accent` inside the logo.
 * 2. *The accent is interactive state only* — focus, selection, active navigation. There
 *    are two accent tokens and neither is a body-text colour: `accent` is the indicator
 *    value that clears SC 1.4.11 at 3:1, and `accent-text` is the darker form for a link
 *    or an active nav label that clears SC 1.4.3 at 4.5:1. A token that does not exist
 *    cannot be reached for.
 * 3. *Colour is never the only carrier of meaning*, anywhere, including a pass/fail state
 *    (SC 1.4.1, docs/15 §6.3). Every component in this package that takes a `tone` also
 *    renders that tone as text.
 *
 * And one that is this file's own: **`warning`/`caution` marks something for a human to
 * look at and never communicates a decision the system made**, because the system does
 * not make them (ADR-007, ADR-017).
 */

/**
 * The six brand constants from brand/README.md, in the OKLCH they are authored in.
 *
 * Theme-invariant. A screen never references one of these directly — it references a
 * semantic alias, so a brand change is a change to this file rather than to thirty
 * components. They are exported because the mark, the favicon and the raster icons are
 * drawn from ink and paper, and those three have to agree with the stylesheet.
 */
export const BRAND_COLOURS = Object.freeze({
  /** Primary surface-on-light, text, and the mark. */
  ink: 'oklch(18% 0.006 250)',
  /** Primary surface-on-dark, and the mark inverted. */
  paper: 'oklch(98% 0.004 95)',
  /** The single accent. Interactive state only — focus, selection, active nav. */
  signal: 'oklch(55% 0.13 245)',
  /** Pass, complete. */
  positive: 'oklch(58% 0.12 150)',
  /** Flagged for a human to review — never a verdict (ADR-007). */
  caution: 'oklch(72% 0.14 75)',
  /** Destructive action, validation failure. */
  critical: 'oklch(58% 0.19 27)',
});

/**
 * Every semantic alias a screen is allowed to name.
 *
 * A component references a role ("surface-raised"), never a brand constant.
 */
export const SEMANTIC_TOKENS = [
  /* Surfaces, back to front. `surface-inverse` is the deliberate opposite — an ink panel
     in the light theme and a paper one in the dark theme. It carries `text-inverse` and
     nothing else: the accent and the focus colour flip meaning across themes, so neither
     is valid on it, and `palette.test.ts` asserts that rather than leaving it as folklore. */
  'surface',
  'surface-raised',
  'surface-sunken',
  'surface-inverse',

  /* Text. */
  'text',
  'text-muted',
  'text-inverse',

  /* Lines. `border` is decorative; `border-strong` is a control boundary and clears
     SC 1.4.11 at 3:1 against every ordinary surface. */
  'border',
  'border-strong',

  /* The accent, in two forms, neither of which is a body-text colour. `accent` is the
     indicator — the focus ring, the selected row, the active-tab rule. `accent-text` is
     the same hue darkened (lightened, in the dark theme) until a link or an active nav
     label built from it clears 4.5:1. */
  'accent',
  'accent-text',

  /* The focus indicator (SC 2.4.7). Two-tone — see FOCUS_RING_SURFACES. */
  'focus',
  'focus-offset',

  /* Status. Each pairs a readable text colour with a tinted surface. */
  'danger',
  'danger-surface',
  'success',
  'success-surface',
  'warning',
  'warning-surface',
  'info',
  'info-surface',
] as const;

/** One of the semantic aliases. */
export type SemanticToken = (typeof SEMANTIC_TOKENS)[number];

/** A complete set of semantic colours: one CSS colour value per token. */
export type Palette = Readonly<Record<SemanticToken, string>>;

/** The two themes this package ships. */
export type ThemeName = 'light' | 'dark';

/**
 * The light theme. Paper-backed, ink text.
 *
 * The status hues keep the brand's hue angles and drop lightness until they clear 4.5:1
 * on paper — `caution` at its brand lightness of 72% is 2.0:1 on paper, so shipping the
 * brand value as a text colour would be a contrast failure that looks like fidelity.
 * Ratios, computed in `palette.test.ts`: text 17.9:1, text-muted 7.2:1, accent-text
 * 6.0:1, danger 7.5:1, success 6.9:1, warning 7.0:1, border-strong 3.4:1.
 */
export const LIGHT_PALETTE: Palette = Object.freeze({
  surface: 'oklch(98% 0.004 95)',
  'surface-raised': 'oklch(100% 0 95)',
  'surface-sunken': 'oklch(95% 0.004 95)',
  'surface-inverse': 'oklch(18% 0.006 250)',

  text: 'oklch(18% 0.006 250)',
  'text-muted': 'oklch(46% 0.008 250)',
  'text-inverse': 'oklch(98% 0.004 95)',

  border: 'oklch(90% 0.004 95)',
  'border-strong': 'oklch(62% 0.008 250)',

  accent: 'oklch(55% 0.13 245)',
  'accent-text': 'oklch(48% 0.13 245)',

  focus: 'oklch(55% 0.13 245)',
  'focus-offset': 'oklch(98% 0.004 95)',

  danger: 'oklch(48% 0.19 27)',
  'danger-surface': 'oklch(96% 0.025 27)',
  success: 'oklch(46% 0.12 150)',
  'success-surface': 'oklch(96% 0.03 150)',
  warning: 'oklch(48% 0.11 75)',
  'warning-surface': 'oklch(96% 0.04 75)',
  info: 'oklch(48% 0.13 245)',
  'info-surface': 'oklch(96% 0.03 245)',
});

/**
 * The dark theme. Ink-backed, paper text.
 *
 * Not a lightness inversion of the light theme, which is the shortcut that produces a
 * dark mode that "looks fine" and fails SC 1.4.3 on half its status colours. Each status
 * hue is lightened past its brand value — `critical` at 58% on an ink surface is 3.3:1,
 * so at 80% it is a readable message rather than a decorative red — and the tinted
 * surfaces are darkened to match.
 */
export const DARK_PALETTE: Palette = Object.freeze({
  surface: 'oklch(18% 0.006 250)',
  'surface-raised': 'oklch(23% 0.006 250)',
  'surface-sunken': 'oklch(14% 0.006 250)',
  'surface-inverse': 'oklch(98% 0.004 95)',

  text: 'oklch(98% 0.004 95)',
  'text-muted': 'oklch(76% 0.008 250)',
  'text-inverse': 'oklch(18% 0.006 250)',

  border: 'oklch(30% 0.006 250)',
  'border-strong': 'oklch(58% 0.008 250)',

  accent: 'oklch(72% 0.13 245)',
  'accent-text': 'oklch(78% 0.11 245)',

  focus: 'oklch(75% 0.13 245)',
  'focus-offset': 'oklch(18% 0.006 250)',

  danger: 'oklch(80% 0.11 27)',
  'danger-surface': 'oklch(28% 0.07 27)',
  success: 'oklch(80% 0.11 150)',
  'success-surface': 'oklch(27% 0.06 150)',
  warning: 'oklch(83% 0.11 75)',
  'warning-surface': 'oklch(28% 0.06 75)',
  info: 'oklch(80% 0.09 245)',
  'info-surface': 'oklch(28% 0.06 245)',
});

/** Both themes, by name. */
export const PALETTES: Readonly<Record<ThemeName, Palette>> = Object.freeze({
  light: LIGHT_PALETTE,
  dark: DARK_PALETTE,
});

/** The CSS custom-property name a token is published under. */
export function cssVariableName(token: SemanticToken): string {
  return `--ab-${token}`;
}

/**
 * A `var()` reference to a token, for an inline style or an SVG attribute.
 *
 * Components use class names from `styles/components.css` rather than inline styles; this
 * exists for the places where a value genuinely has to reach an attribute.
 */
export function cssVariable(token: SemanticToken): string {
  return `var(${cssVariableName(token)})`;
}

/**
 * The pairs that must clear SC 1.4.3 at 4.5:1, in both themes.
 *
 * Exported rather than kept inside the test because the candidate app and the staff
 * console will both add themes — the high-contrast editor themes of docs/15 §7 — and each
 * of them has to satisfy the same list. A new semantic pair is added here once.
 */
export const TEXT_CONTRAST_PAIRS: readonly (readonly [SemanticToken, SemanticToken])[] =
  Object.freeze([
    ['text', 'surface'],
    ['text', 'surface-raised'],
    ['text', 'surface-sunken'],
    ['text-muted', 'surface'],
    ['text-muted', 'surface-raised'],
    ['text-muted', 'surface-sunken'],
    ['text-inverse', 'surface-inverse'],
    ['accent-text', 'surface'],
    ['accent-text', 'surface-raised'],
    ['accent-text', 'surface-sunken'],
    ['danger', 'surface'],
    ['danger', 'surface-raised'],
    ['danger', 'danger-surface'],
    ['text', 'danger-surface'],
    ['success', 'surface'],
    ['success', 'surface-raised'],
    ['success', 'success-surface'],
    ['text', 'success-surface'],
    ['warning', 'surface'],
    ['warning', 'surface-raised'],
    ['warning', 'warning-surface'],
    ['text', 'warning-surface'],
    ['info', 'surface'],
    ['info', 'surface-raised'],
    ['info', 'info-surface'],
    ['text', 'info-surface'],
  ] as const);

/**
 * The pairs that must clear SC 1.4.11 at 3:1 — control boundaries and the accent where it
 * carries a graphical object rather than decoration.
 *
 * `surface-inverse` is absent on purpose, and the absence is tested: it is the one
 * surface whose meaning flips between themes, so no single accent or focus value can
 * clear 3:1 on it in both. The answer is not a cleverer blue, it is that an inverse panel
 * carries `text-inverse` and nothing else.
 */
export const NON_TEXT_CONTRAST_PAIRS: readonly (readonly [SemanticToken, SemanticToken])[] =
  Object.freeze([
    ['border-strong', 'surface'],
    ['border-strong', 'surface-raised'],
    ['border-strong', 'surface-sunken'],
    ['accent', 'surface'],
    ['accent', 'surface-raised'],
    ['accent', 'surface-sunken'],
    ['focus', 'surface'],
    ['focus', 'surface-raised'],
    ['focus', 'surface-sunken'],
  ] as const);

/**
 * The surfaces the focus ring has to be visible against — which is all of them, including
 * the inverse one.
 *
 * `focus` alone cannot manage that, for the reason above. The indicator is therefore
 * two-tone (`styles/base.css`): an outline in `focus` with an adjacent ring in
 * `focus-offset`, which is ink or paper. At least one of the two clears 3:1 against any
 * surface in the system, and that is the property `palette.test.ts` asserts against this
 * list rather than against a single colour.
 */
export const FOCUS_RING_SURFACES: readonly SemanticToken[] = Object.freeze([
  'surface',
  'surface-raised',
  'surface-sunken',
  'surface-inverse',
  'danger-surface',
  'success-surface',
  'warning-surface',
  'info-surface',
]);
