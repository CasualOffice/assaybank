/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The console's routes, as data.
 *
 * One list feeds three things: the router's route tree, the header navigation, and the
 * document title. They are derived rather than written three times, because a navigation
 * link that points at a route which no longer exists is the kind of defect that survives
 * review — it looks right, and it only fails when somebody clicks it.
 *
 * P0 ships the shell and four placeholders. Each placeholder says which phase fills it,
 * so a screen that is empty is visibly *deliberately* empty rather than broken — the
 * distinction matters when somebody who did not write this opens it on day one.
 */

/** The paths the console serves. A closed union, so a `to` prop cannot be a typo. */
export type ConsolePath = '/' | '/questions' | '/assessments' | '/candidates';

/**
 * A route that is reached from another screen rather than from the navigation.
 *
 * It has no sidebar entry and no manifest row: the manifest is the navigation, and a detail
 * screen in it would be a link to somebody's question. The shell's `aria-current` therefore
 * stays on `/questions` while a question is open, which is what a user expects.
 */
export const QUESTION_DETAIL_PATH = '/questions/$questionId';

/**
 * The sidebar sections, in the order they appear.
 *
 * A flat list of four items needs no grouping; a console's navigation is never four items
 * for long, and a group added once there are twelve is a group added after everyone has
 * learned the flat order. The manifest carries the section so the sidebar renders itself
 * and no second list can disagree with it.
 */
export const NAV_SECTIONS = ['Overview', 'Question bank', 'Hiring'] as const;

/** One section of the sidebar. */
export type NavSection = (typeof NAV_SECTIONS)[number];

/** One route, and everything the shell needs to know about it. */
export interface RouteDescriptor {
  /** The path, which is also the route id. */
  readonly path: ConsolePath;
  /** Which sidebar section it belongs to. */
  readonly section: NavSection;
  /** The navigation label and the page's `<h1>`. */
  readonly title: string;
  /** A sentence describing what the screen will do. */
  readonly summary: string;
  /** The phase that builds it, from project/ROADMAP.md §2. */
  readonly phase: string;
  /** What that phase adds here, in a sentence a reader can act on. */
  readonly phaseNote: string;
}

/** The product name, used in the document title and the announcements. */
export const APP_NAME = 'Assaybank';

/** The surface name, which distinguishes this bundle from the candidate one (ADR-013). */
export const SURFACE_NAME = 'Staff console';

/**
 * Every route the console serves.
 *
 * Ordered as the navigation is ordered, which is also DOM order and therefore focus
 * order — docs/15 §6.2 makes that identity a rule rather than a coincidence.
 */
export const ROUTE_MANIFEST: readonly RouteDescriptor[] = Object.freeze([
  {
    path: '/',
    section: 'Overview',
    title: 'Dashboard',
    summary: 'What needs attention: open reviews, running assessments, recent activity.',
    phase: 'P2',
    phaseNote:
      'P2 fills this with the question bank’s counts; P3 adds attempt activity and the ' +
      'review queue once there are attempts to have activity.',
  },
  {
    path: '/questions',
    section: 'Question bank',
    title: 'Questions',
    summary: 'The shared question bank: authoring, versions, skills and publication.',
    phase: 'P2',
    phaseNote:
      'P2 builds the bank — the list, the authoring editor, and the publish flow that ' +
      'makes a version immutable (ADR-003).',
  },
  {
    path: '/assessments',
    section: 'Hiring',
    title: 'Assessments',
    summary: 'Assessment definitions, sections, draw rules and invitations.',
    phase: 'P3',
    phaseNote:
      'P3 builds the assessment engine — the builder, the section rules, and the ' +
      'server-computed deadline the runner enforces (ADR-006).',
  },
  {
    path: '/candidates',
    section: 'Hiring',
    title: 'Candidates',
    summary: 'Candidate records, their invitations, attempts and scorecards.',
    phase: 'P3',
    phaseNote:
      'P3 builds the attempt lifecycle this screen reports on; P4 adds the grading ' +
      'results and P6 the certification history.',
  },
]);

/**
 * The manifest grouped into sidebar sections, in section order then manifest order.
 *
 * Derived rather than declared: a second hand-written structure is a second thing that can
 * disagree with the first, and the disagreement shows up as a route that exists and has no
 * link to it.
 */
export function navSections(): readonly {
  section: NavSection;
  routes: readonly RouteDescriptor[];
}[] {
  return NAV_SECTIONS.map((section) => ({
    section,
    routes: ROUTE_MANIFEST.filter((route) => route.section === section),
  })).filter((group) => group.routes.length > 0);
}

/** The descriptor for a path, or `undefined` for a path the console does not serve. */
export function routeFor(path: string): RouteDescriptor | undefined {
  return ROUTE_MANIFEST.find((route) => route.path === path);
}

/**
 * The `<title>` for a route.
 *
 * The document title changes on navigation because that is the only thing several screen
 * readers announce reliably for a single-page application; the route announcer of
 * docs/15 §9.1 is the other half, not a replacement.
 */
export function documentTitleFor(route: RouteDescriptor): string {
  return `${route.title} — ${APP_NAME} ${SURFACE_NAME.toLowerCase()}`;
}

/** What the route announcer says after a navigation. */
export function routeAnnouncementFor(route: RouteDescriptor): string {
  return `${route.title}. ${SURFACE_NAME}.`;
}
