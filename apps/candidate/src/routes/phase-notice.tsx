/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The marker a P0 placeholder route carries.
 *
 * P0 builds the skeleton; the screens land in M1 through M4. A placeholder that says
 * only "coming soon" is indistinguishable from an unfinished screen someone forgot, so
 * each one names the milestone that builds it and the document that specifies it. That
 * makes the skeleton auditable against project/ROADMAP.md rather than a pile of stubs.
 *
 * It renders as ordinary content, not as a warning: a candidate should never see one of
 * these in production, and dressing it up as an error would teach the wrong reflex in
 * development.
 */

import type { JSX } from 'react';

export interface PhaseNoticeProps {
  /** The milestone that builds this screen, e.g. `'M1'`. */
  readonly milestone: string;
  /** One sentence on what it will do. */
  readonly summary: string;
  /** Where the behaviour is specified. */
  readonly specifiedBy: string;
}

export function PhaseNotice(props: PhaseNoticeProps): JSX.Element {
  return (
    <aside className="phase-notice" aria-label="Implementation status">
      <p className="phase-notice__milestone">
        Placeholder — built in <strong>{props.milestone}</strong>
      </p>
      <p>{props.summary}</p>
      <p className="phase-notice__spec">Specified by {props.specifiedBy}.</p>
    </aside>
  );
}
