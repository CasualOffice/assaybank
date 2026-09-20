/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authoring one question (H-038).
 *
 * ## The screen's whole job is making ADR-003 legible before it bites
 *
 * A published version is frozen. Editing one does not modify it — it writes a *new* version, and
 * the old one stays exactly as it was served, because an attempt graded against version 2 has to
 * remain explainable after version 3 exists. The API enforces that with a database trigger and a
 * `409 version_immutable`; a screen that let an author type into a published version and then
 * showed them that error has told them about the rule at the worst possible moment.
 *
 * So the editor is read-only on a published version and says why, with the action that moves
 * forward — "Edit as a new version" — in the same place the disabled controls are. The roadmap's
 * phrasing for this phase is that the API should "make that the natural path rather than a wall
 * people hit"; this screen is where an author meets the path.
 *
 * ## What is sent on save
 *
 * Only the fields that changed. `POST /questions/{id}/versions` is a patch over the previous
 * version, so an untouched field is copied forward byte for byte. Sending the whole form back
 * would make every save a full rewrite, and "what changed between version 3 and version 4" — the
 * question the version history exists to answer — would become unanswerable.
 *
 * ## Publishing
 *
 * Irreversible, so it asks. The confirmation names what becomes true rather than asking whether
 * the user is sure: "candidates can be served this version, and its content can never change."
 */

import {
  CHOICE_KINDS,
  CODE_KINDS,
  MAX_DIFFICULTY,
  MIN_DIFFICULTY,
  type AuthorQuestionVersionView,
  type AuthorQuestionView,
  type QuestionKind,
} from '@assaybank/contracts';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  useAnnounce,
} from '@assaybank/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';

import { useApi } from '../api/api.js';
import {
  createVersionRequest,
  patchQuestionRequest,
  publishVersionRequest,
  questionQuery,
  updateVersionRequest,
} from '../api/questions.js';
import { toDisplayEnvelope } from '../app/ErrorBoundary.js';
import { DIFFICULTY_LABELS, KIND_LABELS, STATUS_LABELS, STATUS_TONES } from './question-labels.js';
import { excerpt } from './QuestionsScreen.js';

/** The fields this editor manages. A subset of the version input, and all of them scalars. */
interface Draft {
  prompt_md: string;
  explanation_md: string;
  difficulty: number;
  est_seconds: number;
  max_score: number;
}

/** One option row being edited. `id` is the server's, or undefined for a row not yet saved. */
interface OptionDraft {
  key: string;
  body_md: string;
  is_correct: boolean;
}

interface TestCaseDraft {
  key: string;
  label: string;
  stdin: string;
  expected_stdout: string;
  is_sample: boolean;
}

interface AnswerKeyDraft {
  key: string;
  match_type: 'exact' | 'ci' | 'regex' | 'numeric_tolerance';
  pattern: string;
}

const DIFFICULTIES = Array.from(
  { length: MAX_DIFFICULTY - MIN_DIFFICULTY + 1 },
  (_, i) => MIN_DIFFICULTY + i,
);

/** A stable key for a row the server has not seen. `crypto.randomUUID` is available in both apps. */
const newKey = (): string => globalThis.crypto.randomUUID();

function draftOf(version: AuthorQuestionVersionView | null): Draft {
  return {
    prompt_md: version?.prompt_md ?? '',
    explanation_md: version?.explanation_md ?? '',
    difficulty: version?.difficulty ?? 3,
    est_seconds: version?.est_seconds ?? 120,
    max_score: version?.max_score ?? 1,
  };
}

/**
 * The fields that differ from the loaded version.
 *
 * This is what keeps the version history readable: a save that touched the prompt sends the
 * prompt, and version 4 differs from version 3 in exactly one field.
 */
function changedScalars(original: Draft, draft: Draft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.prompt_md !== original.prompt_md) patch['prompt_md'] = draft.prompt_md;
  if (draft.explanation_md !== original.explanation_md) {
    patch['explanation_md'] = draft.explanation_md === '' ? null : draft.explanation_md;
  }
  if (draft.difficulty !== original.difficulty) patch['difficulty'] = draft.difficulty;
  if (draft.est_seconds !== original.est_seconds) patch['est_seconds'] = draft.est_seconds;
  if (draft.max_score !== original.max_score) patch['max_score'] = draft.max_score;
  return patch;
}

