/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ReactNode, useId } from 'react';

/**
 * The mark's geometry: a ring sheared along a cut, drawn as two arcs offset perpendicular
 * to the cut axis, with **unequal stroke weights**.
 *
 * brand/README.md is explicit that the inequality is the idea, not a detail — "the heavy
 * arc is the sample; the light arc is the reference. A symmetrical version of this mark
 * is a loading spinner; the asymmetry is what makes it ours." `Lockup.test.tsx` asserts
 * the asymmetry rather than the coordinates, so a regenerated brand does not turn a green
 * suite red over a rounding change, but equalising the weights does fail.
 *
 * Transcribed from `brand/assaybank-mark.svg` and `brand/assaybank-wordmark.svg`, which
 * `brand/generate.py` emits. It is a transcription rather than an `<img src>` because
 * both halves must inherit `currentColor` — the brand ships the mark that way precisely
 * so there is one mark and not six colourways, and an `<img>` cannot inherit a colour.
 * Re-transcribe when the generator's letterforms or arc weights change.
 */
const MARK_ARCS = [
  {
    /** The heavy arc: the sample. */
    d: 'M63.50 74.85 A 31 31 0 0 1 32.50 21.15',
    strokeWidth: 17,
    transform: 'translate(-4.33,2.50)',
  },
  {
    /** The light arc: the reference against which the sample is assayed. */
    d: 'M32.50 21.15 A 31 31 0 0 1 63.50 74.85',
    strokeWidth: 9,
    transform: 'translate(4.33,-2.50)',
  },
] as const;

/**
 * The wordmark, drawn as geometry rather than set in a typeface.
 *
 * brand/README.md: "it renders identically everywhere, carries no font licence, and
 * cannot be approximated by someone with the same font." Setting it in a substitute
 * typeface is named misuse, which is why this is a path and not a `<span>`.
 */
const WORDMARK_PATH =
  'M8.5 50.0 A 36.5 41.5 0 1 1 81.5 50.0 A 36.5 41.5 0 1 1 8.5 50.0 M81.5 0 V 100.0 ' +
  'M161.6 20.5 A 29.9 20.8 0 1 0 134.5 50.0 A 29.9 20.8 0 1 1 107.3 79.5 ' +
  'M247.5 20.5 A 29.9 20.8 0 1 0 220.4 50.0 A 29.9 20.8 0 1 1 193.2 79.5 ' +
  'M272.3 50.0 A 36.5 41.5 0 1 1 345.4 50.0 A 36.5 41.5 0 1 1 272.3 50.0 M345.4 0 V 100.0 ' +
  'M355.9 0 L397.9 86.0 M439.9 0 L381.1 138.0 M465.4 -38.0 V 100.0 ' +
  'M465.4 50.0 A 36.5 41.5 0 1 1 538.4 50.0 A 36.5 41.5 0 1 1 465.4 50.0 ' +
  'M561.4 50.0 A 36.5 41.5 0 1 1 634.5 50.0 A 36.5 41.5 0 1 1 561.4 50.0 M634.5 0 V 100.0 ' +
  'M657.5 0 V 100.0 M657.5 50.0 A 36.5 41.5 0 0 1 730.5 50.0 V 100.0 M752.5 -38.0 V 100.0 ' +
  'M823.6 20.0 L757.6 62.0 M761.9 50.0 L825.6 100.0';

/** Props for {@link Lockup}. */
export interface LockupProps {
  /**
   * The accessible name. This is the name of whatever the lockup sits inside — usually a
   * link home — so it says where the link goes rather than just naming the product.
   */
  title?: string;
  /** Additional class names. */
  className?: string;
}

/**
 * The Assaybank lockup: the mark and the wordmark, both in `currentColor`.
 *
 * Colour comes from the surrounding text colour, so the lockup is ink on a light theme
 * and paper on a dark one with no second drawing and no theme branch. The accent never
 * enters it — brand/README.md names that as the first misuse, and the token layer
 * deliberately publishes no alias that would make it convenient.
 *
 * `role="img"` with an `aria-labelledby` `<title>`, not `aria-hidden`: this *is* the link
 * home in the header, so it needs a name. Decorative uses pass `aria-hidden` on a
 * wrapper instead.
 */
export function Lockup({ title = 'Assaybank', className }: LockupProps): ReactNode {
  const titleId = `${useId()}-lockup-title`;

  return (
    <svg
      className={className}
      viewBox="0 0 512 96"
      role="img"
      aria-labelledby={titleId}
      fill="none"
      focusable="false"
    >
      <title id={titleId}>{title}</title>
      <g strokeLinecap="butt">
        {MARK_ARCS.map((arc) => (
          <path
            key={arc.d}
            d={arc.d}
            stroke="currentColor"
            strokeWidth={arc.strokeWidth}
            transform={arc.transform}
          />
        ))}
      </g>
      {/* Scale and offset computed from the wordmark's own bounding box — x 0…834.1 and
          y −46.5…146.5 once the 17-unit stroke is accounted for — so the ascenders and
          the descender of the "y" sit inside the viewBox rather than being clipped by
          it. The 26-unit gap to the mark is the clear space brand/README.md requires:
          25% of the mark's height. */}
      <g transform="translate(114,24.5) scale(0.47)">
        <path
          d={WORDMARK_PATH}
          stroke="currentColor"
          strokeWidth={17}
          strokeLinecap="butt"
          strokeLinejoin="miter"
        />
      </g>
    </svg>
  );
}
