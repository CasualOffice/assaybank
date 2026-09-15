/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Joins class names, dropping anything falsy.
 *
 * Internal to this package and not re-exported from `src/index.ts`: it is eight lines,
 * it is the only thing of its kind here, and a shared "utils" surface is the thing
 * docs/17 §2 refuses by name.
 */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}

/**
 * Joins the ids for an `aria-describedby`, returning `undefined` when there are none.
 *
 * `aria-describedby=""` is not the same as no `aria-describedby`: an empty value points
 * at nothing and some screen readers announce the gap. The `undefined` is load-bearing.
 */
export function describedBy(
  ...ids: readonly (string | false | null | undefined)[]
): string | undefined {
  const joined = cx(...ids);
  return joined.length > 0 ? joined : undefined;
}
