# Candidate AI usage policy

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-17
**Companion docs:** [`01-PRD.md`](01-PRD.md) · [`03-API-spec.md`](03-API-spec.md) · [`04-ADRs.md`](04-ADRs.md) · [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md) · [`10-certification-and-credentials.md`](10-certification-and-credentials.md) · [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md) · [`15-accessibility-conformance.md`](15-accessibility-conformance.md) · [`hiring_platform_schema.sql`](hiring_platform_schema.sql)

---

## 1. The decision

PRD §11 open question 1: "Do we allow AI assistants in coding rounds? Candidates will use them regardless."

This is the most consequential open question in the product, because the answer determines what our scores mean. A score from a round where AI was silently available and a score from a round where it was not are different measurements wearing the same number. Leaving it configurable with no default and no reasoning pushes the decision onto whichever recruiter builds the assessment, which is how you end up unable to compare two candidates in the same funnel.

**The policy is per round type, because the round types measure different things.**

| Round type | Policy | One-line reason |
|---|---|---|
| Proctored certification (M4) | **Blocked**, best-effort detection, signals advisory only | The credential asserts unaided competence; if assistance is allowed the credential is a lie |
| Live interview (M3) | **Allowed and observed**, with the prompting recorded as evidence | Prompting is now part of the job, and a live round can actually see how someone does it |
| Async screening (M1, M2) | **Configurable per assessment**, default `allowed_declared` | We cannot enforce a ban we cannot observe; the honest move is to permit, ask, and design questions AI does not trivially solve |
| Take-home / project rounds | **Allowed and declared** | Same reasoning as async, more so |

Three principles cut across all of them:

1. **An AI-use signal is never a rejection reason.** This is ADR-007's logic applied to a new signal class. See §4.
2. **Candidates are told the policy for the round before they start, in plain language.** See §6.
3. **The real defence is question design, not detection.** See §7.

This document is repo canon. If it is later promoted to an architecture decision record it belongs in [`04-ADRs.md`](04-ADRs.md) alongside ADR-007 and ADR-011, whose constraints it extends rather than modifies.

---

## 2. What each round is actually measuring

The policy follows from the measurement, so state the measurement first.

**Proctored certification** measures what a person can do with their own knowledge, under time pressure, without help. That is a narrow thing to measure and it is not the same as job performance — but it is exactly what a certification credential claims, and [`10-certification-and-credentials.md`](10-certification-and-credentials.md) prints the assurance profile on the credential's face. If assistance were permitted, the credential would be asserting something it had not observed. The value of a certification rests entirely on the conditions being what they say they are.

**A live interview** measures how someone works: how they decompose a problem, where they go when they are stuck, what they check, what they discard, how they explain a decision. An interviewer watching a candidate use an assistant well learns more than one watching a candidate type a memorised solution. Banning assistants in a live round measures a workflow nobody uses on the job and hides the skill that increasingly separates engineers — knowing what to ask for, and recognising when the answer is wrong. It is also the one round where observation is genuinely possible, because a human is watching.

**Async screening** measures whether someone is worth an interviewer's next hour. It runs unsupervised on the candidate's own machine. We cannot see their second monitor, their phone, or their terminal. A ban here is a rule enforced by the honesty of people under competitive pressure to get a job, and it disadvantages exactly the candidates who follow rules. So the policy must be one we can actually mean: permitted, declared, and — the load-bearing part — asked about questions that assistance does not trivially answer.

---

## 3. Policy by round type

### 3.1 Proctored certification — blocked

**Rule.** AI assistants are not permitted. The candidate is told this before starting and confirms it as part of the exam agreement.

**Controls.** Safe Exam Browser lockdown restricts the application environment (per PRD M4). Browser-signal proctoring records focus loss, paste, fullscreen exit and devtools per the existing `proctor_events` types. Where webcam capture is enabled with recorded consent, a second screen or a phone in frame is a signal.

**What these controls are.** A raised cost, not a wall. A candidate with a second device that our software cannot see is outside the control surface entirely, and anyone claiming otherwise is selling something. Lockdown means the candidate must work to circumvent it; it does not mean they cannot.

**What happens when a signal fires.** It joins the integrity review queue with the triggering evidence attached (FR-24), a human looks at it, and the human decides. The system does not down-score, does not void, does not withhold the credential automatically. Declining to issue a credential is available to the approver as a human decision with a recorded reason ([`10-certification-and-credentials.md`](10-certification-and-credentials.md) §5.1), and that is the only route by which an AI-use suspicion can affect an outcome.

