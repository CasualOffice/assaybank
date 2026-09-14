# Glossary

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`../docs/hiring_platform_schema.sql`](../docs/hiring_platform_schema.sql), [`../docs/03-API-spec.md`](../docs/03-API-spec.md), [`../docs/01-PRD.md`](../docs/01-PRD.md), [`../docs/04-ADRs.md`](../docs/04-ADRs.md), [`TRACKER.md`](TRACKER.md)

---

This domain has several pairs of terms that sound interchangeable and are not. Confusing them produces real bugs — a re-grade that cannot be reproduced, a role that must be re-tagged across the whole bank, a report generated from a half-graded attempt. The pairs come first, because they are what actually cost time.

Each entry names the table or endpoint it maps to, so a term can be traced from a conversation to the schema without guessing.

---

## The terms this domain confuses

### user_role vs job_role

**`user_role`** is a permission bundle inside the product: recruiter, interviewer, admin, or a custom set an organisation defines. It grants actions. Maps to `user_roles`, `user_role_permissions`, `user_role_assignments`, and `GET /user-roles`.

**`job_role`** is a position you hire for: "SDE-2 Backend", "Data Engineer". It declares required skills with weights and difficulty bands, and drives assessment composition and scoring. Maps to `job_roles`, `job_role_skills`, and `GET /job-roles/{id}`.

They share the word "role" and nothing else. The schema warns against merging them in a comment above `job_roles` for exactly this reason. A permission never attaches to a `job_role`; a skill weight never attaches to a `user_role`.

### question vs question_version

**`question`** is identity and lifecycle: which organisation owns it, what kind it is, its status (`draft`, `review`, `published`, `retired`), where it came from, how often it has been served. It holds no content. Maps to `questions`.

**`question_version`** is content: prompt, explanation, difficulty, scores, options, test cases, answer keys. Append-only once `published_at` is set. Maps to `question_versions`, with `POST /questions/{id}/versions/{v}/publish` performing the freeze.

Attempts reference a **version**, never a question (ADR-003). This is what makes a re-grade reproducible and a dispute investigable. Editing a published question creates a new version; the previous one continues to serve the attempts that saw it. In the authoring UI the current version should feel like "the question" — the versioning is invisible during normal work and decisive during an appeal.

### assessment vs attempt

**`assessment`** is the template: sections, rules, duration, pass mark, proctoring profile. It is versioned; editing a live one creates a new version and in-flight attempts finish on the old one (FR-10). Maps to `assessments`, `assessment_sections`, and `GET /assessments/{id}`.

**`attempt`** is one candidate's single run at one version of one assessment. It has its own clock, its own materialised question set and its own score. Maps to `attempts` and the candidate-facing `GET /attempt`.

One assessment produces many attempts. An assessment has a `duration_seconds`; an attempt has a `deadline_at` computed from it at start.

### attempt vs submission vs answer

**`attempt`** — the whole run across all sections. Carries `raw_score`, `score_pct`, `passed`, `status`. One row per candidate run.

**`answer`** — the candidate's response to one served question, and the row that holds the score for it: `auto_score`, `manual_score`, `final_score`. Exactly one per `attempt_question` (enforced by a unique constraint). Maps to `answers`, written by `PATCH /attempt/answers/{aq_id}`.

**`submission`** — one execution of code against one coding or SQL question. A candidate may produce many submissions for a single answer, trial and graded; `answers.final_submission_id` points at the one that counts. Maps to `submissions` and `submission_results`.

The hierarchy is attempt → attempt_question → answer → submissions. Scores live on the answer, not the submission: a submission has a `score`, but the answer's `final_score` is what rolls up.

### section rule vs section question

**`section_question`** pins a specific question into a section, optionally at a pinned version and with a score override. Deterministic — every candidate sees it. Maps to `section_questions`, set by `PUT /sections/{id}/questions`.

**`section_rule`** describes a random draw: "5 questions, skill = python, difficulty 2–3, not seen in 90 days". Resolved once per attempt against the bank as it stands at that moment. Maps to `section_rules`, created by `POST /sections/{id}/rules`.

A section does one or the other (FR-6). Rules are what prevent question leakage across a cohort; they are also what can be infeasible, which is why `POST /assessments/{id}/simulate` must pass before an assessment can be published (ADR-004).

### run vs submit

**Run** is a trial execution against **sample cases only**. It consumes no submission budget, returns full detail for those cases, and exists so a candidate can iterate (FR-11). `POST /attempt/questions/{aq_id}/run`, written as `submissions.is_trial_run = true`, routed to the low-latency interactive queue.

**Submit** is a graded execution against **all cases, sample and hidden**. It counts against the per-question submission limit, returns filtered results, and feeds the answer's score. `POST /attempt/questions/{aq_id}/submit`, routed to the batch queue where throughput matters more than latency (ADR-008).

