/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The router builds, knows its routes, and resolves a URL to one of them.
 *
 * Asserted against the router's own route table with a memory history rather than by
 * rendering, because rendering a router needs a live document and jsdom is not on the
 * ADR-001 approved dependency list. The rendering half — clicking a link and seeing the
 * screen change — is the end-to-end suite of docs/15 §15.1, which is also where axe runs.
 *
 * What this file does cover is the failure the manifest exists to prevent: a navigation
 * link pointing at a route that does not exist, or a route with no manifest entry to
 * describe it. Both look correct in review and only fail when somebody clicks.
 */

import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { ROUTE_MANIFEST, documentTitleFor, routeAnnouncementFor, routeFor } from './routes.js';
import { routeTree } from './router.js';

/**
 * Routes reached from a screen rather than from the navigation.
 *
 * Written out rather than derived, so adding one is a deliberate edit here: the point of the
 * assertion below is that a route cannot appear without somebody deciding it should.
 */
const DETAIL_ROUTES: readonly string[] = [
  '/questions/$questionId',
  // Reached from a role's "Compose an assessment", never from the sidebar. A manifest entry
  // would put a link to one particular role in the navigation.
  '/roles/$roleId/compose',
  // Reached from an assessment row, never from the sidebar.
  '/assessments/$assessmentId/invite',
];

/** A router positioned at `initialPath`, isolated from any real history. */
function routerAt(initialPath: string) {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe('the route tree', () => {
  it('registers every manifest path, and nothing outside the manifest or the detail routes', () => {
    const ids = Object.keys(routerAt('/').routesById).filter((id) => id !== '__root__');

    // Both directions still matter: a navigation route with no manifest entry would render a
    // screen nothing describes, and a manifest entry with no route would render a nav link to
    // nowhere.
    //
    // Detail routes are the deliberate exception. `/questions/$questionId` is reached from a
    // row, not from the sidebar, and a manifest entry for it would be a navigation link to
    // somebody's question — so it is listed here instead, which keeps the assertion closed.
    const expected = [...ROUTE_MANIFEST.map((route) => route.path), DETAIL_ROUTES].flat();

    expect(ids.sort()).toEqual(expected.sort());
  });

  it('keeps every detail route under the section it belongs to', () => {
    // A detail route that is not a child path of its section would leave the sidebar with
    // nothing current while it is open, and Back would not return to the list.
    for (const path of DETAIL_ROUTES) {
      const section = path.slice(0, path.indexOf('/', 1));
      expect(ROUTE_MANIFEST.map((r) => r.path)).toContain(section);
    }
  });

  it('has a root route that every screen renders inside', () => {
    expect(Object.keys(routerAt('/').routesById)).toContain('__root__');
  });

  it.each(ROUTE_MANIFEST.map((route): [string] => [route.path]))(
    'resolves %s to its own route',
    (path) => {
      const router = routerAt(path);

      expect(router.state.location.pathname).toBe(path);
      expect(Object.keys(router.routesById)).toContain(path);
    },
  );

  it('gives every registered route a component to render', () => {
    const { routesById } = routerAt('/');

    for (const [id, route] of Object.entries(routesById)) {
      if (id === '__root__') {
        continue;
      }
      expect(route.options.component, `${id} has no component`).toBeDefined();
    }
  });

  it('starts at the dashboard for the bare origin', () => {
    expect(routerAt('/').state.location.pathname).toBe('/');
  });
});

describe('what a navigation announces', () => {
  it.each(ROUTE_MANIFEST.map((route): [string] => [route.path]))(
    '%s has a document title naming the page and the surface',
    (path) => {
      const route = routeFor(path);
      expect(route).toBeDefined();

      if (route === undefined) {
        return;
      }

      const title = documentTitleFor(route);

      // Several screen readers announce a title change for a single-page application and
      // nothing else, so the title has to say where the user now is (docs/15 §9.1).
      expect(title).toContain(route.title);
      expect(title).toContain('Assaybank');
      expect(title).toContain('staff console');
    },
  );

  it('announces the page and the surface, once, and nothing else', () => {
    const route = routeFor('/questions');
    expect(route).toBeDefined();

    if (route === undefined) {
      return;
    }

    // Short on purpose. The route announcer is not the place to describe the screen; it
    // is the place to say where the user landed.
    expect(routeAnnouncementFor(route)).toBe('Questions. Staff console.');
  });

  it('gives every route a distinct announcement, so two pages do not sound the same', () => {
    const announcements = ROUTE_MANIFEST.map((route) => routeAnnouncementFor(route));

    expect(new Set(announcements).size).toBe(announcements.length);
  });
});