**On the credential.** `assurance_profile.ai_policy = "blocked"` and the limitation statement makes clear the system observed conditions, not compliance.

### 3.2 Live interview — allowed and observed

**Rule.** Assistants are permitted unless the interviewer states otherwise for a specific exercise. The candidate is asked, with consent, to work where the interviewer can see the interaction — typically by sharing the window or pasting prompts into the session — and is told that the interaction is part of the evidence.

**Why.** An interviewer sitting with a candidate can evaluate the use of a tool in a way no automated system can. The question stops being "did you use it" and becomes "how did you use it": what did you ask for, did you read the output, did you notice the off-by-one, did you know when to stop asking and start thinking. Those are observable behaviours with real variance between candidates, and they are the behaviours the job now contains.

**Consent is required and refusal is free.** Recording a prompt stream is recording the candidate's own activity, potentially including a third-party account and content they did not intend to share. A candidate may decline to share prompts and still take the interview; the interviewer evaluates the code and the conversation as they always did. Declining is not a data point and must not appear anywhere in the scorecard. A consent that costs you the round is not consent — the same reasoning the licensing doc applies to webcam capture (§3, GDPR).

**Scored differently.** See §8.

### 3.3 Async screening — configurable, default allowed and declared

**Rule.** `assessments.ai_policy` defaults to `allowed_declared`. The candidate is told assistance is permitted and asked, at submit, to declare what they used. Declaring is never penalised; the declaration is shown to the reviewer as context and is never an input to the score.

**Why not blocked.** Because we would be unable to tell, and a rule we cannot observe is a rule that selects for willingness to break rules. Because the alternative — a ban plus aggressive detection — produces false positives against real people whose only crime is typing fast or pasting from their own notes (§5). And because a screening round's purpose is to decide whether to spend an interviewer's hour, which an AI-assisted candidate can still fail if the question is any good.

**Why configurable anyway.** Some organisations have a certification-adjacent screening step, a regulated role, or a campus drive with its own rules. Blocking is available per assessment and per section. What is not available is blocking without telling the candidate.

**The obligation that comes with allowing.** If a round permits assistance, its questions must be worth asking under that condition. See §7. An `allowed` policy on a bank of imported MBPP problems is not a policy; it is a free pass, and [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md) §2 measures MBPP contamination above 60% against public sources.

### 3.4 The four policy values

| Value | Candidate is told | We record | Typical use |
|---|---|---|---|
| `blocked` | Not permitted | Advisory signals, reviewed by a human | Certification (M4) |
| `allowed_declared` | Permitted; declare at submit | The declaration | Async screening default |
| `allowed_observed` | Permitted; the interaction is recorded as evidence | Prompt stream with consent | Live interviews |
| `allowed_unobserved` | Permitted; nothing recorded | Nothing | Take-homes where recording is disproportionate |

A section may narrow the assessment's policy (a system-design section marked `blocked` inside an otherwise permissive test) but the candidate must be shown the narrower policy at the section boundary, not buried in a preamble read forty minutes earlier.

---

## 4. Detection is fragile, and a detection signal is never a decision

### 4.1 The rule

**AI-use signals are advisory. The system computes no AI-use verdict, assigns no AI-likelihood score to a candidate, and never rejects, voids, or down-scores on the basis of one.** Signals surface to a human with the specific evidence attached. A human decides, records a reason, and is audited.

This is ADR-007, restated for a signal class ADR-007 did not anticipate. The reasoning transfers exactly:

- The signals are weak and their error rates are unmeasured in our population.
- The errors are not randomly distributed; they concentrate on identifiable groups (§5.3).
- The output is an employment decision, which is a regulated high-risk category (EU AI Act Annex III; [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md) §3).
- A confident-looking number computed from weak evidence is more dangerous than the weak evidence, because it launders uncertainty into authority.

A practical consequence: **there is no "AI probability" field anywhere in the schema, and there never will be.** Not on `attempts`, not on `proctor_events`, not in a report. The moment such a field exists, someone sorts by it, and the sort becomes the decision regardless of what the policy document says. Storing the raw signals and refusing to aggregate them into a score is the control.

### 4.2 Why detection is fragile

