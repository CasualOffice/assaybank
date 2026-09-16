/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { API_BASE_PATH } from '@assaybank/contracts';

/**
 * OpenAPI writes a path parameter as `{id}` and Fastify as `:id`, and the contract's paths omit
 * the version prefix.
 *
 * Converted rather than declared twice: the document and the route table have to describe the
 * same URL, and two string literals that must match is two string literals that will eventually
 * not. The taxonomy routes were once registered as bare `/skills` — outside `/api/v1` — which is
 * exactly that drift. `@assaybank/contracts` owns the spelling; this is the one translation.
 */
export function fastifyPath(openApiPath: string): string {
  return `${API_BASE_PATH}${openApiPath.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, ':$1')}`;
}