function optionsOf(version: AuthorQuestionVersionView | null): OptionDraft[] {
  return (version?.options ?? []).map((o) => ({
    key: o.id,
    body_md: o.body_md,
    is_correct: o.is_correct,
  }));
}

function testCasesOf(version: AuthorQuestionVersionView | null): TestCaseDraft[] {
  return (version?.test_cases ?? []).map((t) => ({
    key: t.id,
    label: t.label ?? '',
    stdin: t.stdin,
    expected_stdout: t.expected_stdout ?? '',
    is_sample: t.is_sample,
  }));
}

function answerKeysOf(version: AuthorQuestionVersionView | null): AnswerKeyDraft[] {
  return (version?.answer_keys ?? []).map((k) => ({
    key: k.id,
    match_type: k.match_type as AnswerKeyDraft['match_type'],
    pattern: k.pattern,
  }));
}

const sameOptions = (a: OptionDraft[], b: OptionDraft[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => x.body_md === b[i]?.body_md && x.is_correct === b[i]?.is_correct);

const sameCases = (a: TestCaseDraft[], b: TestCaseDraft[]): boolean =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.label === b[i]?.label &&
      x.stdin === b[i]?.stdin &&
      x.expected_stdout === b[i]?.expected_stdout &&
      x.is_sample === b[i]?.is_sample,
  );