Detection of AI-generated code has no reliable ground truth. The academic literature on AI text detection has repeatedly found that detectors perform near chance on adversarial inputs and materially worse on non-native English writing; code is harder still, because idiomatic solutions to standard problems converge. Two honest candidates and one model will write the same twelve-line binary search.

Every evasion is trivial: retype instead of paste, ask for an explanation and write the code yourself, use a second device the browser cannot see. The people who evade are the people who intended to; the people who trip the detector are disproportionately the people who did nothing wrong. A detector that is easy to beat and hard to be innocent under is worse than no detector, because it produces the appearance of rigour while selecting on the wrong axis.

Detection is worth building anyway, in exactly one form: as evidence attached to a human review in rounds where assistance is prohibited and stakes are high. That is the M4 use, and it is the only one.

---

## 5. The signals we actually have

### 5.1 Inventory

These are the signals available from a browser without installing anything on the candidate's machine — PRD G2 forbids a download, and that constraint is not negotiable for a screening round. Safe Exam Browser in M4 adds environment restriction, not new signals.

| Signal | Source | What it might indicate |
|---|---|---|
| Paste size | `proctor_events` type `paste`, `payload.chars` | A large block arriving at once |
| Paste velocity | Interval between pastes, chars per paste | Iterative copy-in from an external tool |
| Focus loss | `tab_blur`, `fullscreen_exit` | Attention elsewhere during the round |
| Focus-loss correlation | `tab_blur` immediately followed by a large paste | The most informative composite we have |
| Input rate anomaly | Characters committed per second in the editor | Code appearing faster than a human types |
| Keystroke dynamics | Inter-key timing distribution | A change in who or what is producing the text |
| Stylistic discontinuity | Naming, comment density, error handling varying within one submission | Two authors, or one author and a tool |
| Time-to-first-keystroke | Editor telemetry | Long pause then a complete solution |

### 5.2 False-positive profile

| Signal | Fires innocently when | Strength |
|---|---|---|
| Paste size | The candidate drafted in their own editor; pasted a boilerplate class; pasted their own reusable utility; re-pasted after a browser crash | Weak on its own. A large paste is the single most common innocent event in a coding round |
| Paste velocity | Iterating between a local editor with their own tooling and our browser editor — a normal, competent workflow | Weak |
| Focus loss | Reading the problem statement in another tab, a notification, a screen reader announcing in a separate context, a parent in the room, a browser stealing focus | Weak. Extremely high base rate |
| Focus loss then large paste | The candidate looked up standard library documentation and copied a signature | Moderate. The best composite available, still not evidence of anything on its own |
| Input rate anomaly | Editor autocomplete, snippet expansion, IDE-style completions in Monaco, a screen-reader user's alternative input method, voice input, a stenographic keyboard | Weak. Our own editor generates the anomaly |
| Keystroke dynamics | See §5.3 — this one is structurally unfair | Rejected as a scored signal |
| Stylistic discontinuity | A candidate who learned two idioms; a solution written across an interruption; code adapted from their own prior work | Weak, and unquantifiable without judgement |
| Time-to-first-keystroke | Thinking. Reading. Planning on paper — a behaviour we should want | Weak, and perverse to penalise |

### 5.3 The fairness problem with keystroke dynamics

Keystroke dynamics — identifying a person, or detecting a change of person, from inter-key timing — sounds objective and is not. Its error distribution is structured along exactly the axes employment law cares about.

- **Disabled candidates.** Switch access, eye-tracking, sip-and-puff, on-screen keyboards, voice input, one-handed typing, and any screen-reader-driven workflow produce timing distributions unlike an unassisted typist's. So do tremor, arthritis and RSI. A detector trained or tuned on typical typists treats assistive technology as anomalous — and a candidate using accommodations is precisely the person we have the strongest legal and ethical obligation not to disadvantage. [`15-accessibility-conformance.md`](15-accessibility-conformance.md) and PRD §8 make WCAG 2.1 AA a hard requirement for the candidate surface; a signal that penalises assistive technology defeats that requirement at a deeper level than any contrast ratio.
- **Non-native speakers and non-Latin scripts.** Typing rate and rhythm in a second language differ measurably. Candidates using an input method editor for comments or identifiers produce timing patterns nothing like direct keyboard entry.
- **Hardware and environment.** Phone or tablet keyboards, unfamiliar layouts, high-latency remote desktop, poor connections, older machines.