Both return `202` with a submission id and stream results over SSE. Mixing them is how hidden cases leak.

### sample case vs hidden case

**Sample case** — `test_cases.is_sample = true`. The candidate sees its stdin, expected output, actual output, stderr and pass/fail. It is part of the problem statement, in effect.

**Hidden case** — `is_sample = false`. The candidate sees pass/fail and the case label. Nothing else, ever, including inside stderr or compile output (FR-12).

Expectations for either kind never enter the sandbox. Comparison happens in the grading worker, so a candidate who escapes the sandbox still learns nothing about hidden cases (HLD §3.2).

### p-value vs discrimination

**p-value** — the proportion of candidates who answered a question version correctly. Ranges 0 to 1. A question at 0.95 is too easy to tell anyone apart; at 0.05 it is either too hard or broken. The useful band is 0.2–0.8. `question_stats.p_value`.

**discrimination** — the point-biserial correlation between performance on this question and total score on the attempt. Answers a different question: do strong candidates do better on it than weak ones? Target above 0.2. A question can have a perfect p-value and near-zero discrimination, which means everyone guesses — that is the signature of an ambiguous question or a leaked one. `question_stats.discrimination`.

Both are recomputed nightly and are meaningless below n = 30 (FR-5). Exposed through `GET /questions/{id}/stats` and `GET /assessments/{id}/analytics`.

### void vs expire vs finalise

**expire** — the deadline passed while the attempt was `in_progress`. Set by a scheduled sweep, never by the client. Whatever was autosaved is graded; the attempt is not discarded (ADR-006).

**finalise** — every question has a non-null `final_score` and the attempt now carries a defensible result. A single transition guarded at the database level, which is what prevents a report being generated from a half-graded attempt (HLD §4.4).

**void** — a human invalidated the attempt. Reachable from any state, requires a reason, always audited. `POST /attempts/{id}/void` (FR-25).

Expire is time. Finalise is completeness. Void is judgement. An expired attempt still finalises once grading completes; a voided one never does.

### proctoring signal vs verdict

**Signal** — an observed browser or environment event: focus loss, paste, fullscreen exit, devtools opened. Factual, timestamped, advisory. Maps to `proctor_events`, ingested by `POST /attempt/proctor-events`.

**Verdict** — a conclusion about whether a candidate cheated. **The system never computes one.** Flagged attempts enter a human review queue with the triggering evidence attached; a person decides (FR-23, FR-24, ADR-007).

`attempts.integrity_flag` (`clean`, `suspicious`, `violation`) is a review state, not an automated judgement, and nothing may write a score or status change from a signal. This is a product constraint, not a configuration option, and a release-blocking test enforces it.

### exposure

The number of times a question version has been served to a candidate. Incremented when `attempt_questions` is materialised, not when the candidate opens the question. `questions.exposure_count`, filterable through `GET /questions?exposure_gt=`.

Exposure is the leakage clock. A question served 400 times across a campus has almost certainly been shared, so the system flags it for retirement above a configurable threshold (FR-4). It is also the reason materialising the served set per attempt matters — without `attempt_questions` you cannot count exposure accurately, and you cannot detect a leaked question by correlating scores against who received it (ADR-004).

---

## Everything else

