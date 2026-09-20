/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An identity provider that can be wrong on purpose (`H-150`, docs/14 T-015).
 *
 * The OIDC tests that existed before this only reached the *start* of the flow: the fake
 * provider served a discovery document and answered 404 to everything else, so a callback
 * could be refused for having no organisation cookie and never for the assertion it
 * carried. Every claim in `H-150`'s row — issuer, audience, `nonce`, `exp`, the PKCE
 * verifier — is about a token that flow never produced.
 *
 * So this one completes the exchange. It signs a real RS256 ID token against a JWKS it
 * publishes, and it takes a mutation per flow so a test can hand the callback a token that
 * is correct in every respect but one. That is the only way to tell a control that works
 * from a control that is never reached: a test which only ever presents a valid token
 * passes identically against a server that checks nothing.
 *
 * ## Signed with `node:crypto`, not with a library
 *
 * `jose` is in the tree as Better Auth's dependency and is not ours. Importing it here
 * would be a phantom dependency — a package we rely on, do not declare, and would lose
 * without warning the day Better Auth stopped needing it. A JWS over RS256 is a base64url
 * header, a base64url payload and an `RSA-SHA256` signature over the two, which
 * `node:crypto` does in a dozen lines. Signing by hand is also what makes the negative
 * cases expressible: a library would refuse to mint most of them.
 *
 * ## What it deliberately does not do
 *
 * No refresh tokens, no `prompt`, no logout, no consent screen, and no attempt at being a
 * conformant provider. It is exactly enough surface for the authorisation-code flow this
 * product uses, and every extra endpoint would be a thing to keep working for no test.
 */

import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Base64url without padding, which is what a JWS uses everywhere. */
function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** The claims an ID token carries here. `unknown` so a test can make one wrong. */
export type IdTokenClaims = Readonly<Record<string, unknown>>;

/** How one flow should misbehave. Everything absent means "behave correctly". */
export interface FlowOverrides {
  /** Claims merged over the correct ones. A value of `undefined` deletes the claim. */
  readonly claims?: IdTokenClaims;
  /** Sign with a key the published JWKS does not contain. */
  readonly wrongKey?: boolean;
  /** Answer the token endpoint with no `id_token` at all. */
  readonly omitIdToken?: boolean;
}

/** The running provider. */
export interface FakeIdp {
  readonly issuer: string;
  /**
   * Applies these overrides to the **next** token exchange, then forgets them.
   *
   * Per-exchange rather than per-provider so one suite can run a wrong-issuer case and a
   * correct case against one server without a restart, and so a test that forgets to set
   * an override gets the correct behaviour rather than the previous test's.
   */
  next: (overrides: FlowOverrides) => void;
  /** Every authorisation request this provider has received, newest last. */
  readonly authorizations: readonly URL[];
  /** What the last token request sent, so a test can assert on PKCE and client auth. */
  lastTokenRequest: () => Readonly<Record<string, string>> | undefined;
  close: () => Promise<void>;
}

/** Options for {@link startFakeIdp}. */
export interface FakeIdpOptions {
  /** The `aud` a correct token carries. The client id this provider was registered with. */
  readonly clientId: string;
  /** The `email` claim a correct token carries. */
  readonly email: string;
  /** Omit `jwks_uri` from discovery, which is the downgrade `H-150` refuses. */
  readonly omitJwks?: boolean;
}

export async function startFakeIdp(options: FakeIdpOptions): Promise<FakeIdp> {
  // 2048 rather than 4096: this runs in every test, and the difference is a second of
  // key generation against no difference in what is being asserted.
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const authorizations: URL[] = [];
  let pending: FlowOverrides = {};
  let nonceForNextToken: string | undefined;
  let lastToken: Record<string, string> | undefined;

  const jwk = signing.publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(JSON.stringify(jwk)).digest('base64url').slice(0, 16);

  function sign(claims: IdTokenClaims, wrongKey: boolean): string {
    const header = { alg: 'RS256', typ: 'JWT', kid };
    const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signer = createSign('RSA-SHA256').update(body);
    const key = wrongKey ? other.privateKey : signing.privateKey;
    return `${body}.${signer.sign(key).toString('base64url')}`;
  }

  const server: Server = await new Promise((resolve) => {
    const instance = createServer((request, response) => {
      const issuer = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
      const url = new URL(request.url ?? '/', issuer);

      if (url.pathname === '/.well-known/openid-configuration') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/userinfo`,
            // Omitting this is the incomplete-discovery case: the library builds no
            // verification config from it, and `requireIdTokenVerification` then refuses
            // to register the provider at all rather than falling back to userinfo.
            ...(options.omitJwks === true ? {} : { jwks_uri: `${issuer}/jwks` }),
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }

      if (url.pathname === '/jwks') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] }));
        return;
      }

      if (url.pathname === '/authorize') {
        // Recorded rather than answered. The tests drive the callback themselves, because
        // following the redirect would mean running a browser to press a consent button.
        authorizations.push(url);
        nonceForNextToken = url.searchParams.get('nonce') ?? undefined;
        response.writeHead(302, { location: url.searchParams.get('redirect_uri') ?? '/' });
        response.end();
        return;
      }

      if (url.pathname === '/token') {
        let raw = '';
        request.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8');
        });
        request.on('end', () => {
          lastToken = Object.fromEntries(new URLSearchParams(raw));
          const overrides = pending;
          pending = {};

          const now = Math.floor(Date.now() / 1000);
          const correct: Record<string, unknown> = {
            iss: issuer,
            aud: options.clientId,
            sub: 'idp-subject-1',
            email: options.email,
            email_verified: true,
            name: 'Ada Lovelace',
            iat: now,
            exp: now + 300,
            ...(nonceForNextToken === undefined ? {} : { nonce: nonceForNextToken }),
          };

          const claims: Record<string, unknown> = { ...correct, ...(overrides.claims ?? {}) };
          for (const [key, value] of Object.entries(overrides.claims ?? {})) {
            if (value === undefined) delete claims[key];
          }

          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              access_token: 'fake-access-token',
              token_type: 'Bearer',
              expires_in: 300,
              scope: 'openid email profile',
              ...(overrides.omitIdToken === true
                ? {}
                : { id_token: sign(claims, overrides.wrongKey === true) }),
            }),
          );
        });
        return;
      }

      if (url.pathname === '/userinfo') {
        // Present, and deliberately claiming a *different* address from the ID token. If
        // anything ever prefers this over the verified assertion, a test that asserts on
        // the signed-in identity will say so rather than passing either way.
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            sub: 'idp-subject-1',
            email: 'userinfo-should-not-win@example.test',
            email_verified: true,
            name: 'Ada Lovelace',
          }),
        );
        return;
      }

      response.writeHead(404).end();
    });

    instance.listen(0, '127.0.0.1', () => {
      resolve(instance);
    });
  });

  const { port } = server.address() as AddressInfo;

  return {
    issuer: `http://127.0.0.1:${port}`,
    next: (overrides) => {
      pending = overrides;
    },
    authorizations,
    lastTokenRequest: () => lastToken,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      }),
  };
}
