# Product requirements — technical hiring platform

**Status:** draft
**Owner:** _tbd_
**Last updated:** 2026-09-14

---

## 1. Problem

Technical hiring teams today choose between two bad options.

Commercial platforms (HackerRank, CoderPad, CodeSignal, Mettl) work, but pricing is built for companies with hundreds of weekly interview loops. Smaller teams hit concurrency ceilings during campus drives and end up splitting candidates into batches across days. Question libraries are generic DSA sets that reward memorisation, and the vendor owns your question bank in a proprietary format you cannot export cleanly.

The alternative is a stack of disconnected tools: a Google Form for MCQs, a shared doc for the coding round, Zoom screen-share for the live interview, and a spreadsheet tracking who scored what. Nothing is auditable, questions leak because everyone gets the same five, and comparing two candidates means reading two different interviewers' free-text notes.

Neither option gives you the thing that actually matters: **a defensible, repeatable, auditable record of why you advanced or rejected each candidate**, tied to the skills the role genuinely needs.

## 2. What we are building

A self-hosted technical hiring platform covering three assessment surfaces against one shared question bank and one skill taxonomy:

| Surface | Analogue | Primary use |
|---|---|---|
| Async assessment | HackerRank Tests | First-round screening at volume |
| Live interview | CoderPad | Pair-programming and deep-dive rounds |
| Proctored exam | AWS certification | Certification, campus drives, high-stakes testing |

The shared bank is the point. A question written once is reusable across all three, carries its own version history, and accumulates statistics that tell you whether it is actually discriminating between strong and weak candidates.

## 3. Users

**Question author** (senior engineer, occasional user). Writes and reviews questions. Cares about: fast authoring, test-case editing, seeing whether a question is too easy. Will abandon the tool if authoring takes longer than writing the question in a text file.

**Recruiter / coordinator** (daily user). Builds assessments, sends invites, chases candidates, exports reports. Cares about: bulk invites, deadline management, one clear number per candidate. Not technical — must never see a YAML file.

**Interviewer** (weekly user). Runs live rounds, fills scorecards. Cares about: zero setup, the candidate joining without friction, a scorecard that takes under three minutes.

**Hiring manager** (weekly user). Compares candidates, makes the call. Cares about: side-by-side comparison, seeing *how* someone worked, not just the score.

**Candidate** (one-time user). Cares about: no account creation, no downloads, a fair test, knowing how much time is left, not losing work when wifi drops.

**Admin** (rare user). Manages users, roles, retention policy, integrations.

## 4. Goals

- **G1.** One question bank serving all three assessment surfaces, with version history.
- **G2.** Candidate experience requires no account, no install, no plugin.
- **G3.** Support 500 concurrent candidates on commodity hardware without batching.
- **G4.** Every score traceable to the exact question version, submission, and runtime that produced it.
- **G5.** Hiring decisions anchored to role-specific skills rather than generic difficulty tiers.
- **G6.** Full data export in open formats. No lock-in, including away from us.

## 5. Non-goals

- Not an ATS. We integrate with one; we do not replace it.
- Not a learning platform. No courses, no practice mode, no leaderboards.
- Not a sourcing or job-board product.
- No AI-generated hiring recommendations. The system surfaces evidence; humans decide. (See §9.)
- No mobile candidate experience for coding rounds. MCQ on mobile is acceptable; coding is not.

## 6. Scope by milestone

### M0 — Question bank (weeks 1–3)
The foundation everything else reads from.

- Question CRUD for all kinds: MCQ single/multi, true-false, short answer, coding, SQL, subjective, system design
- Immutable versioning with draft → review → published → retired lifecycle
- Skill taxonomy, job roles, and role-to-skill weighting
- Import from open datasets (HumanEval, MBPP, LBPP, Exercism) with license provenance preserved
- Bulk import/export as QTI 2.1 and JSON

**Exit criteria:** 200 questions loaded, tagged to at least 3 job roles, exportable and re-importable without loss.

### M1 — Async MCQ assessment (weeks 4–6)
- Assessment builder: sections, fixed picks, random-draw rules
- Tokenised candidate invitations with expiry and attempt limits
- Server-authoritative timer, autosave, resume after disconnect
- Auto-grading with partial credit and optional negative marking
- Per-candidate report and CSV export

**Exit criteria:** 50 candidates complete a 30-question test concurrently; scores reproduce exactly on re-grade.

### M2 — Coding rounds (weeks 7–10)
- Monaco editor with language selection and starter code
- Piston-backed execution: sample runs visible to candidate, hidden cases on submit
- Test-case weighting, time and memory limits, compile error surfacing
- Async grading queue with retry and dead-letter handling

**Exit criteria:** 100 concurrent submissions graded, p95 result latency under 8s.

### M3 — Live interviews (weeks 11–14)
- Shared editor with live cursors via Yjs, join by room code
- In-session execution, multi-file support
- Session replay from the event stream
- Structured scorecards with behavioural anchors

**Exit criteria:** an interviewer runs a full 45-minute loop and replays it afterwards.

### M4 — Proctored / certification mode (weeks 15–18)
- Lockdown integration (Safe Exam Browser) for high-stakes exams
- Browser-signal proctoring: focus loss, paste, fullscreen exit, devtools
- Integrity review queue with evidence attached
- Certificate issuance with verifiable ID

**Exit criteria:** a 90-minute certification exam runs end to end with a reviewable integrity report.

## 7. Functional requirements

