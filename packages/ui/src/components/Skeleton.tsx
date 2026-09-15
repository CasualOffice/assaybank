/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type CSSProperties, type ReactNode } from 'react';

import { cx } from './class-names.js';

/** Props for {@link Skeleton}. */
export interface SkeletonProps {
  /** CSS width. `100%` by default. */
  width?: string;
  /** CSS height. One line of text by default. */
  height?: string;
  /** CSS border radius. The small token by default. */
  radius?: string;
  /** Additional class names, appended to `ab-skeleton`. */
  className?: string;
}

/**
 * A placeholder block shown while content loads.
 *
 * It is `aria-hidden` and it has no live role, both deliberately. A skeleton carries no
 * information — it is a picture of content that does not exist yet — so exposing it to a
 * screen reader produces a reading of nothing, repeated for every block. The loading
 * *state* is information, and it belongs in the polite region once, via `useAnnounce`,
 * not in twelve grey rectangles.
 *
 * The shimmer stops under `prefers-reduced-motion` (styles/components.css), leaving a
 * static block, per docs/15 §10.
 */
export function Skeleton({
  width = '100%',
  height = '1.25rem',
  radius,
  className,
}: SkeletonProps): ReactNode {
  const style: CSSProperties = {
    width,
    height,
    ...(radius === undefined ? {} : { borderRadius: radius }),
  };

  return <span aria-hidden="true" className={cx('ab-skeleton', className)} style={style} />;
}
