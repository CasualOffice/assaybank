/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  meetsContrast,
  parseColour,
  parseHexColour,
  parseOklchColour,
  relativeLuminance,
  toHex,
  WCAG_AA_NON_TEXT,
  WCAG_AA_TEXT,
} from './contrast.js';

describe('parseHexColour', () => {
  it('parses the six-digit form', () => {
    expect(parseHexColour('#14161A')).toEqual({ r: 0x14, g: 0x16, b: 0x1a });
  });

  it('parses the three-digit form by doubling each nibble', () => {
    expect(parseHexColour('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColour('#1a2')).toEqual({ r: 0x11, g: 0xaa, b: 0x22 });
  });

  it('is case-insensitive', () => {
    expect(parseHexColour('#c8963c')).toEqual(parseHexColour('#C8963C'));
  });

  it.each([
    ['no hash', '14161A'],
    ['too short', '#12'],
    ['too long', '#1234567'],
    ['not hex', '#12345g'],
    ['a css keyword', 'rebeccapurple'],
    ['empty', ''],
  ])('throws on %s', (_label, value) => {
    // A silent default would make a contrast test pass for the wrong reason, which is
    // worse than no contrast test at all.
    expect(() => parseHexColour(value)).toThrow(/Not a hex colour/u);
  });
});

describe('parseOklchColour', () => {
  it('converts the achromatic extremes', () => {
    expect(parseOklchColour('oklch(0% 0 0)')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseOklchColour('oklch(100% 0 0)')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('reproduces the brand ink and paper the generated assets are drawn in', () => {
    // brand/generate.py emits #111315 and #FAFAF8 for the same two OKLCH values. The
    // round trip here lands within a few 8-bit steps of those — two independent
    // implementations of the same conversion, rounding differently in the last place.
    // The tolerance is what the assertion is really about: the stylesheet and the SVG
    // have to be the same colour to the eye, not the same integer.
    const tolerance = 4;
    const ink = parseOklchColour('oklch(18% 0.006 250)');
    const paper = parseOklchColour('oklch(98% 0.004 95)');

    for (const [actual, expected] of [
      [ink.r, 0x11],
      [ink.g, 0x13],
      [ink.b, 0x15],
      [paper.r, 0xfa],
      [paper.g, 0xfa],
      [paper.b, 0xf8],
    ] as const) {
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('accepts a unit-interval lightness as well as a percentage', () => {
    expect(parseOklchColour('oklch(0.55 0.13 245)')).toEqual(
      parseOklchColour('oklch(55% 0.13 245)'),
    );
  });

  it('moves lightness monotonically, which is the property the ramps rely on', () => {
    const steps = [0.2, 0.4, 0.6, 0.8].map((lightness) =>
      relativeLuminance(parseOklchColour(`oklch(${lightness} 0.1 245)`)),
    );

    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index] ?? 0).toBeGreaterThan(steps[index - 1] ?? 0);
    }
  });

  it('clamps out-of-gamut chroma into sRGB rather than producing a nonsense channel', () => {
    const colour = parseOklchColour('oklch(60% 0.4 140)');

    for (const channel of [colour.r, colour.g, colour.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
      expect(Number.isInteger(channel)).toBe(true);
    }
  });

  it.each([
    ['a missing component', 'oklch(55% 0.13)'],
    ['an alpha channel', 'oklch(55% 0.13 245 / 0.5)'],
    ['a hue unit', 'oklch(55% 0.13 245deg)'],
    ['a different function', 'lch(55% 0.13 245)'],
  ])('throws on %s', (_label, value) => {
    expect(() => parseOklchColour(value)).toThrow(/Not an oklch colour/u);
  });
});

describe('parseColour', () => {
  it('accepts either notation the token layer uses', () => {
    expect(parseColour('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColour('oklch(100% 0 0)')).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe('toHex', () => {
  it('round-trips a hex colour', () => {
    expect(toHex(parseHexColour('#0a1b2c'))).toBe('#0a1b2c');
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance(parseHexColour('#000000'))).toBe(0);
    expect(relativeLuminance(parseHexColour('#ffffff'))).toBe(1);
  });

  it('weights green most heavily, per the sRGB coefficients', () => {
    const red = relativeLuminance(parseHexColour('#ff0000'));
    const green = relativeLuminance(parseHexColour('#00ff00'));
    const blue = relativeLuminance(parseHexColour('#0000ff'));

    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
    expect(red + green + blue).toBeCloseTo(1, 10);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black against white — the maximum the formula can produce', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
  });

  it('is 1 for a colour against itself', () => {
    expect(contrastRatio('oklch(55% 0.13 245)', 'oklch(55% 0.13 245)')).toBeCloseTo(1, 10);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#14161A', '#FAFAF7')).toBeCloseTo(
      contrastRatio('#FAFAF7', '#14161A'),
      10,
    );
  });

  it('mixes notations, so a theme can be compared against a hard-coded editor colour', () => {
    // The M2 Monaco theme test walks a token table written in hex against a background
    // written in OKLCH; this is the property that makes that possible.
    expect(contrastRatio('oklch(98% 0.004 95)', '#000000')).toBeGreaterThan(18);
  });
});

describe('meetsContrast', () => {
  it('accepts a pair at exactly the threshold', () => {
    // #767676 on white is the canonical 4.54:1 pair used in the WCAG examples.
    expect(meetsContrast('#767676', '#ffffff', WCAG_AA_TEXT)).toBe(true);
  });

  it('rejects the brand caution colour as text on paper, which is why it is darkened', () => {
    // brand/README.md gives --ab-caution as oklch(72% 0.14 75). At that lightness it is
    // a legible indicator and an illegible label, so LIGHT_PALETTE.warning drops to 48%.
    // Asserted rather than assumed: shipping the brand value as a text token is the
    // mistake that looks like fidelity.
    expect(meetsContrast('oklch(72% 0.14 75)', 'oklch(98% 0.004 95)', WCAG_AA_TEXT)).toBe(false);
    expect(meetsContrast('oklch(48% 0.11 75)', 'oklch(98% 0.004 95)', WCAG_AA_TEXT)).toBe(true);
  });

  it('accepts the brand signal as a non-text indicator on paper and on ink alike', () => {
    // The accent has to work at both ends, because the focus ring is drawn in it.
    expect(meetsContrast('oklch(55% 0.13 245)', 'oklch(98% 0.004 95)', WCAG_AA_NON_TEXT)).toBe(
      true,
    );
    expect(meetsContrast('oklch(55% 0.13 245)', 'oklch(18% 0.006 250)', WCAG_AA_NON_TEXT)).toBe(
      true,
    );
  });
});