### Question bank
- **FR-1.** A published question version is immutable. Edits create a new version; prior attempts continue to reference the version served.
- **FR-2.** Questions are tagged with skills, never directly with job roles. Role relevance is derived through the skill taxonomy.
- **FR-3.** Every question records its source license and external reference when imported.
- **FR-4.** The system tracks exposure count per question version and flags questions exceeding a configurable threshold for retirement.
- **FR-5.** Nightly job computes p-value (proportion correct) and discrimination (point-biserial correlation) per question version once n ≥ 30.

### Assessments
- **FR-6.** A section either pins specific questions or defines a random-draw rule (count, skills, difficulty band, recency exclusion).
- **FR-7.** The exact served question set, including option shuffle order, is persisted at attempt start and never re-rolled.
- **FR-8.** The assessment deadline is computed server-side at start. Client clocks are advisory only.
- **FR-9.** Answers autosave at most 5 seconds after the last change. A candidate who loses connection resumes with no data loss.
- **FR-10.** Assessments are versioned. Editing a live assessment creates a new version; in-flight attempts finish on the old one.

### Coding
- **FR-11.** Candidates can run code against sample cases without consuming a submission.
- **FR-12.** Hidden test-case content is never transmitted to the client, including in error output.
- **FR-13.** Every submission records language version and runtime image digest.
- **FR-14.** Grading is asynchronous. A submission is queued and the candidate may continue working.
- **FR-15.** Execution is sandboxed with enforced CPU time, wall time, memory, process count, and no network egress.

### Live interviews
- **FR-16.** A candidate joins with a room code only. No account, no download.
- **FR-17.** Editor state converges across participants without a central lock (CRDT).
- **FR-18.** The full event stream is recorded and replayable at variable speed.
- **FR-19.** Interviewers see an in-session private notes pane the candidate cannot see.

### Scoring and review
- **FR-20.** Final score = weighted sum over sections, with per-skill sub-scores derived from question-skill tags.
- **FR-21.** Manual score overrides require a reason and are written to the audit log.
- **FR-22.** Scorecard criteria carry behavioural anchors describing what each rating level looks like.

### Integrity
- **FR-23.** Proctoring signals are advisory. The system never auto-rejects a candidate.
- **FR-24.** Flagged attempts enter a review queue with the triggering evidence attached.
- **FR-25.** Voiding an attempt requires a reason and is auditable.

### Data and access
- **FR-26.** All tenant data is isolated by `org_id` at the database level (row-level security).
- **FR-27.** Permissions are checked per action, not per role name, so custom roles are possible.
- **FR-28.** Candidate data has an explicit retention clock; expiry triggers erasure.
- **FR-29.** Full export of an organisation's question bank, assessments, and results in open formats.

## 8. Non-functional requirements

| | Target |
|---|---|
| Concurrent candidates | 500 sustained, 1000 peak |
| Concurrent code executions | 100 in flight |
| API p95 latency (non-execution) | < 300 ms |
| Execution result p95 | < 8 s from submit |
| Editor sync latency | < 150 ms p95 same-region |
| Availability during an exam window | 99.9% |
| Data durability | Zero answer loss; autosave + WAL |
| Browser support | Last 2 versions Chrome, Firefox, Safari, Edge |
| Accessibility | WCAG 2.1 AA for the candidate experience |

Accessibility is not optional here. A candidate who cannot complete your assessment because of a screen-reader failure is a discrimination exposure, not a bug backlog item.

## 9. Fairness and defensibility

Assessment tooling makes employment decisions, which puts it in a regulated category in several jurisdictions. Design constraints that follow:

- **No automated rejection.** The system ranks and surfaces evidence. A human makes every advance/reject call. This is a product constraint, not a configuration option.
- **Every score is explainable.** For any candidate, you can reconstruct: which questions they saw, what they answered, which test cases failed, and which human overrode what.
- **Adverse-impact monitoring.** The reporting layer supports pass-rate breakdown by demographic group where that data is voluntarily collected, so a four-fifths-rule check is possible.
- **Accommodations are first class.** Per-candidate time extensions are a supported feature, recorded and auditable, not a hack.
- **Proctoring is proportionate.** Webcam capture is off by default and only available in certification mode with explicit consent. Biometric data carries a hard retention ceiling.

See `05-licensing-and-compliance.md` for the regulatory detail.

## 10. Success metrics

**Adoption**
- ≥ 80% of technical roles run through the platform within 2 quarters
- ≥ 150 questions authored in-house by month 6 (imported content should become the minority)

**Quality**
- ≥ 60% of published questions land in the 0.2–0.8 p-value band
- Question discrimination ≥ 0.2 for 70% of the bank
- Correlation between assessment score and 90-day manager rating — the only metric that tells you the test works

**Efficiency**
- Time from invite sent to score available: < 24 h median
- Interviewer time per loop reduced vs baseline
- Zero batching required during campus drives

**Candidate experience**
- Completion rate ≥ 85% of started attempts
- Candidate satisfaction ≥ 4/5
- Support tickets per 100 attempts < 2

## 11. Open questions

1. Do we allow AI assistants in coding rounds? Candidates will use them regardless. Options: block and detect (fragile), allow and observe how they prompt, or both depending on round. Leaning toward allowing in live rounds with the prompt stream recorded.
2. ATS integration — build a generic webhook layer first, or a direct connector to whatever we currently use?
3. Do we need multi-language question content (i18n) at launch, or is English-only acceptable for v1?
4. Certification mode: do we issue verifiable credentials (Open Badges), or is a PDF sufficient?
5. Retention default for session recordings — 90 days is the working assumption but needs legal sign-off.
