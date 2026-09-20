/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The audience boundary, expressed in the type system.
 *
 * docs/17 §3 states the rule and docs/17 §12 names the failure it prevents:
 *
 * > Candidate-facing and staff-facing serialisers for the same entity are different
 * > types, not the same type with a flag. A boolean parameter deciding whether to include
 * > answer keys will eventually be passed wrong; two types cannot be.
 *
 * Two types are necessary but not sufficient. Nothing stops somebody widening the
 * *candidate* type until it carries `is_correct` — the second type is still a second
 * type, and the leak suite only catches it if somebody remembered to feed that particular
 * shape through it. So this module adds the missing half: a compile-time predicate that
 * walks a type and answers whether it mentions, at any depth, a field that belongs to the
 * answer key.
 *
 * {@link IsCandidateSafe} is that predicate, and {@link Satisfied} is how it is asserted.
 * A candidate-facing view declares
 *
 * ```ts
 * type _proof = Satisfied<IsCandidateSafe<CandidateQuestionView>>;
 * ```
 *
 * next to its definition, and the day an author adds `is_correct` to an option — or nests
 * an author-side type inside a candidate one, which is the realistic way it happens — the
 * package stops compiling. Not a test that must be run against a payload somebody
 * remembered to construct: a type error, at the definition, in every editor.
 *
 * ## Why a name list rather than a marked type
 *
 * The alternative is to brand the sensitive *types* — `Secret<string>` for
 * `solution_code` and so on — and forbid a branded type inside a candidate view. It is
 * more elegant and it does not work here, because the rows this system serialises come
 * out of a database driver as plain strings and booleans, and the brand would have to be
 * applied by the same code that is being guarded. A name list is checkable against a type
 * that was never cooperating, which is the only kind worth having.
 *
 * The cost is that the list is a list: a field invented later under a new name is not
 * covered until somebody adds it here. That cost is paid down by keeping the vocabulary
 * closed — the names below are the columns `packages/db/src/schema/question-bank.ts`
 * marks as answer-key material, verbatim — and by the standing leak suite, which asserts
 * over real payloads and carries its own broader deny-list. Belt, braces, and a note on
 * the schema saying which is which.
 *
 * Nothing here performs I/O or reads a clock.
 */

/**
 * Field names that may never appear in a candidate-facing type, at any depth.
 *
 * Each is a column that `question-bank.ts` marks as answer-key material, in both the
 * `snake_case` the wire uses and the `camelCase` the Drizzle row carries — a serialiser
 * that forwarded a row object rather than building a view would leak the camel spelling,
 * so both are refused.
 *
 * | name | what it gives away |
 * |---|---|
 * | `is_correct`, `score_delta`, `rationale_md` | which MCQ option is the answer, and why |
 * | `correct_option_ids`, `answer_key`, `answer_keys` | the same thing, aggregated |
 * | `solution_code`, `checker_code` | the reference solution (`coding_specs`) |
 * | `expected_stdout`, `expected_output` | what a test case expects (`test_cases`) |
 * | `assertion_code` | the unit test itself, which names the function and the expected value |
 * | `match_type`, `pattern`, `tolerance` | the whole of a `short_answer_keys` row |
 * | `explanation_md` | the worked answer, written for the post-attempt review screen |
 *
 * `pattern` and `tolerance` are generic words, and banning them costs a candidate-facing
 * type the right to use them for something innocent. That is the correct trade: the
 * innocent use can be renamed, and a `short_answer_keys` row reaching a candidate cannot
 * be taken back.
 */
export type AnswerKeyField =
  | 'is_correct'
  | 'isCorrect'
  | 'correct_option_ids'
  | 'correctOptionIds'
  | 'answer_key'
  | 'answerKey'
  | 'answer_keys'
  | 'answerKeys'
  | 'score_delta'
  | 'scoreDelta'
  | 'rationale_md'
  | 'rationaleMd'
  | 'solution_code'
  | 'solutionCode'
  | 'checker_code'
  | 'checkerCode'
  | 'expected_stdout'
  | 'expectedStdout'
  | 'expected_output'
  | 'expectedOutput'
  | 'assertion_code'
  | 'assertionCode'
  | 'match_type'
  | 'matchType'
  | 'pattern'
  | 'tolerance'
  | 'explanation_md'
  | 'explanationMd';

/**
 * The runtime twin of {@link AnswerKeyField}.
 *
 * `satisfies` rather than a plain annotation, so the array and the union cannot drift:
 * a name added to one and not the other is a compile error in this file. The array is
 * what {@link findAnswerKeyFields} walks and what the standing leak suite asserts its own
 * deny-list is a superset of.
 */
