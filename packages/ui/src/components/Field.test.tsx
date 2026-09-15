/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { describedByIds, findElement, hasId, scanTags, textOfId } from '../test-support/markup.js';
import { Field } from './Field.js';
import { Input } from './Input.js';

/** The wiring assertions of SC 1.3.1, 3.3.1, 3.3.2 and 4.1.2, one by one. */
describe('Field', () => {
  it('associates the visible label with the control through for/id', () => {
    const markup = renderToStaticMarkup(
      <Field label="Question title">{(control) => <Input {...control} />}</Field>,
    );

    const label = findElement(markup, 'label');
    const input = findElement(markup, 'input');

    expect(input.attrs['id']).toBeDefined();
    expect(label.attrs['for']).toBe(input.attrs['id']);
    // Not an aria-label and not a placeholder: a sighted user gets the name too.
    expect(input.attrs['aria-label']).toBeUndefined();
    expect(input.attrs['placeholder']).toBeUndefined();
  });

  it('honours an explicit id so a caller can address the control', () => {
    const markup = renderToStaticMarkup(
      <Field label="Slug" id="question-slug">
        {(control) => <Input {...control} />}
      </Field>,
    );

    expect(findElement(markup, 'input').attrs['id']).toBe('question-slug');
    expect(findElement(markup, 'label').attrs['for']).toBe('question-slug');
  });

  it('points aria-describedby at the description when there is one', () => {
    const markup = renderToStaticMarkup(
      <Field label="Duration" id="duration" description="Minutes, between 5 and 240.">
        {(control) => <Input {...control} />}
      </Field>,
    );

    const input = findElement(markup, 'input');
    expect(describedByIds(input)).toEqual(['duration-description']);
    expect(hasId(markup, 'duration-description')).toBe(true);
    expect(textOfId(markup, 'duration-description')).toBe('Minutes, between 5 and 240.');
  });

  it('lists the description then the error, matching DOM order', () => {
    const markup = renderToStaticMarkup(
      <Field
        label="Duration"
        id="duration"
        description="Minutes, between 5 and 240."
        error="Enter a number of minutes."
      >
        {(control) => <Input {...control} />}
      </Field>,
    );

    const input = findElement(markup, 'input');
    expect(describedByIds(input)).toEqual(['duration-description', 'duration-error']);

    // What is read has to match what is seen: the description sits above the control and
    // the error below it, so the describedby order is description-then-error.
    const tags = scanTags(markup);
    const descriptionAt = tags.find((tag) => tag.attrs['id'] === 'duration-description')?.at ?? -1;
    const errorAt = tags.find((tag) => tag.attrs['id'] === 'duration-error')?.at ?? -1;
    expect(descriptionAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(descriptionAt);
  });

  it('omits aria-describedby entirely when there is nothing to describe', () => {
    const markup = renderToStaticMarkup(
      <Field label="Title" id="title">
        {(control) => <Input {...control} />}
      </Field>,
    );

    // An empty aria-describedby points at nothing, which is not the same as absent.
    expect(findElement(markup, 'input').attrs['aria-describedby']).toBeUndefined();
  });

  it('sets aria-invalid from the presence of an error and from nothing else', () => {
    const valid = renderToStaticMarkup(
      <Field label="Title" id="title">
        {(control) => <Input {...control} />}
      </Field>,
    );
    const invalid = renderToStaticMarkup(
      <Field label="Title" id="title" error="Title is required.">
        {(control) => <Input {...control} />}
      </Field>,
    );

    expect(findElement(valid, 'input').attrs['aria-invalid']).toBeUndefined();
    expect(findElement(invalid, 'input').attrs['aria-invalid']).toBe('true');
    expect(describedByIds(findElement(invalid, 'input'))).toEqual(['title-error']);
  });

  it('identifies the error in text, not by colour', () => {
    const markup = renderToStaticMarkup(
      <Field label="Title" id="title" error="Title is required.">
        {(control) => <Input {...control} />}
      </Field>,
    );

    // SC 1.4.1: the red border is reinforcement. "Error:" is the information, and it is
    // inside the element aria-describedby points at, so it is read with the message.
    expect(textOfId(markup, 'title-error')).toContain('Error:');
    expect(textOfId(markup, 'title-error')).toContain('Title is required.');
  });

  it('does not make the error a live region', () => {
    const markup = renderToStaticMarkup(
      <Field label="Title" id="title" error="Title is required.">
        {(control) => <Input {...control} />}
      </Field>,
    );

    // Six invalid fields must not shout six times; a submit failure announces a summary
    // instead (docs/15 §5.1).
    expect(markup).not.toContain('aria-live');
    expect(markup).not.toContain('role="alert"');
  });

  it('marks a required field in the attribute and in visible text', () => {
    const markup = renderToStaticMarkup(
      <Field label="Title" id="title" required>
        {(control) => <Input {...control} />}
      </Field>,
    );

    const input = findElement(markup, 'input');
    expect(input.attrs['required']).toBeDefined();
    expect(input.attrs['aria-required']).toBe('true');

    // A red asterisk is an unlabelled glyph and a colour. The word is the requirement.
    expect(markup).toContain('(required)');
    expect(markup).not.toContain('*');
  });

  it('generates a unique control id per instance when none is given', () => {
    const markup = renderToStaticMarkup(
      <div>
        <Field label="First">{(control) => <Input {...control} />}</Field>
        <Field label="Second">{(control) => <Input {...control} />}</Field>
      </div>,
    );

    const ids = scanTags(markup)
      .filter((tag) => tag.name === 'input')
      .map((tag) => tag.attrs['id']);

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    // Duplicate ids break aria-labelledby and aria-describedby regardless of what WCAG
    // 2.2 says about removing SC 4.1.1 (docs/15 §2.3).
    expect(ids[0]).not.toBe(ids[1]);
  });
});
