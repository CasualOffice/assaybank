/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { API_BASE_PATH, ERROR_CODES, ID_SCHEMAS, buildOpenApiDocument } from './index.js';

const document = buildOpenApiDocument();

describe('buildOpenApiDocument()', () => {
  it('declares OpenAPI 3.1 with the top-level members the specification requires', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Assaybank API');
    expect(document.info.version).toBe('1.0.0');
    expect(document.info.license).toEqual({ name: 'MPL-2.0', url: 'https://mozilla.org/MPL/2.0/' });
    expect(document.servers).toEqual([{ url: API_BASE_PATH, description: 'Versioned API root.' }]);
    expect(document.paths).toBeTypeOf('object');
    expect(document.components).toBeTypeOf('object');
  });

  it('is deterministic, so the CI drift check compares like with like', () => {
    expect(buildOpenApiDocument()).toEqual(buildOpenApiDocument());
  });

  it('is JSON-serialisable, because it is served as a document', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(document));
    expect(roundTripped).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it('publishes the shared primitives as components', () => {
    const schemas = document.components?.schemas ?? {};
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'Uuid',
        'Rfc3339Timestamp',
        'Cursor',
        'PaginationQuery',
        'ErrorCode',
        'ErrorEnvelope',
      ]),
    );
  });

  it('publishes every branded identifier, generated from ID_SCHEMAS', () => {
    const schemas = document.components?.schemas ?? {};
    for (const name of Object.keys(ID_SCHEMAS)) {
      expect(schemas[name], name).toMatchObject({ type: 'string', format: 'uuid' });
    }
  });

  it('describes the error envelope exactly as docs/03 §2 states it', () => {
    const envelope = document.components?.schemas?.['ErrorEnvelope'];
    expect(envelope).toMatchObject({
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message', 'request_id'],
          properties: {
            code: { $ref: '#/components/schemas/ErrorCode' },
            message: { type: 'string' },
            request_id: { type: 'string' },
          },
        },
      },
    });
  });

  it('publishes the closed error-code set as an enum, in order', () => {
    expect(document.components?.schemas?.['ErrorCode']).toMatchObject({
      type: 'string',
      enum: [...ERROR_CODES],
    });
  });

  it('bounds the documented page size, so no client reads the schema as unbounded', () => {
    expect(document.components?.schemas?.['PaginationQuery']).toMatchObject({
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        cursor: { type: 'string' },
      },
    });
  });

  it('documents the two authentication domains as two separate schemes (docs/03 §1)', () => {
    expect(document.components?.securitySchemes?.['staffSession']).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'assaybank_session',
    });
    expect(document.components?.securitySchemes?.['attemptToken']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('offers reusable error responses, every one of them the same envelope', () => {
    const responses = document.components?.responses ?? {};
    expect(Object.keys(responses)).toEqual([
      'Unauthenticated',
      'Forbidden',
      'NotFound',
      'Conflict',
      'ValidationFailed',
      'RateLimited',
      'InternalError',
    ]);
    for (const [name, response] of Object.entries(responses)) {
      expect(response, name).toMatchObject({
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
        },
      });
    }
  });

  it('leaves no dangling $ref: every reference resolves to a published component', () => {
    const refs = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.add(value);
        else walk(value);
      }
    };
    walk(document);

    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      const [, ...path] = ref.split('/');
      let cursor: unknown = document;
      for (const segment of path) {
        expect(typeof cursor === 'object' && cursor !== null, ref).toBe(true);
        cursor = (cursor as Record<string, unknown>)[segment];
      }
      expect(cursor, ref).toBeDefined();
    }
  });
});