export const ANSWER_KEY_FIELDS = Object.freeze([
  'is_correct',
  'isCorrect',
  'correct_option_ids',
  'correctOptionIds',
  'answer_key',
  'answerKey',
  'answer_keys',
  'answerKeys',
  'score_delta',
  'scoreDelta',
  'rationale_md',
  'rationaleMd',
  'solution_code',
  'solutionCode',
  'checker_code',
  'checkerCode',
  'expected_stdout',
  'expectedStdout',
  'expected_output',
  'expectedOutput',
  'assertion_code',
  'assertionCode',
  'match_type',
  'matchType',
  'pattern',
  'tolerance',
  'explanation_md',
  'explanationMd',
]) satisfies readonly AnswerKeyField[];

const ANSWER_KEY_SET: ReadonlySet<string> = new Set<string>(ANSWER_KEY_FIELDS);

/**
 * `true` when `T` is an object type that names an answer-key field directly.
 *
 * Wrapped in tuples so that a union in `keyof T` does not distribute and produce a union
 * of booleans where a single answer is meant.
 */
type NamesAnswerKey<T> = [Extract<keyof T, AnswerKeyField>] extends [never] ? false : true;

/**
 * `true` when any property of `T` carries an answer-key field beneath it.
 *
 * `-?` strips optionality from the mapped type so that a key which is optional is still
 * visited; indexing with `keyof T` then unions the per-property answers. An object with
 * no keys at all indexes to `never`, and `never extends false` is true, which is the
 * answer that shape should give.
 */
type PropertiesCarryAnswerKey<T> = {
  [K in keyof T]-?: HasAnswerKeyField<T[K]>;
}[keyof T] extends false
  ? false
  : true;

/**
 * `true` when `T` mentions an {@link AnswerKeyField} anywhere in its shape.
 *
 * Deliberately a *naked* `T extends …` chain, so the conditional distributes across
 * unions and every member of a discriminated union is judged on its own keys. The
 * non-distributive spelling would compute `keyof T` for the union, which is the
 * *intersection* of the members' keys — and would therefore report a union whose one
 * dangerous member carries `is_correct` as perfectly safe. That is the exact bug this
 * file exists to catch, so getting the variance wrong here would be worse than not
 * having the check.
 *
 * `Date` is special-cased because it is an object whose own keys are methods, and
 * walking it adds depth for nothing. Primitives, `null` and `undefined` answer `false`.
 */
export type HasAnswerKeyField<T> = T extends readonly (infer Element)[]
  ? HasAnswerKeyField<Element>
  : T extends Date
    ? false
    : T extends object
      ? NamesAnswerKey<T> extends true
        ? true
        : PropertiesCarryAnswerKey<T>
      : false;

/**
 * `true` when `T` is fit to serve to a candidate, as far as answer keys are concerned.
 *
 * "As far as answer keys are concerned" is the whole of the claim. It says nothing about
 * another candidate's identity, about staff configuration, or about an organisation's
 * settings — those are the standing leak suite's `staff-shaped-fields.ts` deny-list, and
 * they are a different failure with a different remedy. This predicate is FR-12's first
 * clause and no more.
 */
export type IsCandidateSafe<T> = HasAnswerKeyField<T> extends false ? true : false;

/**
 * A compile-time assertion. `Satisfied<IsCandidateSafe<T>>` compiles only when it is.
 *
 * The type parameter is constrained to `true`, so passing `false` is an error at the
 * declaration rather than a value nobody reads. Used as a `type _proof = …` declaration
 * beside a candidate-facing view; `eslint` is configured to allow the unused name through
 * the leading-underscore convention.
 */
export type Satisfied<T extends true> = T;

/**
 * Walks an already-serialised payload and returns the dotted path of every answer-key
 * field it carries. An empty array means the payload named none of them.
 *
 * The runtime backstop to the compile-time predicate, and it exists for the one case the
 * predicate cannot see: a value that reached the serialiser as `unknown`, through a
 * `JSON.parse`, or out of a `jsonb` column. `unknown` is the parameter type on purpose —
 * the question being asked is what actually crossed the boundary, not what a signature
 * claimed would.
 *
 * It is a detector, never a filter. Nothing in this package strips a field and continues;
 * a payload that trips this has a bug upstream of it, and quietly cleaning it would hide
 * the bug while leaving every other path that shares the serialiser broken.
 */
export function findAnswerKeyFields(payload: unknown, path = '$'): string[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry, index) => findAnswerKeyFields(entry, `${path}[${index}]`));
  }

  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const found: string[] = [];

  for (const [key, value] of Object.entries(payload)) {
    const here = `${path}.${key}`;
    if (ANSWER_KEY_SET.has(key)) {
      found.push(here);
    }
    found.push(...findAnswerKeyFields(value, here));
  }

  return found;
}
