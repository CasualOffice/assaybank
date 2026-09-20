/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ReactNode } from 'react';

import { cx } from './class-names.js';

/** Why there is nothing here. The two cases need different words and different actions. */
export type EmptyReason =
  /** Nothing exists yet. The screen's job is to get the first one made. */
  | 'empty'
  /** Things exist; this filter matched none of them. The screen's job is to widen it. */
  | 'no-matches';

/** Props for {@link EmptyState}. */
export interface EmptyStateProps {
  reason: EmptyReason;
  /** One line, in the user's terms. "No questions yet", not "Empty result set". */
  title: ReactNode;
  /** A sentence or two saying what this screen is for and what happens next. */
  children?: ReactNode;
  /** The one thing to do next. A single primary action, never a row of equals. */
  action?: ReactNode;
  /** A way out that is not the primary action — clearing a filter, reading the guide. */
  secondaryAction?: ReactNode;
  className?: string;
}

/**
 * The screen shown when a list has nothing in it.
 *
 * **An empty list and a broken list look identical, and the difference matters.** This is
 * the same reasoning as the phase placeholders in the console shell: a blank region tells a
 * user nothing about whether the system worked, so an empty state says which of the two it
 * is and what to do about it.
 *
 * **`reason` is required because the two cases are different screens.** "You have no
 * questions" invites the user to write one. "No questions match these filters" invites them
 * to change the filters, and offering "New question" there is an answer to a question
 * nobody asked. Making the caller choose is what stops one generic message serving both
 * badly.
 *
 * It is a `<section>` with a heading rather than a decorative block: a user who navigates
 * by heading finds out the region is empty instead of finding nothing at all.
 */
export function EmptyState({
  reason,
  title,
  children,
  action,
  secondaryAction,
  className,
}: EmptyStateProps): ReactNode {
  return (
    <section className={cx('ab-empty', `ab-empty--${reason}`, className)}>
      <h2 className="ab-empty__title">{title}</h2>
      {children === undefined ? null : <p className="ab-empty__body">{children}</p>}
      {action === undefined && secondaryAction === undefined ? null : (
        <div className="ab-empty__actions">
          {action}
          {secondaryAction}
        </div>
      )}
    </section>
  );
}