**Decision: keystroke dynamics are not collected, not stored, and not used.** We do not log per-keystroke timing. This is a deliberate narrowing of the available signal set, on the grounds that the signal is weak, the harm is structured, and no configuration exists that makes it safe. Aggregate input-rate telemetry at the level of "characters committed in this autosave window" is retained for the anomaly signal in §5.1, which is coarse enough not to fingerprint an input method.

The same logic applies with less force to the other signals, which is why none of them is scored and why the review UI shows each one with its base rate in the cohort: "14 focus-loss events; the median for this assessment is 9." A reviewer who sees a raw count reaches for a conclusion. A reviewer who sees a count against a distribution reaches for context.

---

## 6. Candidate notice

### 6.1 The requirement

**A candidate must be shown the AI policy for a round, in plain language, before the round starts, and again at the point it matters.** Not in a linked terms document. Not in an email sent last week. On the screen, before the timer starts, as a step they acknowledge.

Where a round is `blocked` and signals are collected, the notice must also say what is collected, that a human reviews anything flagged, and that no automated decision is made. This is simultaneously a fairness commitment, a GDPR transparency obligation (Articles 13 and 14), an EU AI Act notice obligation for high-risk systems, and the substance of what NYC Local Law 144 and its equivalents require by way of candidate notice.

`attempts.ai_policy_shown_at` records that the notice was displayed and acknowledged. An attempt cannot transition to `in_progress` without it. That column exists so the answer to "were candidates told?" is a query, not a recollection.

Section-level narrowing requires a second notice at the section boundary.

### 6.2 Sample notice text

**Blocked (certification):**

> **AI assistants are not allowed in this exam.**
>
> Do not use ChatGPT, Copilot, Claude, Gemini or any similar tool, on this device or any other, during this exam.
>
> While you are taking it, we record when the exam window loses focus, when you paste text, and how much you paste. If anything looks unusual, a person from the hiring team reviews it together with your work. No automated system decides anything about your result. You will be told if your exam is reviewed, and you can respond.
>
> We do not record your keystrokes.

**Allowed and observed (live interview):**

> **You may use AI assistants in this interview.**
>
> Using one will not count against you. We are interested in how you work, which includes how you use the tools you would use on the job.
>
> If you use an assistant, we would like to see the interaction — share the window or paste your prompts into the session. With your permission we keep a record of those prompts as part of the interview notes, kept for {retention} and visible only to the hiring team.
>
> You can decline. If you decline we will not record the prompts and you can still use the assistant. Declining is not recorded and will not affect your evaluation.

**Allowed and declared (async screening):**

> **You may use AI assistants in this assessment.**
>
> When you submit, we will ask which tools you used. Answer honestly — telling us will not count against you, and there is no penalty for using them.
>
> These questions are written on the assumption that you might. We are interested in how you get to a working answer and whether you can tell when an answer is wrong.

Notice text is per-organisation and translatable; the strings live in the localisation catalogue described in [`08-i18n-and-localisation.md`](08-i18n-and-localisation.md). The default English text above is the reference and the fallback. Any organisation editing it is editing a compliance artefact, which is why the edit requires `org.admin` and is audited.

---

## 7. The assessment-design response

This is the real answer. Everything above manages a risk; this section removes it.

### 7.1 Contamination makes public datasets worthless here

[`05-licensing-and-compliance.md`](05-licensing-and-compliance.md) §2 states the position: every dataset we can legitimately import — HumanEval, MBPP, CodeContests, LBPP, Exercism — was built to benchmark language models and is therefore in the training data of the models a candidate would use. MBPP contamination is measured above 60% against public sources. The consequences it draws are exactly the consequences here:

- Imported content is fine for entry-level screening, where the goal is filtering out people who cannot program at all.
- It is close to worthless against an AI-assisted candidate.
- Anything above junior level needs questions written in-house.

PRD §10 sets the target: at least 150 in-house questions by month 6, imported content a minority of the published bank. That target is the AI policy's implementation, more than any detection work.

### 7.2 What an AI-resistant question looks like

Not "harder". A harder textbook algorithm is a better-known textbook algorithm. The properties that matter:

