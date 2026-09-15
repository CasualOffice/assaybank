/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ERROR_CODES,
  type ErrorCode,
  ErrorEnvelopeSchema,
  INTERNAL_ERROR_MESSAGE,
} from '@assaybank/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../api/client.js';
import {
  ErrorEnvelopeView,
  guidanceForCode,
  RootErrorBoundary,
  toDisplayEnvelope,
} from './ErrorBoundary.js';

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('toDisplayEnvelope', () => {
  it('passes an API failure through with its code and trace id intact', () => {
    const failure = new ApiRequestError(
      {
        error: {
          code: 'version_immutable',
          message: 'A published question version cannot be modified.',
          request_id: 'trace-1',
        },
      },
      409,
    );

    expect(toDisplayEnvelope(failure)).toEqual({
      error: {
        code: 'version_immutable',
        message: 'A published question version cannot be modified.',
        request_id: 'trace-1',
      },
    });
  });

  it.each([
    ['a TypeError', new TypeError('x.y is not a function')],
    ['a plain Error carrying an internal path', new Error('ENOENT /srv/secrets/token-pepper')],
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
  ])('turns %s into the fixed internal envelope', (_label, thrown) => {
    const envelope = toDisplayEnvelope(thrown);

    // docs/14 records error-message leakage as a real path to hidden test-case content,
    // and the client side is not exempt: a crash message can carry a path, a stack or a
    // field name that the API never meant to publish.
    expect(envelope.error.code).toBe('internal');
    expect(envelope.error.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(envelope.error.request_id).toBe('');
  });

  it('always produces something the contract accepts', () => {
    expect(ErrorEnvelopeSchema.safeParse(toDisplayEnvelope(new Error('boom'))).success).toBe(true);
  });
});

describe('guidanceForCode', () => {
  it.each(ERROR_CODES.map((code): [ErrorCode] => [code]))('has usable advice for %s', (code) => {
    // Every member of the closed union is covered, including the ones with no specific
    // entry — adding a code to the contract must not leave a screen with nothing to say.
    expect(guidanceForCode(code).length).toBeGreaterThan(10);
  });

  it('tells the user a published version is edited by creating a new one', () => {
    // Branching on the code rather than on the message is what makes advice like this
    // safe to write: the prose it reacts to is free to change (ADR-003, docs/17 §3).
    expect(guidanceForCode('version_immutable')).toContain('new version');
  });

  it('says an execution failure has scored nobody zero', () => {
    // docs/17 §0 rule 4: no infrastructure failure scores anyone zero, and a user reading
    // an error screen during an exam window needs to be told that in the first sentence.
    expect(guidanceForCode('execution_unavailable')).toContain('no attempt has been scored');
  });
});

describe('ErrorEnvelopeView', () => {
  const envelope = {
    error: {
      code: 'not_found' as const,
      message: 'The requested resource does not exist.',
      request_id: '0af7651916cd43dd8448eb211c80319c',
    },
  };

  it('shows the code and the support reference as text', () => {
    const text = textOf(renderToStaticMarkup(<ErrorEnvelopeView envelope={envelope} />));

    // The code is what a support conversation is about. Hiding it means the user reads
    // out prose that may since have been reworded.
    expect(text).toContain('not_found');
    expect(text).toContain('0af7651916cd43dd8448eb211c80319c');
  });

  it('shows the guidance for the code alongside the server prose', () => {
    const text = textOf(renderToStaticMarkup(<ErrorEnvelopeView envelope={envelope} />));

    expect(text).toContain(guidanceForCode('not_found'));
    expect(text).toContain('The requested resource does not exist.');
  });

  it('interrupts, because this replaced what the user was reading', () => {
    const markup = renderToStaticMarkup(<ErrorEnvelopeView envelope={envelope} />);

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
  });

  it('names the error tone in text, never by colour alone', () => {
    const text = textOf(renderToStaticMarkup(<ErrorEnvelopeView envelope={envelope} />));

    // SC 1.4.1. A red-bordered box is not an error message to a screen-reader user.
    expect(text).toContain('Error');
  });

  it('omits the support reference when there is no trace id to quote', () => {
    const text = textOf(
      renderToStaticMarkup(
        <ErrorEnvelopeView
          envelope={{ error: { code: 'internal', message: 'x', request_id: '' } }}
        />,
      ),
    );

    // A crash inside React has no server trace. Printing an empty reference invites the
    // user to quote nothing.
    expect(text).not.toContain('Support reference');
  });

  it('renders no retry control when there is nothing to retry', () => {
    const markup = renderToStaticMarkup(<ErrorEnvelopeView envelope={envelope} />);

    expect(markup).not.toContain('<button');
  });

  it('renders a retry control when one is offered, as a button and not a link', () => {
    const markup = renderToStaticMarkup(
      <ErrorEnvelopeView
        envelope={envelope}
        onRetry={() => {
          /* no-op */
        }}
      />,
    );

    // An action is a button. A link that does not navigate is announced as a link and
    // does not respond to the space bar.
    expect(markup).toContain('<button');
    expect(markup).toContain('type="button"');
  });

  it('gives its heading a level the caller chooses, so no level is skipped', () => {
    const asPage = renderToStaticMarkup(<ErrorEnvelopeView envelope={envelope} />);
    const inSection = renderToStaticMarkup(
      <ErrorEnvelopeView envelope={envelope} headingLevel={2} />,
    );

    expect(asPage).toContain('<h1');
    expect(inSection).toContain('<h2');
    expect(inSection).not.toContain('<h1');
  });

  it('does not steal focus by rendering', () => {
    const markup = renderToStaticMarkup(<ErrorEnvelopeView envelope={envelope} />);

    // tabIndex -1 makes the heading a focus *target* the router can move to. It must not
    // be in the tab order, and nothing may grab focus because it appeared (docs/15 §9.3).
    expect(markup).toContain('tabindex="-1"');
    expect(markup).not.toContain('autofocus');
  });
});

describe('RootErrorBoundary', () => {
  it('derives the envelope from whatever was thrown', () => {
    const state = RootErrorBoundary.getDerivedStateFromError(new TypeError('undefined is not'));

    expect(state.envelope?.error.code).toBe('internal');
  });

  it('keeps an API failure’s code when one propagates out of a render', () => {
    const failure = new ApiRequestError(
      { error: { code: 'forbidden', message: 'No.', request_id: 'trace-2' } },
      403,
    );

    expect(RootErrorBoundary.getDerivedStateFromError(failure).envelope?.error.code).toBe(
      'forbidden',
    );
  });

  it('renders its children while nothing has gone wrong', () => {
    const markup = renderToStaticMarkup(
      <RootErrorBoundary>
        <p>Dashboard</p>
      </RootErrorBoundary>,
    );

    expect(markup).toContain('Dashboard');
    expect(markup).not.toContain('Something went wrong');
  });

  it('renders the standard envelope once it has caught something', () => {
    // The boundary is exercised through its own lifecycle rather than through a thrown
    // render: `renderToStaticMarkup` has no error-boundary recovery, so the honest way to
    // test the fallback without a document is to drive getDerivedStateFromError and
    // render what it produced.
    const state = RootErrorBoundary.getDerivedStateFromError(new Error('render blew up'));
    const envelope = state.envelope;
    expect(envelope).not.toBeNull();

    if (envelope === null) {
      return;
    }

    const text = textOf(renderToStaticMarkup(<ErrorEnvelopeView envelope={envelope} />));

    expect(text).toContain('Something went wrong');
    expect(text).toContain('internal');
    // The thrown message never reaches the user.
    expect(text).not.toContain('render blew up');
  });

  it('reports what it caught exactly once, and does not rethrow', () => {
    const onError = vi.fn();
    const boundary = new RootErrorBoundary({ children: null, onError });
    const info = { componentStack: '\n    at Dashboard' };
    const cause = new Error('boom');

    boundary.componentDidCatch(cause, info);

    // Catching to log and rethrow produces duplicate logs and a lost stack for no added
    // information (docs/17 §12), so the boundary reports and stops.
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(cause, info);
  });

  it('survives having no error reporter', () => {
    const boundary = new RootErrorBoundary({ children: null });

    expect(() => {
      boundary.componentDidCatch(new Error('boom'), { componentStack: '' });
    }).not.toThrow();
  });
});
