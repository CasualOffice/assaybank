/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The staff console's Content-Security-Policy (T-038, ADR-022).
 *
 * The second half of the markdown defence. ADR-022 makes markup injection through a prompt
 * structurally impossible; this is what stands behind that argument if some future screen
 * finds a way to be wrong anyway, and what covers the injection paths a markdown parser has
 * nothing to do with — a reflected value in an error page, a third-party script somebody adds
 * in a hurry, a `<base>` tag rewriting every relative URL on the page.
 *
 * **Why the policy travels in the page rather than only in a header.** A `<meta
 * http-equiv>` is part of the bundle, so it applies in development, in `vite preview`, on a
 * static host, and in production, and it cannot be lost by a proxy nobody remembered to
 * configure. The directives a meta tag cannot express — `frame-ancestors`, `report-uri`,
 * `sandbox` — are the reverse-proxy's job and live in `infra/caddy/Caddyfile`; a browser
 * ignores `frame-ancestors` in a meta tag and warns, so putting it here would be a policy
 * that looks enforced and is not.
 *
 * The console is not the candidate runner and its policy is deliberately not shared with
 * one. `apps/candidate` needs `media-src` for proctoring and a WebSocket to the collaboration
 * service; the console needs neither, and a single function taking six flags to express two
 * policies would be a worse way to say that than two files. What they must *both* satisfy is
 * asserted once, in `tests/fixtures/csp.test.ts`.
 */

/** Where the bundle is allowed to send API requests. */
export interface CspOptions {
  /**
   * Development relaxations. Vite injects an inline module preamble and serves styles
   * inline, and its HMR client opens a WebSocket — all three need saying out loud, because
   * the alternative is a developer discovering the policy only when production breaks.
   */
  dev: boolean;
  /**
   * The API's origin, when it is not our own — `API_PUBLIC_URL`, reaching the build as
   * `VITE_API_PUBLIC_URL` (docs/13 §4.2).
   *
   * Normally empty for the console: it and the API are same-origin in a deployed tier
   * (docs/13), so the bundle asks for `/api/v1` and `connect-src 'self'` covers it. A value
   * here widens the policy by exactly one origin and is the only knob that does.
   */
  apiOrigin?: string | undefined;
}

/**
 * The directives, as an ordered map.
 *
 * `default-src 'none'` and then an explicit opt-in per resource type: a policy that starts
 * from `'self'` silently permits whatever fetch destination the platform adds next.
 */
export function cspDirectives({ dev, apiOrigin }: CspOptions): Record<string, readonly string[]> {
  const api = apiOrigin === undefined || apiOrigin === '' ? [] : [apiOrigin];

  return {
    'default-src': ["'none'"],
    // Vite's dev server injects the React Refresh preamble as an inline script. There is no
    // nonce to give it, so development gets 'unsafe-inline' and production must not — which
    // is the one difference between the two policies, and the one the test pins.
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // Production extracts every rule to a stylesheet file. `style-src-attr` is separate so
    // that a future inline `style` attribute does not require reopening `<style>` blocks
    // and stylesheet injection along with it.
    'style-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src-attr': ["'none'"],
    // ADR-022 records this as the loosest directive here and why: a prompt may reference an
    // image on any https origin, which permits a beacon, and tightening it to 'self' waits
    // on an upload path for question media.
    'img-src': ["'self'", 'data:', 'https:'],
    'font-src': ["'self'"],
    'connect-src': dev ? ["'self'", ...api, 'ws:', 'wss:'] : ["'self'", ...api],
    // No plugins, and no way to point the page's relative URLs somewhere else — `<base>`
    // injection turns every link and form on the page into someone else's.
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    // The console posts nothing to a foreign origin. Every mutation is `fetch` to the API.
    'form-action': ["'self'"],
    // Present for the browsers that still honour it; `frame-ancestors` in the proxy is the
    // directive that actually does this job.
    'frame-src': ["'none'"],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    // Not in development. A dev server is served over plain http on localhost, and
    // although the specification exempts a potentially-trustworthy origin from the
    // upgrade, relying on that exemption means the first browser that reads it differently
    // breaks every asset on the page and nobody knows why.
    ...(dev ? {} : { 'upgrade-insecure-requests': [] }),
  };
}

/** Serialises directives into the policy string a `<meta>` or a header carries. */
export function policyString(directives: Record<string, readonly string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => (values.length === 0 ? name : `${name} ${values.join(' ')}`))
    .join('; ');
}

/** The console's policy for a given build. */
export function contentSecurityPolicy(options: CspOptions): string {
  return policyString(cspDirectives(options));
}
