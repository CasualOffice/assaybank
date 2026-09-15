/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { findById, scanTags, textOfId } from '../test-support/markup.js';
import { LIVE_REGION_IDS, LiveRegionProvider, LiveRegions, useAnnounce } from './LiveRegion.js';

describe('LiveRegionProvider', () => {
  const markup = renderToStaticMarkup(
    <LiveRegionProvider>
      <main id="main-content" tabIndex={-1}>
        <h1>Dashboard</h1>
      </main>
    </LiveRegionProvider>,
  );

  it('mounts all three regions on the very first render', () => {
    // docs/15 §5.1. A region inserted at the moment its content changes is frequently
    // not announced at all: the screen reader never saw it become a live region. This
    // assertion is the whole reason the provider exists rather than an attribute.
    expect(findById(markup, LIVE_REGION_IDS.polite)).toBeDefined();
    expect(findById(markup, LIVE_REGION_IDS.assertive)).toBeDefined();
    expect(findById(markup, LIVE_REGION_IDS.route)).toBeDefined();
  });

  it('starts every region empty', () => {
    expect(textOfId(markup, LIVE_REGION_IDS.polite)).toBe('');
    expect(textOfId(markup, LIVE_REGION_IDS.assertive)).toBe('');
    expect(textOfId(markup, LIVE_REGION_IDS.route)).toBe('');
  });

  it('gives the polite region role=status and aria-live=polite', () => {
    const region = findById(markup, LIVE_REGION_IDS.polite);

    expect(region.attrs['role']).toBe('status');
    expect(region.attrs['aria-live']).toBe('polite');
    // Atomic, so "10 minutes remaining" is read whole rather than as the diff "10".
    expect(region.attrs['aria-atomic']).toBe('true');
  });

  it('gives the assertive region role=alert and aria-live=assertive', () => {
    const region = findById(markup, LIVE_REGION_IDS.assertive);

    expect(region.attrs['role']).toBe('alert');
    expect(region.attrs['aria-live']).toBe('assertive');
    expect(region.attrs['aria-atomic']).toBe('true');
  });

  it('keeps the route announcer polite and separate from status messages', () => {
    const region = findById(markup, LIVE_REGION_IDS.route);

    expect(region.attrs['role']).toBe('status');
    expect(region.attrs['aria-live']).toBe('polite');
  });

  it('places the regions before the application content', () => {
    const tags = scanTags(markup);
    const lastRegion = tags.findIndex((tag) => tag.attrs['id'] === LIVE_REGION_IDS.route);
    const main = tags.findIndex((tag) => tag.name === 'main');

    expect(lastRegion).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(lastRegion);
  });

  it('hides the regions visually without hiding them from assistive technology', () => {
    for (const id of Object.values(LIVE_REGION_IDS)) {
      const region = findById(markup, id);
      expect(region.attrs['class']).toBe('ab-live-region');
      expect(region.attrs['aria-hidden']).toBeUndefined();
      expect(region.attrs['hidden']).toBeUndefined();
    }
  });

  it('renders exactly three live regions and no more', () => {
    const live = scanTags(markup).filter((tag) => tag.attrs['aria-live'] !== undefined);

    // Ad-hoc regions are how an application announces four things at once, of which a
    // screen reader reads one at random (docs/15 §5.1).
    expect(live).toHaveLength(3);
  });
});

describe('LiveRegions', () => {
  it('renders the text it is given into the matching region', () => {
    const markup = renderToStaticMarkup(
      <LiveRegions
        polite="Your answer is saved."
        assertive="1 minute remaining."
        route="Questions."
      />,
    );

    expect(textOfId(markup, LIVE_REGION_IDS.polite)).toBe('Your answer is saved.');
    expect(textOfId(markup, LIVE_REGION_IDS.assertive)).toBe('1 minute remaining.');
    expect(textOfId(markup, LIVE_REGION_IDS.route)).toBe('Questions.');
  });
});

describe('useAnnounce', () => {
  it('throws outside a provider rather than silently swallowing announcements', () => {
    function Orphan(): null {
      useAnnounce();
      return null;
    }

    // A no-op fallback would be friendlier to the developer and would mean a
    // screen-reader user silently receives nothing, which is the failure this whole
    // module exists to prevent.
    expect(() => renderToStaticMarkup(<Orphan />)).toThrow(/LiveRegionProvider/u);
  });

  it('hands a working announcer to a component inside the provider', () => {
    let seen: unknown = null;

    function Probe(): null {
      seen = useAnnounce();
      return null;
    }

    renderToStaticMarkup(
      <LiveRegionProvider>
        <Probe />
      </LiveRegionProvider>,
    );

    expect(seen).not.toBeNull();
    expect(typeof (seen as { announce: unknown }).announce).toBe('function');
    expect(typeof (seen as { announceRoute: unknown }).announceRoute).toBe('function');
  });
});
