/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Alert, Button } from '@assaybank/ui';
import { type ErrorCode, type ErrorEnvelope, INTERNAL_ERROR_MESSAGE } from '@assaybank/contracts';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { ApiRequestError } from '../api/client.js';

/**
 * Normalises anything thrown during render into the one error shape this product has.
 *
 * The console renders API failures and its own crashes with the same component, which is
 * deliberate: a user does not care which layer broke, and two failure presentations mean
 * one of them is the neglected one. The envelope from `@assaybank/contracts` is that one
 * shape, and it already carries the `code` a screen is allowed to branch on.
 *
 * A crash inside React has no server trace id, so `request_id` is empty and the view omits
 * the support reference rather than printing a blank one.
 */
export function toDisplayEnvelope(cause: unknown): ErrorEnvelope {
  if (ApiRequestError.is(cause)) {
    return cause.envelope;
  }

  return { error: { code: 'internal', message: INTERNAL_ERROR_MESSAGE, request_id: '' } };
}

/**
 * What the user can do about each code, keyed by the code.
 *
 * This is what "branch on `code`, never on `message`" looks like in a component: a lookup
 * on a closed union, exhaustively typed, rather than a string test against prose the API
 * is free to reword. A code with no entry falls back to the generic line, so adding a code
 * to the contract cannot break this screen.
 */
const CODE_GUIDANCE: Partial<Readonly<Record<ErrorCode, string>>> = Object.freeze({
  unauthenticated: 'Your session has ended. Sign in again to continue.',
  forbidden: 'Your role does not include this action. An administrator can grant it.',
  not_found: 'That record does not exist, or is not visible to your organisation.',
  validation_failed: 'Some of the values submitted were not valid. Check the fields and retry.',
  conflict: 'Somebody else changed this while you were working. Reload and try again.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  version_immutable:
    'A published question version cannot be edited. Create a new version instead (ADR-003).',
  translation_immutable: 'A published translation cannot be edited. Create a new one instead.',
  execution_unavailable:
    'Code execution is temporarily unavailable. Nothing has been lost and no attempt has been ' +
    'scored — this will be retried.',
  internal: 'Something went wrong at our end. Nothing you did caused it.',
});

/** The fallback guidance, for a code this screen has no specific advice for. */
const GENERIC_GUIDANCE = 'Reload the page. If it keeps happening, quote the reference below.';

/** What the user should do about a failure, chosen by code. */
export function guidanceForCode(code: ErrorCode): string {
  return CODE_GUIDANCE[code] ?? GENERIC_GUIDANCE;
}

/** Props for {@link ErrorEnvelopeView}. */
export interface ErrorEnvelopeViewProps {
  /** The failure, in the one shape this product has. */
  envelope: ErrorEnvelope;
  /** Called when the user asks to try again. Omitted when there is nothing to retry. */
  onRetry?: () => void;
  /** The heading level to render, so the view does not skip a level in its context. */
  headingLevel?: 1 | 2;
}

/**
 * Renders an error envelope.
 *
 * Three accessibility decisions, all from docs/15:
 *
 * - The alert is `live="assertive"`. This is content that appeared because something the
 *   user did failed, and it replaced what they were reading — one of the few cases where
 *   interrupting is correct (§5.1).
 * - Focus is **not** stolen. The heading carries `tabIndex={-1}` so the router can move
 *   focus deliberately on a route-level failure, but nothing grabs it because it rendered
 *   (§9.3).
 * - The code is shown as text next to the reference. It is what a support conversation is
 *   actually about, and hiding it means the user reads out prose that may since have
 *   changed.
 */
export function ErrorEnvelopeView({
  envelope,
  onRetry,
  headingLevel = 1,
}: ErrorEnvelopeViewProps): ReactNode {
  const { code, message, request_id: requestId } = envelope.error;
  const heading = 'Something went wrong';

  return (
    <div className="ab-error">
      {headingLevel === 1 ? (
        <h1 className="ab-error__heading" tabIndex={-1}>
          {heading}
        </h1>
      ) : (
        <h2 className="ab-error__heading" tabIndex={-1}>
          {heading}
        </h2>
      )}

      <Alert tone="danger" live="assertive" title={guidanceForCode(code)}>
        <p>{message}</p>
      </Alert>

      <dl className="ab-error__facts">
        <dt>Error code</dt>
        <dd>
          <code>{code}</code>
        </dd>
        {requestId.length > 0 ? (
          <>
            <dt>Support reference</dt>
            <dd>
              <code>{requestId}</code>
            </dd>
          </>
        ) : null}
      </dl>

      {onRetry === undefined ? null : (
        <Button tone="primary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Props for {@link RootErrorBoundary}. */
export interface RootErrorBoundaryProps {
  children: ReactNode;
  /** Receives anything caught, for the log. Injected so the boundary itself does no I/O. */
  onError?: (error: unknown, info: ErrorInfo) => void;
}

/** State for {@link RootErrorBoundary}. */
export interface RootErrorBoundaryState {
  envelope: ErrorEnvelope | null;
}

/**
 * The last line of defence: a render crash anywhere below this becomes the standard error
 * envelope instead of a blank page.
 *
 * A class component because `getDerivedStateFromError` has no hook equivalent — this is
 * one of the two things React still has no function-component API for, and wrapping a
 * third-party boundary library to avoid twenty lines would be the "wrapping a library used
 * exactly once" anti-pattern of docs/17 §12.
 *
 * It catches render errors only. Promise rejections in an event handler or a query do not
 * reach it — those are surfaced by the caller, typically through `ErrorEnvelopeView` with
 * a retry, which is why that view is exported separately and not nested inside here.
 */
export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  constructor(props: RootErrorBoundaryProps) {
    super(props);
    this.state = { envelope: null };
  }

  /** Converts the thrown value into the envelope before anything renders. */
  static getDerivedStateFromError(cause: unknown): RootErrorBoundaryState {
    return { envelope: toDisplayEnvelope(cause) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Reported, never re-thrown, and never logged-and-rethrown — that produces duplicate
    // logs and a lost stack for no added information (docs/17 §12).
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    const { envelope } = this.state;

    if (envelope === null) {
      return this.props.children;
    }

    return (
      <div className="ab-error-boundary">
        <ErrorEnvelopeView
          envelope={envelope}
          onRetry={() => {
            this.setState({ envelope: null });
          }}
        />
      </div>
    );
  }
}
