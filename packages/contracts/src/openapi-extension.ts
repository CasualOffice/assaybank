/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Installs `.openapi()` on the zod prototype. Side effect only; this module exports
 * nothing.
 *
 * **It must run before any schema in this package is constructed.** zod 4 fixes an
 * instance's methods when the instance is built, so a schema created before the
 * extension ran would not have the method, and naming it as an OpenAPI component would
 * fail at import time. Every module in this package that constructs a schema therefore
 * imports this one first. `extendZodWithOpenApi` is idempotent, so importing it in five
 * places costs nothing and removes the ordering question entirely.
 */

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);
