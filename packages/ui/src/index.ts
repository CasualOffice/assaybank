/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @assaybank/ui — shared React components and design tokens.
 *
 * Owns: the design tokens taken from brand/README.md, the accessibility baseline every
 * screen from P2 onward inherits, and the handful of primitives both front ends need.
 *
 * Presentation only: no data fetching, no route definitions and no permission logic. It
 * imports no workspace package other than contracts (types only), so it can never drag
 * server code into a candidate bundle (CODE-GRAPH L5). Every component here meets the
 * contrast and keyboard requirements in docs/15-accessibility-conformance.md, and the
 * contrast part is asserted by `tokens/palette.test.ts` rather than reviewed by eye.
 *
 * **Stylesheets are imported separately**, because CSS does not travel through a `tsc`
 * build and a component library that silently renders unstyled is a component library
 * that silently fails its contrast requirements:
 *
 * ```ts
 * import '@assaybank/ui/styles.css';   // tokens, baseline, component classes
 * import '@assaybank/ui/theme.css';    // optional: the tokens as Tailwind v4 utilities
 * ```
 *
 * **The accessibility baseline is four things**, and a shell that has all four inherits
 * the rest of this package's guarantees:
 *
 * 1. `<SkipLink>` first in the DOM, pointing at a `<main tabIndex={-1}>`.
 * 2. `<LiveRegionProvider>` above the router, so announcements have somewhere to land.
 * 3. The stylesheet, which carries `:focus-visible` and `prefers-reduced-motion`.
 * 4. No information carried by colour alone — every component with a tone also renders
 *    the tone as text.
 *
 * Everything public is re-exported from this file; nothing imports a submodule directly.
 */

export { Alert } from './components/Alert.js';
export type { AlertLiveness, AlertProps, AlertTone } from './components/Alert.js';

export { Badge } from './components/Badge.js';
export type { BadgeProps, BadgeTone } from './components/Badge.js';

export { Button } from './components/Button.js';
export type { ButtonProps, ButtonTone } from './components/Button.js';

export { EmptyState } from './components/EmptyState.js';
export type { EmptyReason, EmptyStateProps } from './components/EmptyState.js';

export { Field } from './components/Field.js';
export type { FieldControlProps, FieldProps } from './components/Field.js';

export { Input } from './components/Input.js';
export type { InputProps } from './components/Input.js';

export { Markdown } from './components/Markdown.js';
export type { MarkdownProps } from './components/Markdown.js';

export { Select } from './components/Select.js';
export type { SelectProps } from './components/Select.js';

export { Skeleton } from './components/Skeleton.js';
export type { SkeletonProps } from './components/Skeleton.js';

export { Table } from './components/Table.js';
export type { TableProps } from './components/Table.js';

export { Toolbar } from './components/Toolbar.js';
export type { ToolbarProps } from './components/Toolbar.js';

export { SkipLink } from './components/SkipLink.js';
export type { SkipLinkProps } from './components/SkipLink.js';

export { VisuallyHidden } from './components/VisuallyHidden.js';
export type { VisuallyHiddenElement, VisuallyHiddenProps } from './components/VisuallyHidden.js';

export {
  LIVE_REGION_IDS,
  LiveRegionProvider,
  LiveRegions,
  useAnnounce,
} from './live-region/LiveRegion.js';
export type {
  Announcer,
  LiveRegionProviderProps,
  LiveRegionsProps,
} from './live-region/LiveRegion.js';

export {
  AnnouncementQueue,
  ASSERTIVE_INTERVAL_MS,
  POLITE_INTERVAL_MS,
  ROUTE_INTERVAL_MS,
  intervalFor,
} from './live-region/announcer.js';
export type {
  AnnouncementListener,
  AnnouncementQueueOptions,
  Politeness,
} from './live-region/announcer.js';

export {
  contrastRatio,
  meetsContrast,
  parseColour,
  parseHexColour,
  parseOklchColour,
  relativeLuminance,
  toHex,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NON_TEXT,
  WCAG_AA_TEXT,
} from './tokens/contrast.js';
export type { Rgb } from './tokens/contrast.js';

export {
  BRAND_COLOURS,
  DARK_PALETTE,
  FOCUS_RING_SURFACES,
  LIGHT_PALETTE,
  NON_TEXT_CONTRAST_PAIRS,
  PALETTES,
  SEMANTIC_TOKENS,
  TEXT_CONTRAST_PAIRS,
  cssVariable,
  cssVariableName,
} from './tokens/palette.js';
export type { Palette, SemanticToken, ThemeName } from './tokens/palette.js';

/**
 * The workspace's own package name. Exported so a bootstrap can name itself in a log
 * line or a span resource without a second source of truth.
 */
export const WORKSPACE_NAME = '@assaybank/ui';