| Term | Definition | Maps to |
|---|---|---|
| **accommodation** | A recorded adjustment for a candidate, currently `extra_time_pct`, applied server-side when `deadline_at` is computed and written to the audit log. A first-class feature, not an informal favour (PRD §9). | `invitations.accommodations`, `attempts.deadline_at` |
| **adverse impact** | A selection-rate disparity between demographic groups. The four-fifths rule flags it when any group's rate falls below 80% of the highest group's. Relevant to NYC Local Law 144 and equivalents. | `GET /reports/adverse-impact` |
| **answer key** | The match specification for a short-answer question: exact, case-insensitive, regex, or numeric with tolerance. | `short_answer_keys` |
| **application** | A candidate's link to a specific job opening, with a stage. Distinct from an invitation, which links a candidate to an assessment. | `applications` |
| **attempt_question** | One row of the materialised served set: which question version, at which ordinal, with which option shuffle. Written once at attempt start and never re-rolled (ADR-004). | `attempt_questions` |
| **audit log** | Append-only record of privileged actions, separate from application logs, queryable, retained seven years. | `audit_log`, `GET /audit-log` |
| **behavioural anchor** | Text on a scorecard criterion describing what each rating level looks like in observed behaviour, so two interviewers mean the same thing by "3" (FR-22). | `scorecard_criteria` |
| **candidate** | A person being assessed. No account, no install, no plugin — access is by token or room code (G2). | `candidates` |
| **certification mode** | An assessment configuration for high-stakes exams: Safe Exam Browser lockdown, proctoring enabled, consent recorded, media retention capped. The only mode where webcam capture is available at all. | `assessments.proctoring_profile` |
| **coding spec** | The execution contract for a coding or SQL question: allowed languages, starter code, reference solutions, limits, grading mode, SQL fixture. Reference solutions never reach the client. | `coding_specs` |
| **contamination** | The presence of an imported question in the training data of publicly available models, which makes it worthless against a candidate using an assistant. Measured above 60% for MBPP. | [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md) §2 |
| **coverage** | How many published questions exist for the skills a job role requires, at the difficulty band it requires. Tells you the bank is thin before you try to hire. | `GET /job-roles/{id}/coverage` |
| **dead-letter queue** | Where a grading job goes after exhausting retries. Moves the attempt to `under_review` and alerts. Never scores zero (ADR-008, HLD §9). | BullMQ, `attempts.status` |
| **erasure** | GDPR deletion of candidate PII, hard, while retaining anonymised rows so psychometric statistics survive. | `DELETE /candidates/{id}`, `candidates.erase_after` |
| **grading mode** | How a coding submission is judged: `test_cases` (stdout comparison), `unit_tests`, or `custom_checker`. | `coding_specs.grading_mode` |
| **idempotency key** | A client-supplied header that makes a mutating request safe to retry; the original response is replayed rather than the action repeated. | `Idempotency-Key` |
| **import job** | An asynchronous bank import that reports per-row errors instead of failing the whole file. `source_license` is mandatory; a row without one is rejected (FR-3). | `POST /questions/import`, `GET /import-jobs/{id}` |
| **integrity review queue** | The human workflow where flagged attempts are examined with their triggering evidence attached. The only place an integrity conclusion is ever reached (FR-24). | `proctor_events`, `attempts.integrity_flag` |
| **invitation** | A tokenised grant of access to exactly one assessment for one candidate, with an expiry and an attempt limit. The plaintext token is returned once at creation; only its hash is stored. | `invitations` |
| **negative marking** | A score deduction for an incorrect answer, configured per question version. Optional. | `question_versions.negative_score` |
| **option_order** | The shuffle actually shown to one candidate, stored as an integer array so the presentation can be reconstructed exactly — which matters for MCQ analytics as much as for disputes. | `attempt_questions.option_order` |
| **regrade** | Re-running grading on a finalised attempt. Creates a new grading run rather than mutating in place; the audit log records both scores. | `POST /attempts/{id}/regrade` |
| **RLS** | PostgreSQL row-level security, the tenant-isolation mechanism. Policies compare `org_id` against `app.current_org`, set per connection checkout. A forgotten `WHERE` clause returns zero rows instead of another tenant's data (ADR-010). | every tenant-scoped table |
| **room code** | The short code a candidate uses to join a live interview. Grants a session, nothing else. | `interview_sessions.room_code`, `POST /join/{room_code}` |
| **scorecard** | A structured human judgement against a template's criteria, tied to a session or an attempt. Immutable once submitted, and invisible to other reviewers until all are submitted. | `scorecards`, `scorecard_ratings` |
| **section** | An ordered division of an assessment with its own kind, duration and shuffle settings. Holds either pinned questions or draw rules. | `assessment_sections` |
| **session_events** | The append-only, queryable event stream for a live interview. Exists in parallel to the Yjs document because CRDT state is an opaque binary blob; replay, analytics and audit read this, not the blob (ADR-005). | `session_events` |
| **simulate** | A dry run resolving every section rule against the current bank, returning feasibility, a sample draw and warnings. Must pass before publish. Catches "your rule asks for 10 hard Python questions and the bank has 4" before a candidate hits it mid-exam. | `POST /assessments/{id}/simulate` |
| **skill** | The tag on a question and the requirement on a job role — the join between the two. Two levels deep, org-editable, and the thing that makes adding a role a configuration change rather than a re-tagging project (ADR-009). | `skills`, `question_skills`, `job_role_skills` |
| **source_license** | The licence under which an imported question arrived: `MIT`, `CC-BY-4.0`, `proprietary` and so on. Mandatory on import, preserved in export, and the metric for tracking how much of the bank is in-house. | `questions.source_license` |
| **ticket** | A short-lived (60s), single-use credential for opening a WebSocket to the collaboration service. Separate from the session token that issued it. | `POST /sessions/{id}/ticket` |
| **webhook** | An outbound HMAC-SHA256-signed event to an ATS or other consumer, at-least-once with a 24-hour retry window. Consumers must deduplicate on `event_id`. | `POST /webhooks`, `GET /webhooks/{id}/deliveries` |