| Property | Why it works | Example shape |
|---|---|---|
| **Contextual** | The model has no access to your context | "Here is a 300-line module from our billing service. It double-charges on retry. Find it and fix it without changing the public interface." |
| **Requires reading code, not producing it** | Comprehension over a specific artefact does not transfer from training data | "Explain what this function does under concurrent access, then say which of these three call sites is unsafe." |
| **Under-specified on purpose** | The candidate must decide what to ask; a model will confidently pick for them | "Build a rate limiter for this endpoint" with constraints discoverable only by asking, in a live round |
| **Requires judgement between valid options** | There is no single right answer to have memorised | "Two schema designs are given. Pick one for this access pattern and defend the trade-off." |
| **Carries a deliberate wrong turn** | Models follow a plausible path; noticing the trap is the signal | A problem statement whose obvious reading gives an O(n²) solution that times out at the stated input size |
| **Verification-oriented** | Checking output is the skill an AI-assisted engineer needs most | "This implementation passes 8 of 10 tests. Write the two tests that would have caught the bug." |

Note how many of these are *easier to write than a novel algorithm problem* and require no puzzle-design talent. A senior engineer can produce a contextual debugging question from a real incident in twenty minutes. That is the authoring flow M0 should optimise for, because it is the flow that produces questions worth asking in 2027.

### 7.3 Measuring it: the AI baseline run

Add a periodic, offline calibration of the bank. For each published coding question, run a current frontier model against the question as served, unaided, and record whether it passes the hidden test cases. Store the result on the question version.

This tells authors which questions have become free points. A question a model solves first try at difficulty 4 is mislabelled, and it is the question most likely to be silently doing nothing in your screening funnel.

**This does not conflict with ADR-011.** ADR-011 forbids AI in the scoring and decision path. The baseline run touches no candidate, no attempt and no submission; it consumes a question and produces a property of that question, reviewed by a human author who decides what to do about it. It is question-bank maintenance, in the same category as the p-value and discrimination statistics FR-5 requires — computed since 2026-09-17 by `computeItemStatistics` in `packages/grading`: descriptive statistics over recorded scores, which rank questions for an author to review and feed nothing back into any candidate's outcome. The boundary that matters — no AI anywhere near a candidate's score — is untouched, and the schema enforces it by giving the baseline result no path to `attempts` or `answers`.

Cadence: quarterly, and on any new model release the question-bank owner judges material. Owner: question bank owner. First run: after the bank passes 200 published questions, expected 2027-02-26.

---

## 8. Scoring an AI-allowed round

If assistance is permitted, the scorecard must say what good use of it looks like. Otherwise interviewers apply private, inconsistent standards — which is the problem structured scorecards exist to solve (FR-22).

Add a scorecard template, `Tool-assisted engineering`, whose criteria carry behavioural anchors like every other criterion in the system. These are ratings by a human interviewer. Nothing here is computed.

| Criterion | 1 — Concerning | 2 — Developing | 3 — Solid | 4 — Strong |
|---|---|---|---|---|
| **Problem framing** | Pastes the raw problem statement and takes what comes back | Asks for the whole solution but adds some context | Decomposes first, asks for a specific piece with the constraints included | Asks for the part that is genuinely hard, having handled the rest, and states the constraints the tool needs |
| **Verification** | Accepts output without reading it; discovers failure from our test runner | Skims, runs the samples | Reads the output, reasons about edge cases, tests before submitting | Constructs the adversarial case that breaks the generated code and fixes it |
| **Integration** | Drops code in that does not match the surrounding style or interfaces | Adapts superficially | Adapts to the codebase's conventions and error handling | Refactors the generated code into something they would defend in review |
| **Judgement about when not to use it** | Reaches for the tool at every step, including trivial ones | Uses it broadly | Recognises where it helps and where it costs time | Explicitly declines it for the part requiring context the tool lacks, and says why |
| **Recovery from a wrong answer** | Re-prompts repeatedly with no new information | Re-prompts with slight variation | Debugs directly once the tool is stuck | Diagnoses *why* the answer was wrong, which is the most transferable signal in the round |

Two rules attach to this template:

1. **Absence of AI use is not a rating.** A candidate who solved it unaided is rated on the other criteria and this section is marked not applicable. It is not a zero, and the template must make "not applicable" a first-class selection rather than a low score by omission.
2. **The prompt record is evidence for the interviewer, not an input to a computed score.** It appears in the scorecard UI beside the criteria. No aggregation, no derived metric, no "prompt quality score". ADR-011 and §4.1 both apply.

