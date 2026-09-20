/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The candidate runner's Content-Security-Policy (T-038, ADR-022).
 *
 * The same reasoning as the console's (`apps/web/src/csp.ts`) with three differences, each of
 * which is the reason the two policies are separate files rather than one function with
 * flags:
 *
 * 1. **`connect-src` must reach the collaboration service over a WebSocket.** A live
 *    interview is a Yjs document on `apps/collab`, on the API hostname (docs/13).
 * 2. **`media-src` will need `blob:`** when proctoring captures camera and screen in M4. It
 *    is not granted yet — a directive added before the feature is a directive nobody can
 *    remove later, because nobody will be sure what depends on it.
 * 3. **`form-action 'none'`.** The runner submits everything by `fetch`. It has no HTML form
 *    that posts anywhere, so nothing legitimate is lost and a phishing form injected into a
 *    prompt has nowhere to send an attempt token.
 *
 * This bundle holds an attempt token, which is why the policy is stricter where it can be.
 */

/** Options for {@link contentSecurityPolicy}. */
export interface CspOptions {
  /** Development relaxations for Vite's inline preamble, inline styles and HMR socket. */
  dev: boolean;
  /**
   * The API origin, when it is not our own — `API_PUBLIC_URL`, reaching the build as
   * `VITE_API_PUBLIC_URL` (docs/13 §4.2).
   *
   * The candidate app is served from its own hostname and talks to the API on another, so
   * unlike the console this is normally set in a deployed tier.
   */
  apiOrigin?: string | undefined;
  /**
   * The collaboration WebSocket origin — `COLLAB_PUBLIC_URL`, as `VITE_COLLAB_PUBLIC_URL`.
   *
   * Defaulted from `apiOrigin` because Caddy routes `/collab/*` on the API hostname, so in
   * the deployment we actually run they are the same host with a different scheme. Settable
   * for the case where they are not, rather than assumed.
   */
  collabOrigin?: string | undefined;
}

/** `https://api.example` becomes `wss://api.example`. */
function socketOrigin(origin: string): string {
  if (origin.startsWith('https://')) return `wss://${origin.slice('https://'.length)}`;
  if (origin.startsWith('http://')) return `ws://${origin.slice('http://'.length)}`;
  return origin;
}

const present = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

/** The directives, as an ordered map. */
export function cspDirectives({
  dev,
  apiOrigin,
  collabOrigin,
}: CspOptions): Record<string, readonly string[]> {
  const origin = present(apiOrigin);
  const socket = present(collabOrigin) ?? (origin === null ? null : socketOrigin(origin));
  const api = [origin, socket].filter((value): value is string => value !== null);

  return {
    'default-src': ["'none'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src-attr': ["'none'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'font-src': ["'self'"],
    'connect-src': dev ? ["'self'", ...api, 'ws:', 'wss:'] : ["'self'", ...api],
    'media-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
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

/** The runner's policy for a given build. */
export function contentSecurityPolicy(options: CspOptions): string {
  return policyString(cspDirectives(options));
}
