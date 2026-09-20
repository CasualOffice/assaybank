/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ComponentPropsWithRef, type ReactNode } from 'react';

import { cx } from './class-names.js';

/** Props for {@link Table}. */
// `summary` and `caption` are both omitted from the native props: `summary` is a deprecated
// HTML attribute of a different type, and taking the names back lets this component mean the
// useful thing by them.
export interface TableProps extends Omit<ComponentPropsWithRef<'table'>, 'className' | 'summary'> {
  /**
   * What the table contains, as a sentence. Required, and rendered — a `<caption>` is how
   * a screen-reader user decides whether to enter a table at all.
   */
  caption: ReactNode;
  /** Hides the caption visually. The accessible name remains. */
  captionHidden?: boolean;
  /**
   * Announced with the caption when rows are a subset: "Showing 25 of 4,102".
   * Kept separate from `caption` so the sentence and the count are not concatenated by hand
   * at every call site.
   */
  summary?: ReactNode;
  className?: string;
}

/**
 * A data table.
 *
 * A real `<table>` with a real `<caption>`, `<thead>` and `<th scope>`, because that markup
 * is what makes a table navigable by row and column; a grid of `<div>`s with ARIA roles
 * reimplements the same semantics worse, and every keyboard shortcut a screen reader offers
 * for tables stops working.
 *
 * The horizontal scroll container carries `tabindex="0"` and a group role. SC 2.1.1: a
 * region that scrolls must be reachable by keyboard, and a bare `overflow: auto` on a
 * `<div>` is not — the mouse can scroll it and the keyboard cannot.
 *
 * Column widths are the caller's, set in CSS. This component owns the semantics and the
 * chrome, and takes no column configuration: a column API that has to express "this cell is
 * two lines, and the second line is a muted id" ends up more code than the markup it hides.
 */
export function Table({
  caption,
  captionHidden = false,
  summary,
  className,
  children,
  ...rest
}: TableProps): ReactNode {
  return (
    <div
      className="ab-table__scroll"
      tabIndex={0}
      role="group"
      aria-label={typeof caption === 'string' ? caption : undefined}
    >
      <table {...rest} className={cx('ab-table', className)}>
        <caption className={cx('ab-table__caption', captionHidden && 'ab-visually-hidden')}>
          {caption}
          {summary === undefined ? null : <span className="ab-table__summary"> {summary}</span>}
        </caption>
        {children}
      </table>
    </div>
  );
}