---

## 9. Recording the prompt stream

### 9.1 What we can honestly capture

An important limitation, stated before the mechanism: **we cannot capture a candidate's prompts to a tool running outside our surface.** If the candidate has ChatGPT open in another tab or on their phone, the browser gives us nothing but focus loss. Any claim to record "the prompt stream" must say which of these it means:

| Mechanism | Fidelity | Availability | Cost |
|---|---|---|---|
| Candidate pastes prompts into the session, voluntarily | Partial, self-curated | M3 | None. This is the M3 v1 mechanism |
| Screen share via LiveKit, with consent | High for what is on screen; not machine-readable | M3 | Storage, retention, consent |
| Paste provenance and timing in our editor | Indirect — sizes and intervals, no content | M2 | Already built for proctoring |
| A hosted assistant pane inside our editor | Complete and structured | Post-M4, not committed | An LLM provider dependency, an AI Act assessment, a processor agreement, and a per-round cost |
| Browser extension | High | Rejected | PRD G2: no install for candidates |

**M3 ships the first three.** The fourth is evaluated after M4 and is the only route to a faithful, machine-readable prompt stream. It is worth stating plainly that hosting an assistant would mean adding an AI component to the product — permitted by ADR-011 only because it sits outside the scoring path, and only if the recording it produces stays evidence for a human rather than becoming an input to a number. If that boundary cannot be held, do not build it.

### 9.2 Consent

Recording prompts records the candidate's own composition, possibly against their personal account, possibly containing material unrelated to the interview. Consent is:

- **Specific.** Separate from assessment consent and from any proctoring consent. Covers prompt content, retention period, and who can see it.
- **Freely refusable.** Refusal has no effect on the evaluation and is not recorded as a data point. The interviewer is shown "not shared" with no further detail and no prompt to ask again.
- **Withdrawable.** Withdrawal deletes the recorded prompts and leaves the rest of the session intact.
- **Recorded.** `ai_interactions.consent_ref` points at the consent record; rows cannot be written without one.

### 9.3 Schema

To land in [`hiring_platform_schema.sql`](hiring_platform_schema.sql) as part of the M1–M3 work. Nothing below exists yet.

```sql
-- ============================================================
-- SECTION 15: CANDIDATE AI USAGE
-- Policy is declared per assessment and may be narrowed per
-- section. Everything recorded here is evidence for a human.
-- There is deliberately no aggregate "AI likelihood" anywhere.
-- ============================================================

CREATE TYPE ai_policy AS ENUM (
    'blocked',              -- not permitted; advisory signals collected
    'allowed_declared',     -- permitted; candidate declares at submit
    'allowed_observed',     -- permitted; interaction recorded with consent
    'allowed_unobserved'    -- permitted; nothing recorded
);

ALTER TABLE assessments
    ADD COLUMN ai_policy ai_policy NOT NULL DEFAULT 'allowed_declared',
    ADD COLUMN ai_policy_notice_key text;      -- localisation key for the notice shown

ALTER TABLE assessment_sections
    ADD COLUMN ai_policy ai_policy;            -- null = inherit from the assessment

ALTER TABLE attempts
    ADD COLUMN ai_policy_shown_at timestamptz, -- notice displayed and acknowledged
    ADD COLUMN ai_declaration jsonb;           -- {used: bool, tools: [], note: text}

ALTER TABLE interview_sessions
    ADD COLUMN ai_policy ai_policy NOT NULL DEFAULT 'allowed_observed',
    ADD COLUMN ai_consent_at timestamptz;      -- null = candidate did not consent to recording

-- The prompt record. Attached to exactly one attempt or one session.
-- Never written without a consent reference.
CREATE TABLE ai_interactions (
    id              bigserial PRIMARY KEY,
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    attempt_id      uuid REFERENCES attempts(id) ON DELETE CASCADE,
    session_id      uuid REFERENCES interview_sessions(id) ON DELETE CASCADE,
    at              timestamptz NOT NULL DEFAULT now(),
    origin          text NOT NULL,          -- 'candidate_pasted' | 'screen_share_note' | 'hosted_pane'
    tool_label      text,                   -- free text as the candidate named it
    prompt_text     text,                   -- null when only a digest was retained
    response_digest text,                   -- sha256; we do not store provider output verbatim
    inserted_chars  int,                    -- how much of it reached the editor, if known
    consent_ref     uuid NOT NULL,
    delete_after    timestamptz NOT NULL,   -- enforced retention, like proctor_media
    CHECK (num_nonnulls(attempt_id, session_id) = 1)
);

CREATE INDEX ON ai_interactions (attempt_id, at);
CREATE INDEX ON ai_interactions (session_id, at);
CREATE INDEX ON ai_interactions (delete_after);

-- Question-bank calibration (section 7.3). No candidate data, no path
-- to attempts or answers, reviewed by a human author.
ALTER TABLE question_versions
    ADD COLUMN ai_baseline_solved boolean,
    ADD COLUMN ai_baseline_model text,
    ADD COLUMN ai_baseline_at timestamptz;
```

