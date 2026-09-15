/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour arithmetic: OKLCH to sRGB, and WCAG 2.1 relative luminance and contrast.
 *
 * Two documents converge on this module. brand/README.md authors every token in **OKLCH**,
 * because a perceptually uniform space is what makes a generated lightness ramp look like
 * a ramp. docs/15-accessibility-conformance.md §7 insists that a contrast ratio is
 * arithmetic and a theme is a data file, so "there is no excuse for checking it by hand
 * once and never again". The consequence is that the token layer needs to convert what
 * the designer writes into the space the criterion is defined in, and it needs to do it
 * in code rather than in a colour-picker tab that nobody re-opens.
 *
 * Pure: no DOM, no `getComputedStyle`, no colour library. `palette.test.ts` is the
 * consumer today; the Monaco theme test of docs/15 §7 is the one M2 adds.
 *
 * References: WCAG 2.1 Understanding SC 1.4.3 (relative luminance); CSS Color 4 §9
 * (OKLab/OKLCH, and the OKLab-to-linear-sRGB matrices).
 */

/** A colour decomposed into 8-bit sRGB channels. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** WCAG 2.1 SC 1.4.3 minimum for body text. */
export const WCAG_AA_TEXT = 4.5;

/** WCAG 2.1 SC 1.4.3 minimum for large text (18.66px bold, or 24px). */
export const WCAG_AA_LARGE_TEXT = 3;

/**
 * WCAG 2.1 SC 1.4.11 minimum for user-interface components and graphical objects —
 * control boundaries, focus indicators, state glyphs.
 */
export const WCAG_AA_NON_TEXT = 3;

const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u;

/**
 * `oklch(L C H)` in the subset brand/README.md and the token layer use: a percentage or
 * unit-interval lightness, a unitless chroma, a degree hue. No alpha, no `none`, no
 * relative-colour syntax — a token that needs any of those is a token that has stopped
 * being a token.
 */
const OKLCH_COLOUR = /^oklch\(\s*(\d+(?:\.\d+)?)(%?)\s+(\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/u;

/**
 * Parses `#rgb` or `#rrggbb` into channels.
 *
 * Throws rather than returning a default: a malformed colour in a design token is a
 * mistake to surface at the point it was written, and a silent black would make a
 * contrast test pass for the wrong reason.
 */
export function parseHexColour(hex: string): Rgb {
  if (!HEX_COLOUR.test(hex)) {
    throw new Error(`Not a hex colour: ${JSON.stringify(hex)}. Expected #rgb or #rrggbb.`);
  }

  const body = hex.slice(1);
  const expanded =
    body.length === 3 ? Array.from(body, (character) => `${character}${character}`).join('') : body;

  const value = Number.parseInt(expanded, 16);

  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

/** Encodes one linear-light channel with the sRGB transfer function. */
function encodeSrgb(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/**
 * Parses `oklch(L C H)` and converts it to 8-bit sRGB.
 *
 * Out-of-gamut colours are clamped per channel rather than gamut-mapped. That is the
 * crude answer, and it is the safe one here: clamping can only move a colour towards a
 * channel extreme, so a token that clears its contrast threshold after clamping clears it
 * in the browser too. Every token in `palette.ts` is inside sRGB anyway — the contrast
 * requirements keep the chroma well below the boundary.
 */
export function parseOklchColour(value: string): Rgb {
  const match = OKLCH_COLOUR.exec(value.trim());

  if (match === null) {
    throw new Error(
      `Not an oklch colour: ${JSON.stringify(value)}. Expected oklch(L% C H), as in ` +
        'oklch(55% 0.13 245).',
    );
  }

  const [, rawLightness, percent, rawChroma, rawHue] = match;
  const lightness = Number(rawLightness) / (percent === '%' ? 100 : 1);
  const chroma = Number(rawChroma);
  const hueRadians = (Number(rawHue) * Math.PI) / 180;

  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);

  // OKLab to the cone-response space, cubed back out of its cube root.
  const long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const linearRed = 4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short;
  const linearGreen = -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short;
  const linearBlue = -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short;

  return {
    r: Math.round(encodeSrgb(linearRed) * 255),
    g: Math.round(encodeSrgb(linearGreen) * 255),
    b: Math.round(encodeSrgb(linearBlue) * 255),
  };
}

/** Parses either notation the token layer uses. */
export function parseColour(value: string): Rgb {
  return value.trimStart().startsWith('oklch') ? parseOklchColour(value) : parseHexColour(value);
}

/** The `#rrggbb` form of a colour, for a message or a snapshot. */
export function toHex(colour: Rgb): string {
  const channel = (value: number): string => value.toString(16).padStart(2, '0');
  return `#${channel(colour.r)}${channel(colour.g)}${channel(colour.b)}`;
}

/** Linearises one 8-bit sRGB channel, per the WCAG definition. */
function linearise(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance, in `[0, 1]`. */
export function relativeLuminance(colour: Rgb): number {
  return 0.2126 * linearise(colour.r) + 0.7152 * linearise(colour.g) + 0.0722 * linearise(colour.b);
}

/**
 * The contrast ratio between two colours, in `[1, 21]`. Each may be hex or OKLCH.
 *
 * Symmetric: the order of the arguments does not matter, which is why a "foreground" and
 * "background" naming would be misleading here.
 */
export function contrastRatio(a: string, b: string): number {
  const luminanceA = relativeLuminance(parseColour(a));
  const luminanceB = relativeLuminance(parseColour(b));
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);

  return (lighter + 0.05) / (darker + 0.05);
}

/** True when `a` against `b` clears `minimum`. */
export function meetsContrast(a: string, b: string, minimum: number): boolean {
  return contrastRatio(a, b) >= minimum;
}
