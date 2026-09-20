/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shell, the lockup and the placeholder screens.
 *
 * Rendered with `react-dom/server` and asserted on the markup, because jsdom is not on the
 * ADR-001 approved dependency list. What that can claim is the accessible structure —
 * landmarks, the bypass block's position in DOM order, the label associations, the current
 * item's `aria-current`. What it cannot claim is behaviour that needs a live document, and
 * docs/15 §15.1 puts that in the `@axe-core/playwright` suite where a real browser can
 * answer it.
 */

import { LiveRegionProvider } from '@assaybank/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Placeholder, PAGE_HEADING_ID } from '../routes/Placeholder.js';
import { AppShellLayout, MAIN_CONTENT_ID } from './AppShell.js';
import { Lockup } from './Lockup.js';
import {
  APP_NAME,
  ROUTE_MANIFEST,
  type RouteDescriptor,
  SURFACE_NAME,
  routeFor,
} from './routes.js';

/**
 * The manifest entry for a path, or a failure that names the path.
 *
 * A non-null assertion would be shorter and is banned (docs/17 §1): `!` in a test is how a
 * missing fixture becomes "cannot read property of undefined" three lines after the thing
 * that was actually wrong.
 */
function routeOrThrow(path: string): RouteDescriptor {
  const route = routeFor(path);

  if (route === undefined) {
    throw new Error(`No route manifest entry for ${path}`);
  }

  return route;
}

/** One opening tag from the rendered markup. */
interface Tag {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
}

const TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR = /([^\s=/>]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function scanTags(markup: string): Tag[] {
  const tags: Tag[] = [];

  for (const match of markup.matchAll(TAG)) {
    const name = match[1];
    if (name === undefined) {
      continue;
    }

    const attrs: Record<string, string> = {};
    for (const attr of (match[2] ?? '').matchAll(ATTR)) {
      const attrName = attr[1];
      if (attrName !== undefined) {
        attrs[attrName.toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? '';
      }
    }

    tags.push({ name: name.toLowerCase(), attrs });
  }

  return tags;
}

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A nav rendered with plain anchors, standing in for the router-aware one. */
function staticNav() {
  return (
    <>
      {ROUTE_MANIFEST.map((route) => (
        <li key={route.path}>
          <a
            href={route.path}
            className="ab-console__nav-link"
            {...(route.path === '/questions' ? { 'aria-current': 'page' as const } : {})}
          >
            {route.title}
          </a>
        </li>
      ))}
    </>
  );
}

const shellMarkup = renderToStaticMarkup(
  <LiveRegionProvider>
    <AppShellLayout nav={staticNav()}>
      <Placeholder route={routeOrThrow('/questions')} />
    </AppShellLayout>
  </LiveRegionProvider>,
);

describe('AppShellLayout', () => {
  it('renders exactly one main landmark, and the skip link points at it', () => {
    const tags = scanTags(shellMarkup);
    const mains = tags.filter((tag) => tag.name === 'main');
    const skip = tags.find((tag) => tag.attrs['class']?.includes('ab-skip-link') === true);

    expect(mains).toHaveLength(1);
    expect(mains[0]?.attrs['id']).toBe(MAIN_CONTENT_ID);
    expect(skip?.attrs['href']).toBe(`#${MAIN_CONTENT_ID}`);
  });

  it('makes the skip target focusable, which is what makes the skip link work', () => {
    const main = scanTags(shellMarkup).find((tag) => tag.name === 'main');

    // Without tabIndex the browser scrolls and leaves focus where it was, so the next Tab
    // goes back to the navigation the user just asked to skip.
    expect(main?.attrs['tabindex']).toBe('-1');
  });

  it('puts the skip link ahead of everything else in the tab order', () => {
    const tabbable = scanTags(shellMarkup).filter(
      (tag) => (tag.name === 'a' && tag.attrs['href'] !== undefined) || tag.name === 'button',
    );

    // Focus order follows DOM order, so this ordering *is* the bypass block (SC 2.4.1).
    expect(tabbable[0]?.attrs['class']).toContain('ab-skip-link');
  });

  it('names its navigation landmark, so it is not one of two anonymous ones', () => {
    const navs = scanTags(shellMarkup).filter((tag) => tag.name === 'nav');

    expect(navs).toHaveLength(1);
    expect(navs[0]?.attrs['aria-label']).toBe(SURFACE_NAME);
  });

  it('renders header, main and footer landmarks once each', () => {
    const tags = scanTags(shellMarkup);

    expect(tags.filter((tag) => tag.name === 'header')).toHaveLength(1);
    expect(tags.filter((tag) => tag.name === 'footer')).toHaveLength(1);
  });

  it('mounts the live regions above the shell, empty', () => {
    const live = scanTags(shellMarkup).filter((tag) => tag.attrs['aria-live'] !== undefined);

    // docs/15 §5.1 — they have to exist before anything announces, which means above the
    // router rather than inside a screen.
    expect(live).toHaveLength(3);
    expect(shellMarkup.indexOf('aria-live')).toBeLessThan(shellMarkup.indexOf('<main'));
  });

  it('marks the current navigation item with aria-current as well as a class', () => {
    const current = scanTags(shellMarkup).filter((tag) => tag.attrs['aria-current'] === 'page');

    expect(current).toHaveLength(1);
    expect(current[0]?.attrs['href']).toBe('/questions');
  });

  it('renders a link for every route in the manifest, in manifest order', () => {
    const hrefs = scanTags(shellMarkup)
      .filter((tag) => tag.name === 'a' && tag.attrs['class']?.includes('nav-link') === true)
      .map((tag) => tag.attrs['href']);

    expect(hrefs).toEqual(ROUTE_MANIFEST.map((route) => route.path));
  });

  it('states in the footer that a result is evidence, not a decision', () => {
    // brand/README.md and ADR-007 both take the position that the system measures and a
    // human decides. A product that says so in its chrome is harder to misuse.
    expect(textOf(shellMarkup)).toContain('never a decision');
  });
});

describe('Lockup', () => {
  const markup = renderToStaticMarkup(<Lockup title="Assaybank staff console, home" />);
  const tags = scanTags(markup);

  it('carries an accessible name through role=img and a title element', () => {
    const svg = tags.find((tag) => tag.name === 'svg');
    const title = tags.find((tag) => tag.name === 'title');

    expect(svg?.attrs['role']).toBe('img');
    expect(svg?.attrs['aria-labelledby']).toBe(title?.attrs['id']);
    expect(textOf(markup)).toBe('Assaybank staff console, home');
  });

  it('draws everything in currentColor, so one asset serves both themes', () => {
    const strokes = tags
      .filter((tag) => tag.name === 'path')
      .map((tag) => tag.attrs['stroke'] ?? '');

    expect(strokes.length).toBeGreaterThanOrEqual(3);
    expect(strokes.every((stroke) => stroke === 'currentColor')).toBe(true);
  });

  it('never puts the accent in the mark', () => {
    // brand/README.md names this as the first misuse: "The accent never appears in the
    // logo. If a surface needs the mark to be 'on brand', it needs ink or paper, not
    // colour."
    expect(markup).not.toContain('--ab-accent');
    expect(markup).not.toContain('--ab-signal');
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}/u);
    expect(markup).not.toContain('linearGradient');
  });

  it('keeps the two arcs unequal, which is the idea rather than a detail', () => {
    // "The heavy arc is the sample; the light arc is the reference. A symmetrical version
    // of this mark is a loading spinner; the asymmetry is what makes it ours."
    const arcWeights = tags
      .filter((tag) => tag.name === 'path' && (tag.attrs['d'] ?? '').includes(' A '))
      .map((tag) => Number(tag.attrs['stroke-width'] ?? '0'))
      .slice(0, 2);

    expect(arcWeights).toHaveLength(2);
    expect(arcWeights[0]).not.toBe(arcWeights[1]);
  });

  it('is not focusable, because the link around it is', () => {
    expect(tags.find((tag) => tag.name === 'svg')?.attrs['focusable']).toBe('false');
  });
});