New `proctor_events.event_type` values, all advisory, all reviewed by a human: `paste_large` (payload carries `chars`), `paste_burst` (payload carries `count` and `window_ms`), `input_rate_anomaly` (payload carries `chars_per_second` and the cohort median). The existing `paste`, `tab_blur`, `fullscreen_exit` and `devtools_open` types already cover the rest. No new type carries a verdict, a score, or a threshold judgement — the threshold that decides whether an event is worth surfacing lives in the review UI's configuration, where changing it is visible.

New permission: `ai_evidence.read`, separate from `attempt.read`, because prompt content is more sensitive than a score and should not be visible to everyone who can see results.

### 9.4 Retention

| Data | Default | Why |
|---|---|---|
| `ai_interactions` prompt text | 90 days, aligned with `RETENTION_SESSION_RECORDING_DAYS` | It is part of the session record and no more durable than the rest of it |
| `ai_interactions` digests and timing | 24 months, aligned with `RETENTION_ATTEMPT_DATA_MONTHS` | Supports a dispute without retaining content |
| `attempts.ai_declaration` | With the attempt | It is part of the submission |
| Paste and focus events | With `proctor_events` | Unchanged |
| Keystroke timing | Never collected | §5.3 |

Reconcile the exact figures with [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md); the DPIA must cover prompt recording explicitly, since it is a new category of candidate-generated content. TBD - owner: DPO, decide by 2026-12-11.

---

## 10. Relationship to ADR-011

ADR-011 says: no AI in the scoring or decision path for v1, with two acceptable exceptions — question drafting assistance where a human publishes, and recording the candidate's own AI usage during live rounds as observable evidence.

**This document is about the candidate's AI use. It does not touch our own.** Nothing here proposes an AI component in scoring, ranking, summarising a candidate, or recommending a decision. Specifically:

- No model reads a candidate's code and produces a score.
- No model reads a prompt stream and rates it. §8 is a human filling in a scorecard.
- No model produces an AI-use probability. §4.1 forbids the field from existing.
- The baseline run in §7.3 evaluates *questions*, before any candidate sees them, and its output is a flag for an author.

ADR-011's second exception is precisely the M3 mechanism in §9. This document narrows it with a consent requirement and a retention ceiling that ADR-011 did not specify, and adds the constraint that the recording remains evidence rather than becoming a computed input.

If a future version wants an AI feature in the decision path, that is a new ADR, a new DPIA, and a conformity assessment — not an extension of this policy.

---

## 11. Regulatory framing

**EU AI Act.** Recruitment and candidate evaluation systems are high-risk under Annex III. Two obligations bear directly here. *Transparency*: people subject to a high-risk system must be informed — §6's notice requirement is the implementation. *Human oversight*: the system must be designed so a person can understand its output, override it, and decide not to use it — §4.1's refusal to compute a verdict is the strongest possible form of this, since there is no automated output to override. Whether our deterministic scoring falls inside the Act's definition of an AI system is a question for counsel; the licensing doc's guidance is to build as if it does, and this policy costs nothing extra under that assumption.

**GDPR.** Article 13/14 transparency is satisfied by the notice. Article 22 — the right not to be subject to solely automated decisions with legal or similarly significant effects — is satisfied structurally, because no decision is automated. Prompt recordings are personal data and candidate-authored content; they need a lawful basis, which is consent (§9.2), and a retention ceiling (§9.4). Recording is an addition to the DPIA, not a variation within it.

