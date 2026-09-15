/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The single import site for `@assaybank/ui`.
 *
 * ## Why one file rather than imports scattered through the tree
 *
 * ADR-013's guarantee is a property of this application's *dependency closure*, not of
 * any one file: "can a candidate see this?" is answerable by inspecting what
 * `apps/candidate` links, and that answer is only cheap to compute while the edges are
 * few and visible. Funnelling every shared-component import through one module means the
 * closure can be read in one screen, and means a future primitive that quietly drags in
 * domain logic shows up here rather than in the thirtieth screen of the runner.
 *
 * `packages/ui` is presentation only — design tokens, layout primitives, form controls —
 * and imports no workspace package other than `contracts` (types only), so it cannot
 * carry bank access, correct-answer logic or scoring rules into this bundle
 * (CODE-GRAPH L5). That constraint is enforced on the `packages/ui` side by lint; this
 * module is the matching discipline on the consumer side.
 *
 * ## The current state of this file, and why it is short
 *
 * `packages/ui` is being built in the same phase as this application (P0 step 11,
 * tracker H-125: design tokens plus accessible `Field` / `Alert` / `LiveRegion` /
 * `SkipLink` primitives). Until those primitives have published signatures, the shell
 * carries its own copies in `src/shell/`, written against the same specification in
 * docs/15 §5.1 so that adopting the shared versions is a re-export here and a deletion
 * there, not a redesign.
 *
 * Deliberately *not* done in the meantime: guessing at the shared components' props and
 * importing them speculatively. A front end that does not compile is worse than a front
 * end with two implementations of a skip link for one phase.
 */

export { WORKSPACE_NAME as UI_PACKAGE_NAME } from '@assaybank/ui';