const sameKeys = (a: AnswerKeyDraft[], b: AnswerKeyDraft[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => x.pattern === b[i]?.pattern && x.match_type === b[i]?.match_type);

export interface QuestionEditorProps {
  readonly questionId: string;
  /** Where the back link goes. The route supplies it, so this screen knows no routing. */
  readonly onBack?: () => void;
}

/** The question authoring screen. */
export function QuestionEditor({ questionId, onBack }: QuestionEditorProps): ReactNode {
  const client = useApi();
  const cache = useQueryClient();
  const { announce } = useAnnounce();
  const fieldId = useId();

  const query = useQuery(questionQuery(client, questionId));
  const question: AuthorQuestionView | undefined = query.data;
  const version = question?.current_version ?? null;
  const isPublished = version?.published_at !== null && version !== null;

  const [draft, setDraft] = useState<Draft>(() => draftOf(null));
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [cases, setCases] = useState<TestCaseDraft[]>([]);
  const [keys, setKeys] = useState<AnswerKeyDraft[]>([]);
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // Re-seed the form when a *different* version arrives — after a save, or after publishing,
  // which makes the next edit a new version.
  //
  // Adjusted during render rather than in an effect. React documents this as the way to reset
  // state when an input changes: it re-renders immediately with the new state instead of
  // painting the previous version's content for a frame and then replacing it. An effect would
  // also have to lie about its dependencies, because `version` is a new object every render
  // while the thing that matters is its id.
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  const loadedId = version?.id ?? null;
  if (loadedId !== seededFrom) {
    setSeededFrom(loadedId);
    setDraft(draftOf(version));
    setOptions(optionsOf(version));
    setCases(testCasesOf(version));
    setKeys(answerKeysOf(version));
    setConfirmingPublish(false);
  }

  const original = draftOf(version);
  const kind: QuestionKind | undefined = question?.kind;
  const isChoice = kind !== undefined && (CHOICE_KINDS as readonly string[]).includes(kind);
  const isCode = kind !== undefined && (CODE_KINDS as readonly string[]).includes(kind);
  const isShortAnswer = kind === 'short_answer';

  const dirty =
    Object.keys(changedScalars(original, draft)).length > 0 ||
    !sameOptions(optionsOf(version), options) ||
    !sameCases(testCasesOf(version), cases) ||
    !sameKeys(answerKeysOf(version), keys);

  /**
   * The body for a save: changed scalars, plus any collection the author touched.
   *
   * Built as a plain record rather than typed as `QuestionVersionInput`, because that type has
   * every field optional and would accept a typo as an absent field. The server parses it with
   * the real schema, which rejects an unknown key outright (docs/17 §3).
   */
  function buildBody(): Record<string, unknown> {
    const body = changedScalars(original, draft);
    if (isChoice && !sameOptions(optionsOf(version), options)) {
      body['options'] = options.map((o) => ({ body_md: o.body_md, is_correct: o.is_correct }));
    }
    if (isCode && !sameCases(testCasesOf(version), cases)) {
      body['test_cases'] = cases.map((c) => ({
        label: c.label === '' ? null : c.label,
        stdin: c.stdin,
        expected_stdout: c.expected_stdout === '' ? null : c.expected_stdout,
        is_sample: c.is_sample,
      }));
    }
    if (isShortAnswer && !sameKeys(answerKeysOf(version), keys)) {
      body['answer_keys'] = keys.map((k) => ({ match_type: k.match_type, pattern: k.pattern }));
    }
    return body;
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = buildBody();
      // A published version is never patched. Saving against one appends the next version,
      // which is the path ADR-003 leaves open and the reason the API answers 409 rather than
      // silently refusing.
      if (version === null || isPublished) {
        return createVersionRequest(client, questionId, body);
      }
      return updateVersionRequest(client, questionId, version.version_no, body);
    },
    onSuccess: async (written) => {
      await cache.invalidateQueries({ queryKey: ['question', questionId] });
      const message =
        version !== null && isPublished
          ? `Saved as version ${String(written.version_no)}. Version ${String(version.version_no)} is unchanged.`
          : `Saved version ${String(written.version_no)}.`;
      setSaved(message);
      announce(message);
    },
  });

  const sendForReview = useMutation({
    mutationFn: () => patchQuestionRequest(client, questionId, { status: 'review' }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['question', questionId] });
      const message = 'Sent for review. It can be published once somebody has looked at it.';
      setSaved(message);
      announce(message);
    },
  });

  const publish = useMutation({
    mutationFn: () => {
      if (version === null) throw new Error('Nothing to publish.');
      return publishVersionRequest(client, questionId, version.version_no);
    },
    onSuccess: async (published) => {
      await cache.invalidateQueries({ queryKey: ['question', questionId] });
      const message = `Version ${String(published.version_no)} is published. Its content can no longer change.`;
      setSaved(message);
      announce(message);
    },
  });

  if (query.isPending) {
    return (
      <div className="ab-screen">
        <Skeleton height="1.75rem" width="18rem" />
        <Skeleton height="1rem" width="26rem" />
        <Skeleton height="14rem" />
      </div>
    );
  }

  if (query.isError || question === undefined) {
    return (
      <div className="ab-screen">
        <Alert tone="danger" title="This question could not be loaded" live="assertive">
          <p>{toDisplayEnvelope(query.error).error.message}</p>
        </Alert>
        {onBack === undefined ? null : (
          <p>
            <Button onClick={onBack}>Back to questions</Button>
          </p>
        )}
      </div>
    );
  }

  const busy = save.isPending || publish.isPending || sendForReview.isPending;
  const mutationError = save.error ?? publish.error ?? sendForReview.error;

  return (
    <div className="ab-screen">
      <header className="ab-screen__header">
        <div className="ab-screen__heading-block">
          {onBack === undefined ? null : (
            <button type="button" className="ab-back" onClick={onBack}>
              ← Questions
            </button>
          )}
          <h1 className="ab-screen__title" id="page-heading" tabIndex={-1}>
            {excerpt(draft.prompt_md, 80)}
          </h1>
          <p className="ab-editor__facts">
            <Badge tone={STATUS_TONES[question.status]} label="Status">
              {STATUS_LABELS[question.status]}
            </Badge>
            <span>{KIND_LABELS[question.kind]}</span>
            {version === null ? (
              <span>No version yet</span>
            ) : (
              <span>
                Version {version.version_no}
                {isPublished ? ' · published' : ' · draft'}
              </span>
            )}
          </p>
        </div>

        <div className="ab-screen__actions">
          <Button
            onClick={() => {
              save.mutate();
            }}
            busy={save.isPending}
            disabled={!dirty || busy}
          >
            {isPublished ? 'Save as new version' : 'Save'}
          </Button>
          {/* The lifecycle, as the state machine actually allows it: a draft is sent for
              review, and only a question in review may be published (docs/03 §4). Offering
              "Publish" on a draft would be offering an action the API refuses. */}
          {version === null || isPublished ? null : question.status === 'draft' ? (
            <Button
              onClick={() => {
                sendForReview.mutate();
              }}
              busy={sendForReview.isPending}
              disabled={busy || dirty}
            >
              Send for review
            </Button>
          ) : question.status === 'review' ? (
            <Button
              tone="primary"
              onClick={() => {
                setConfirmingPublish(true);
              }}
              disabled={busy || dirty}
            >
              Publish…
            </Button>
          ) : null}
        </div>
      </header>

      {/* ADR-003, said before it is enforced. */}
      {isPublished ? (
        <Alert tone="info" title={`Version ${String(version.version_no)} is published and frozen`}>
          <p>
            Its content cannot change — an attempt graded against it has to stay explainable.
            Editing below writes a new version; this one stays exactly as it was served.
          </p>
        </Alert>
      ) : null}

      {confirmingPublish && version !== null ? (
        <Alert
          tone="warning"
          title={`Publish version ${String(version.version_no)}?`}
          live="polite"
        >
          <p>
            Candidates can be served this version, and its content can never change. To alter it
            afterwards you write a new version; this one stays as published.
          </p>
          <p className="ab-editor__confirm-actions">
            <Button
              tone="primary"
              busy={publish.isPending}
              onClick={() => {
                publish.mutate();
              }}
            >
              Publish version {version.version_no}
            </Button>
            <Button
              onClick={() => {
                setConfirmingPublish(false);
              }}
            >
              Keep editing
            </Button>
          </p>
        </Alert>
      ) : null}

      {mutationError !== null && mutationError !== undefined ? (
        <Alert tone="danger" title="That did not save" live="assertive">
          <p>{toDisplayEnvelope(mutationError).error.message}</p>
        </Alert>
      ) : null}

      {/* Never an optimistic tick: the message appears when the server has written it. */}
      {saved !== null && !dirty ? (
        <Alert tone="success" title="Saved" live="polite">
          <p>{saved}</p>
        </Alert>
      ) : null}

      <div className="ab-editor">
        <div className="ab-editor__main">
          <Field
            label="Prompt"
            id={`${fieldId}-prompt`}
            description="Markdown. This is what the candidate reads."
            required
          >
            {(control) => (
              <textarea
                {...control}
                className="ab-input ab-textarea ab-editor__prompt"
                rows={10}
                readOnly={isPublished}
                value={draft.prompt_md}
                onChange={(e) => {
                  setDraft({ ...draft, prompt_md: e.currentTarget.value });
                }}
              />
            )}
          </Field>

          <Field
            label="Explanation"
            id={`${fieldId}-explanation`}
            description="Shown to staff, and to a candidate only after review is permitted. Never during an attempt."
          >
            {(control) => (
              <textarea
                {...control}
                className="ab-input ab-textarea"
                rows={4}
                readOnly={isPublished}
                value={draft.explanation_md}
                onChange={(e) => {
                  setDraft({ ...draft, explanation_md: e.currentTarget.value });
                }}
              />
            )}
          </Field>

          {isChoice ? (
            <OptionsEditor
              options={options}
              readOnly={isPublished}
              single={kind !== 'mcq_multi'}
              onChange={setOptions}
            />
          ) : null}

          {isCode ? <CasesEditor cases={cases} readOnly={isPublished} onChange={setCases} /> : null}

          {isShortAnswer ? (
            <KeysEditor keys={keys} readOnly={isPublished} onChange={setKeys} />
          ) : null}
        </div>

        <aside className="ab-editor__side" aria-label="Question settings">
          <Field label="Difficulty" id={`${fieldId}-difficulty`}>
            {(control) => (
              <Select
                {...control}
                disabled={isPublished}
                value={String(draft.difficulty)}
                onChange={(e) => {
                  setDraft({ ...draft, difficulty: Number(e.currentTarget.value) });
                }}
              >
                {DIFFICULTIES.map((level) => (
                  <option key={level} value={level}>
                    {DIFFICULTY_LABELS[level] ?? String(level)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label="Expected time"
            id={`${fieldId}-seconds`}
            description="Seconds. Used to compose an assessment that fits its window."
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                readOnly={isPublished}
                value={String(draft.est_seconds)}
                onChange={(e) => {
                  setDraft({ ...draft, est_seconds: Number(e.currentTarget.value) });
                }}
              />
            )}
          </Field>

          <Field label="Maximum score" id={`${fieldId}-score`} description="At most two decimals.">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={0}
                step={0.01}
                readOnly={isPublished}
                value={String(draft.max_score)}
                onChange={(e) => {
                  setDraft({ ...draft, max_score: Number(e.currentTarget.value) });
                }}
              />
            )}
          </Field>

          {question.source_license === null ? null : (
            <div className="ab-editor__provenance">
              <h2>Provenance</h2>
              <p>
                {question.external_ref ?? 'Imported'} · {question.source_license}
              </p>
              <p className="ab-editor__note">
                Imported content keeps its licence. Credit is preserved in every export (docs/05
                §2).
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The MCQ option editor. */
function OptionsEditor({
  options,
  readOnly,
  single,
  onChange,
}: {
  options: OptionDraft[];
  readOnly: boolean;
  single: boolean;
  onChange: (next: OptionDraft[]) => void;
}): ReactNode {
  const name = useId();

  return (
    <section className="ab-editor__block" aria-labelledby={`${name}-heading`}>
      <h2 className="ab-editor__block-heading" id={`${name}-heading`}>
        Options
      </h2>
      <p className="ab-editor__block-note">
        {single
          ? 'Exactly one option is correct. Publishing is refused until one is marked.'
          : 'At least one option is correct. Publishing is refused until one is marked.'}
      </p>

      {options.length === 0 ? (
        <EmptyState reason="empty" title="No options yet">
          A choice question needs at least two options before it can be published.
        </EmptyState>
      ) : (
        <ul className="ab-rows">
          {options.map((option, index) => (
            <li className="ab-row" key={option.key}>
              {/* A radio for single-answer, a checkbox for multi: the control says how many
                  answers are expected without a sentence explaining it. */}
              <label className="ab-row__mark">
                <input
                  type={single ? 'radio' : 'checkbox'}
                  name={single ? `${name}-correct` : undefined}
                  checked={option.is_correct}
                  disabled={readOnly}
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    onChange(
                      options.map((o, i) =>
                        i === index
                          ? { ...o, is_correct: checked }
                          : single
                            ? { ...o, is_correct: false }
                            : o,
                      ),
                    );
                  }}
                />
                <span>Correct</span>
              </label>

              <label className="ab-row__body">
                <span className="ab-visually-hidden">Option {index + 1}</span>
                <input
                  className="ab-input"
                  value={option.body_md}
                  readOnly={readOnly}
                  placeholder={`Option ${String(index + 1)}`}
                  onChange={(e) => {
                    const body = e.currentTarget.value;
                    onChange(options.map((o, i) => (i === index ? { ...o, body_md: body } : o)));
                  }}
                />
              </label>

              {readOnly ? null : (
                <Button
                  tone="danger"
                  onClick={() => {
                    onChange(options.filter((_, i) => i !== index));
                  }}
                >
                  <span className="ab-visually-hidden">Remove option {index + 1}</span>
                  <span aria-hidden>Remove</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <Button
          onClick={() => {
            onChange([...options, { key: newKey(), body_md: '', is_correct: false }]);
          }}
        >
          Add option
        </Button>
      )}
    </section>
  );
}

/** The test-case editor for coding and SQL questions. */
function CasesEditor({
  cases,
  readOnly,
  onChange,
}: {
  cases: TestCaseDraft[];
  readOnly: boolean;
  onChange: (next: TestCaseDraft[]) => void;
}): ReactNode {
  const name = useId();
  const hidden = cases.filter((c) => !c.is_sample).length;

  return (
    <section className="ab-editor__block" aria-labelledby={`${name}-heading`}>
      <h2 className="ab-editor__block-heading" id={`${name}-heading`}>
        Test cases
      </h2>
      <p className="ab-editor__block-note">
        A sample case is shown to the candidate; a hidden one is not. Publishing needs at least one
        hidden case — a question graded only on cases the candidate can read is passed by printing
        the expected output.
      </p>

      {cases.length === 0 ? (
        <EmptyState reason="empty" title="No test cases yet">
          Add the cases this question is graded on. At least one must be hidden.
        </EmptyState>
      ) : (
        <>
          <p className="ab-editor__count">
            {cases.length} case{cases.length === 1 ? '' : 's'}, {hidden} hidden
          </p>
          <ul className="ab-rows">
            {cases.map((testCase, index) => (
              <li className="ab-row ab-row--stacked" key={testCase.key}>
                <div className="ab-row__head">
                  <label className="ab-row__mark">
                    <input
                      type="checkbox"
                      checked={!testCase.is_sample}
                      disabled={readOnly}
                      onChange={(e) => {
                        const isHidden = e.currentTarget.checked;
                        onChange(
                          cases.map((c, i) => (i === index ? { ...c, is_sample: !isHidden } : c)),
                        );
                      }}
                    />
                    <span>Hidden</span>
                  </label>
                  <label className="ab-row__body">
                    <span className="ab-visually-hidden">Label for case {index + 1}</span>
                    <input
                      className="ab-input"
                      value={testCase.label}
                      readOnly={readOnly}
                      placeholder={`Case ${String(index + 1)} label`}
                      onChange={(e) => {
                        const label = e.currentTarget.value;
                        onChange(cases.map((c, i) => (i === index ? { ...c, label } : c)));
                      }}
                    />
                  </label>
                  {readOnly ? null : (
                    <Button
                      tone="danger"
                      onClick={() => {
                        onChange(cases.filter((_, i) => i !== index));
                      }}
                    >
                      <span className="ab-visually-hidden">Remove case {index + 1}</span>
                      <span aria-hidden>Remove</span>
                    </Button>
                  )}
                </div>
                <div className="ab-row__pair">
                  <label className="ab-row__io">
                    <span>Input</span>
                    <textarea
                      className="ab-input ab-textarea ab-mono"
                      rows={2}
                      value={testCase.stdin}
                      readOnly={readOnly}
                      onChange={(e) => {
                        const stdin = e.currentTarget.value;
                        onChange(cases.map((c, i) => (i === index ? { ...c, stdin } : c)));
                      }}
                    />
                  </label>
                  <label className="ab-row__io">
                    <span>Expected output</span>
                    <textarea
                      className="ab-input ab-textarea ab-mono"
                      rows={2}
                      value={testCase.expected_stdout}
                      readOnly={readOnly}
                      onChange={(e) => {
                        const expected = e.currentTarget.value;
                        onChange(
                          cases.map((c, i) =>
                            i === index ? { ...c, expected_stdout: expected } : c,
                          ),
                        );
                      }}
                    />
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {readOnly ? null : (
        <Button
          onClick={() => {
            onChange([
              ...cases,
              { key: newKey(), label: '', stdin: '', expected_stdout: '', is_sample: false },
            ]);
          }}
        >
          Add test case
        </Button>
      )}
    </section>
  );
}

const MATCH_LABELS: Readonly<Record<AnswerKeyDraft['match_type'], string>> = {
  exact: 'Exact',
  ci: 'Ignoring case',
  regex: 'Regular expression',
  numeric_tolerance: 'Number within tolerance',
};

/** The short-answer key editor. */
function KeysEditor({
  keys,
  readOnly,
  onChange,
}: {
  keys: AnswerKeyDraft[];
  readOnly: boolean;
  onChange: (next: AnswerKeyDraft[]) => void;
}): ReactNode {
  const name = useId();

  return (
    <section className="ab-editor__block" aria-labelledby={`${name}-heading`}>
      <h2 className="ab-editor__block-heading" id={`${name}-heading`}>
        Accepted answers
      </h2>
      <p className="ab-editor__block-note">Tried in order. Publishing needs at least one.</p>

      {keys.length === 0 ? (
        <EmptyState reason="empty" title="No accepted answers yet">
          A short-answer question is graded against these, so it cannot be published without one.
        </EmptyState>
      ) : (
        <ul className="ab-rows">
          {keys.map((key, index) => (
            <li className="ab-row" key={key.key}>
              <label className="ab-row__match">
                <span className="ab-visually-hidden">Match type for answer {index + 1}</span>
                <select
                  className="ab-select"
                  value={key.match_type}
                  disabled={readOnly}
                  onChange={(e) => {
                    const matchType = e.currentTarget.value as AnswerKeyDraft['match_type'];
                    onChange(
                      keys.map((k, i) => (i === index ? { ...k, match_type: matchType } : k)),
                    );
                  }}
                >
                  {(Object.keys(MATCH_LABELS) as AnswerKeyDraft['match_type'][]).map((m) => (
                    <option key={m} value={m}>
                      {MATCH_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ab-row__body">
                <span className="ab-visually-hidden">Answer {index + 1}</span>
                <input
                  className="ab-input ab-mono"
                  value={key.pattern}
                  readOnly={readOnly}
                  onChange={(e) => {
                    const pattern = e.currentTarget.value;
                    onChange(keys.map((k, i) => (i === index ? { ...k, pattern } : k)));
                  }}
                />
              </label>
              {readOnly ? null : (
                <Button
                  tone="danger"
                  onClick={() => {
                    onChange(keys.filter((_, i) => i !== index));
                  }}
                >
                  <span className="ab-visually-hidden">Remove answer {index + 1}</span>
                  <span aria-hidden>Remove</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <Button
          onClick={() => {
            onChange([...keys, { key: newKey(), match_type: 'exact', pattern: '' }]);
          }}
        >
          Add accepted answer
        </Button>
      )}
    </section>
  );
}