**NYC Local Law 144 and equivalents.** These bite on automated employment decision tools that substantially assist a decision. Our AI-use signals do not assist any decision — they are shown to a human alongside evidence. `GET /reports/adverse-impact` remains the mechanism for the four-fifths-rule check, and if an organisation ever configures a workflow where a signal effectively drives outcomes, that workflow is in scope and this policy has been violated.

**Accommodations.** A candidate using assistive technology may trip several signals in §5.1 through no fault of their own. The review UI must display any recorded accommodation on the attempt beside the signals, so a reviewer sees the explanation at the same moment as the anomaly rather than after forming a view. Accommodations are already first-class and recorded (PRD §9, `invitations.accommodations`); this is a presentation requirement on the integrity review queue, not new data.

---

## 12. Decision table

| Round type | Policy | Detection collected | Recorded evidence | Scored on tool use | Owner | Review by |
|---|---|---|---|---|---|---|
| Proctored certification (M4) | `blocked` | Paste, focus, lockdown state, webcam where consented | Integrity events, human review outcome | No | Certification programme owner | 2027-04-30 |
| Live interview (M3) | `allowed_observed` | None beyond session events | Prompt record with consent; screen share with consent | Yes — §8 scorecard, by a human | Head of Engineering | 2027-03-31 |
| Async screening, standard (M1/M2) | `allowed_declared` | Paste and focus, advisory only | Candidate declaration | No | Hiring manager council | 2027-03-31 |
| Async screening, regulated or campus role | `blocked` by configuration | Paste and focus, advisory only | Integrity events, human review | No | Hiring manager council with Legal | 2027-03-31 |
| Take-home / project | `allowed_unobserved` | None | Candidate declaration | Optionally, in the follow-up discussion | Hiring manager council | 2027-03-31 |

Review cadence: every six months from the first review date, and immediately on any of — a material shift in model capability that changes what §7.2 questions resist, a regulatory change in a jurisdiction we operate in, or the first time a reviewer asks for an AI-likelihood score, which is the signal that the policy is not understood.

---

## 13. Implementation

| Task | Milestone | Window |
|---|---|---|
| Question authoring guidance for AI-resistant questions (§7.2) in the authoring UI; in-house authoring as the default path | M0 | see ROADMAP |
| `ai_policy` on assessments and sections; notice screen with acknowledgement; `attempts.ai_policy_shown_at` gate on `in_progress` | M1 | see ROADMAP |
| Submit-time declaration UI and `attempts.ai_declaration`; reviewer context panel showing the declaration without scoring it | M1 | see ROADMAP |
| Paste size and burst telemetry on coding questions; `paste_large`, `paste_burst`, `input_rate_anomaly` events; cohort-median context in the review UI | M2 | see ROADMAP |
| Confirm no per-keystroke timing is collected anywhere; add a test asserting it (§5.3) | M2 | see ROADMAP |
| `ai_interactions` table, consent flow, prompt record UI in the interview surface; screen-share consent via LiveKit | M3 | see ROADMAP |
| `Tool-assisted engineering` scorecard template with the §8 anchors; "not applicable" as a first-class selection | M3 | see ROADMAP |
| `blocked` profile end to end in certification mode; SEB integration; signals into the integrity review queue with evidence and base rates | M4 | see ROADMAP |
| `assurance_profile.ai_policy` written onto issued credentials (`10-certification-and-credentials.md` §12.1) | M4 | see ROADMAP |
| Retention sweep for `ai_interactions.delete_after`; DPIA section on prompt recording | M4 | see ROADMAP |
| First AI baseline run over the published bank (§7.3) | Post-M4 | from 2027-02-26 |
| Evaluate a hosted assistant pane, or decide against it (§9.1) | Post-M4 | decide by 2027-04-30 |

### Open items

| Item | Owner | Decide by |
|---|---|---|
| Whether `allowed_declared` or `blocked` is the right default for campus drives specifically | Hiring manager council | 2026-10-30 |
| Retention figure for prompt text — 90 days proposed, aligned to session recordings | DPO | 2026-12-11 |
| Whether the declaration is mandatory (blocks submit) or optional; mandatory risks penalising honesty through omission | Product with Legal | 2026-10-30 |
| Model and provider for the §7.3 baseline run, and whether it can run without sending question content to a third party | Question bank owner with Engineering | 2027-02-12 |
| Counsel review of the §6.2 notice texts before any live candidate sees them | Legal | 2026-10-16 |
