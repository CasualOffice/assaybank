/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ReactNode, useId } from 'react';

import { cx, describedBy } from './class-names.js';

/**
 * The props {@link Field} hands to its control.
 *
 * Every member is required, and several are `T | undefined` rather than optional, so
 * that `<Input {...control} />` spreads the whole set and a control cannot silently
 * receive three of the five.
 */
export interface FieldControlProps {
  /** The control's `id`. Matches the `<label for>`. */
  id: string;
  /** The description and error ids, in DOM order, or `undefined` when there are none. */
  'aria-describedby': string | undefined;
  /** `true` when an error is shown. */
  'aria-invalid': true | undefined;
  /** Mirrors `required`, for controls that cannot take the native attribute. */
  'aria-required': true | undefined;
  /** The native attribute. */
  required: boolean | undefined;
}

/** Props for {@link Field}. */
export interface FieldProps {
  /** The visible label. Always visible, never a placeholder and never an `aria-label`. */
  label: ReactNode;
  /**
   * Renders the control, given the wiring it must apply.
   *
   * A render prop rather than `cloneElement`: cloning guesses at which child is the
   * control and drops the wiring silently when it guesses wrong, and a form field whose
   * label is not associated is the most common accessibility defect there is.
   */
  children: (control: FieldControlProps) => ReactNode;
  /** Help text, rendered above the control and referenced by `aria-describedby`. */
  description?: ReactNode;
  /**
   * The validation message. Its presence is what sets `aria-invalid` and adds the error
   * to `aria-describedby`, so the visual state and the announced state cannot diverge
   * (SC 3.3.1).
   */
  error?: ReactNode;
  /** Marks the field required, in the attribute and in visible text. */
  required?: boolean;
  /** An explicit control id. One is generated when this is omitted. */
  id?: string;
  /** Additional class names, appended to `ab-field`. */
  className?: string;
}

/**
 * A labelled form control with its description and error wired to it.
 *
 * This component exists because SC 1.3.1, 3.3.1, 3.3.2 and 4.1.2 are all satisfied by
 * the same four attributes, and all four are forgotten by the same omission. Getting
 * them right once here is the difference between an assessment builder a screen-reader
 * user can complete and one that is guesswork (docs/15 §2.2).
 *
 * The wiring it guarantees:
 *
 * - `<label for>` points at the control's `id` — a real association, not proximity.
 * - `aria-describedby` lists the description then the error, **in DOM order**, so what
 *   is read matches what is seen.
 * - `aria-invalid` is set from the presence of `error` and from nothing else.
 * - "(required)" is text, not a red asterisk — an asterisk is an unlabelled glyph and a
 *   colour, failing SC 1.4.1 and SC 3.3.2 at once.
 *
 * The error is **not** a live region. A field error is reached by moving to the field,
 * where `aria-describedby` reads it; announcing every field error as it renders is how a
 * form with six invalid fields shouts six times and is understood once. A submit that
 * fails validation announces a summary instead — use `Alert` with `live="assertive"`, or
 * `useAnnounce`.
 */
export function Field({
  label,
  children,
  description,
  error,
  required,
  id,
  className,
}: FieldProps): ReactNode {
  const generatedId = useId();
  const controlId = id ?? `${generatedId}-control`;
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;

  const hasDescription = description !== undefined && description !== null && description !== false;
  const hasError = error !== undefined && error !== null && error !== false;

  const control: FieldControlProps = {
    id: controlId,
    'aria-describedby': describedBy(hasDescription && descriptionId, hasError && errorId),
    'aria-invalid': hasError ? true : undefined,
    'aria-required': required === true ? true : undefined,
    required,
  };

  return (
    <div className={cx('ab-field', className)}>
      <label className="ab-field__label" htmlFor={controlId}>
        {label}
        {required === true ? <span className="ab-field__requirement"> (required)</span> : null}
      </label>

      {hasDescription ? (
        <p className="ab-field__description" id={descriptionId}>
          {description}
        </p>
      ) : null}

      {children(control)}

      {hasError ? (
        <p className="ab-field__error" id={errorId}>
          {/* The glyph is decoration; the word "Error" beside it is the information. */}
          <span aria-hidden="true">&#9888;</span>
          <span>
            <span className="ab-visually-hidden">Error: </span>
            {error}
          </span>
        </p>
      ) : null}
    </div>
  );
}
