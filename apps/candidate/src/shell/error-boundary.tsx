/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The last line of defence between a rendering bug and a candidate's assessment.
 *
 * ## Why a blank page is the worst possible outcome here
 *
 * An unhandled render error unmounts the React tree and leaves a white screen. In most
 * applications that is embarrassing. Here, the candidate is being assessed, a
 * server-owned clock is still running, and the only thing they can conclude from a blank
 * page is that they have lost their work — so they do the reasonable thing and reload,
 * or close the tab, at which point a recoverable incident becomes a support ticket and a
 * disputed result.
 *
 * So the boundary says the two things the candidate needs: their answers were saved on
 * the server as they worked, and here is how to get back in.
 *
 * ## What it must not do
 *
 * - **It must not show the error.** A stack trace in this bundle can name internal
 *   modules and route shapes, and it is rendered in front of an untrusted user on an
 *   internet-facing origin. The `request_id` is what a support ticket needs, and that is
 *   the trace id (P0 step 4), so the ticket resolves to a trace without the candidate
 *   reading anything about our internals.
 * - **It must not reload automatically.** A reload loop on a deterministic render error
 *   burns a candidate's time against a clock they cannot pause.
 */

import type { ErrorInfo, JSX, ReactNode } from 'react';
import { Component } from 'react';

import { HELP_HREF } from './app-shell';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /**
   * Reports the failure to the observability tier. Injected so this component performs
   * no I/O of its own and so a test can assert it was called.
   */
  readonly onError?: ((error: unknown, componentStack: string | null) => void) | undefined;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, info.componentStack ?? null);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <ErrorFallback />;
  }
}

function ErrorFallback(): JSX.Element {
  return (
    // role="alert" so a screen-reader user is told the screen has changed under them;
    // this is the one place an unbudgeted interruption is unambiguously correct.
    <div className="error-fallback" role="alert">
      <h1>Something went wrong on this screen</h1>
      <p>
        <strong>Your answers are saved.</strong> They are stored on our servers as you work, not in
        this page, so nothing you have done has been lost.
      </p>
      <p>
        Reopen your assessment from your invitation link to carry on where you left off. If it
        happens again, <a href={HELP_HREF}>contact us</a> and we will sort it out.
      </p>
    </div>
  );
}