describe('Placeholder', () => {
  it('renders one h1, focusable so the router can move focus to it', () => {
    const markup = renderToStaticMarkup(<Placeholder route={routeOrThrow('/questions')} />);
    const headings = scanTags(markup).filter((tag) => tag.name === 'h1');

    expect(headings).toHaveLength(1);
    expect(headings[0]?.attrs['id']).toBe(PAGE_HEADING_ID);
    expect(headings[0]?.attrs['tabindex']).toBe('-1');
  });

  it.each(ROUTE_MANIFEST.map((route): [string] => [route.path]))(
    '%s says which phase builds it',
    (path) => {
      const route = routeOrThrow(path);
      const text = textOf(renderToStaticMarkup(<Placeholder route={route} />));

      // An empty screen and a broken screen look identical. This is the difference.
      expect(text).toContain(route.title);
      expect(text).toContain(`Built in ${route.phase}`);
      expect(text).toContain(route.summary);
    },
  );

  it('hides the loading sketch from assistive technology', () => {
    const markup = renderToStaticMarkup(<Placeholder route={routeOrThrow('/')} />);
    const skeletons = scanTags(markup).filter(
      (tag) => tag.attrs['class']?.includes('ab-skeleton') === true,
    );

    expect(skeletons.length).toBeGreaterThan(0);
    expect(skeletons.every((tag) => tag.attrs['aria-hidden'] === 'true')).toBe(true);
  });

  it('does not announce or retitle: that belongs to the router, once per navigation', () => {
    const markup = renderToStaticMarkup(<Placeholder route={routeOrThrow('/')} />);

    expect(markup).not.toContain('aria-live');
  });
});

describe('the route manifest', () => {
  it('describes five routes, each with a phase and a note', () => {
    expect(ROUTE_MANIFEST).toHaveLength(5);

    for (const route of ROUTE_MANIFEST) {
      expect(route.title.length).toBeGreaterThan(0);
      expect(route.summary.length).toBeGreaterThan(0);
      expect(route.phase).toMatch(/^P\d$/u);
      expect(route.phaseNote.length).toBeGreaterThan(20);
    }
  });

  it('has no duplicate paths, which would make one route unreachable', () => {
    const paths = ROUTE_MANIFEST.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('returns undefined for a path the console does not serve', () => {
    expect(routeFor('/nope')).toBeUndefined();
  });

  it('names the product and the surface once, for the title and the announcement', () => {
    expect(APP_NAME).toBe('Assaybank');
    expect(SURFACE_NAME).toBe('Staff console');
  });
});
