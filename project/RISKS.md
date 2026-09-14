# Risk register

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`MILESTONES.md`](MILESTONES.md), [`TRACKER.md`](TRACKER.md), [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md), [`../docs/02-HLD.md`](../docs/02-HLD.md), [`../docs/04-ADRs.md`](../docs/04-ADRs.md), [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md)

---

## How this register works

**Likelihood** and **impact** are scored 1–5. Score is the product, banded `low` 1–6, `medium` 8–12, `high` 15–25. A risk is reviewed when its milestone closes (see the milestone-completion ritual in [`MILESTONES.md`](MILESTONES.md)) and whenever its trigger fires.

The **trigger** column is the point of this document. A risk with a mitigation but no trigger is a good intention: nobody knows when to act on it. Every trigger below is something an alert, a dashboard, a query or a calendar date can surface, so the register is operable rather than decorative.

The **contingency** column is what happens when mitigation has already failed. Writing it down in advance is how a bad week stays a bad week instead of becoming a bad quarter.

| Band | Score | Handling |
|---|---|---|
| high | 15–25 | Named owner, mitigation task in [`TRACKER.md`](TRACKER.md), reviewed weekly in [`STATUS.md`](STATUS.md) |
| medium | 8–12 | Named owner, reviewed at milestone close |
| low | 1–6 | Recorded, reviewed at milestone close, no active work |

---

## Register

### R-01 — Deadline stampede exhausts execution capacity

| | |
|---|---|
| **Category** | technical |
| **Likelihood** | 4 |
| **Impact** | 4 |
| **Score** | 16 (high) |
| **Owner** | _unassigned_ — engineering lead |
| **Milestone** | M2, realised in production |

**Risk.** [`../docs/02-HLD.md`](../docs/02-HLD.md) §6 is explicit: *"The failure mode is not throughput, it is the deadline stampede."* Submissions do not arrive uniformly across a 90-minute window. They cluster in the final two minutes, when every candidate submits their last question at once. A pool sized for the 3.3/s average collapses under a 17/s burst, the queue backs up, results arrive after the deadline, and candidates believe their work was lost.

**Mitigation.** Size the execution pool for 5× average per the HLD capacity worked example. Separate the interactive `run` queue from the batch `submit` queue so a submit backlog does not block a candidate pressing Run (ADR-008, task H-068). Cap per-attempt execution budget so one candidate cannot starve the pool, and rate-limit the final-minute burst (task H-075). Stagger invitation `opens_at` values across a campus cohort rather than sending one blast. Make grading-in-progress an explicit, reassuring candidate state — the attempt is valid whether or not grading has finished.

**Trigger.** Prometheus alert on `bullmq_queue_depth{queue="submit"}` growing monotonically for more than 60 seconds during an exam window, or `exec_result_latency_seconds` p95 crossing 6s (75% of the 8s NFR).

**Contingency.** Shed the interactive queue first — Run is a convenience, Submit is the record. Add execution nodes from the warm pool. If results still lag, let attempts finalise asynchronously and notify candidates their result is coming, rather than holding them on a spinner. Never expire an attempt because grading was slow.

---

### R-02 — Sandbox escape from a candidate submission

| | |
|---|---|
| **Category** | technical |
| **Likelihood** | 2 |
| **Impact** | 5 |
| **Score** | 10 (medium) |
| **Owner** | _unassigned_ — engineering lead |
| **Milestone** | M2 |

**Risk.** Candidates run arbitrary code on our infrastructure by design. ADR-002 notes that both Piston and Judge0 have had documented sandbox escapes. An escape that reaches a database credential, a cloud IAM role, or the hidden test cases turns a single hostile candidate into a full data breach and destroys the integrity of the bank.

**Mitigation.** The HLD §7 posture assumes escape rather than trusting the sandbox. Execution nodes hold no secrets, no database credentials and no cloud IAM role; they have no network egress and cannot reach the API or database (task H-066). Test-case expectations never enter the sandbox — comparison happens in the grading worker, so an escaped process learns nothing about hidden cases. Limits are enforced by cgroups rather than by the application (task H-065), and nodes are ephemeral and recycled on a schedule (task H-067).

**Trigger.** Any outbound connection attempt from an execution node reaching the network policy's deny rule. Any process on an execution node outside the expected Piston process tree. A CVE published against the pinned Piston version or its runtime images.

**Contingency.** Drain and destroy the affected node group; rebuild from image. Treat every submission graded on that node in the affected window as suspect and re-grade on clean nodes. Rotate every credential that has ever existed anywhere in that VPC even though the node should have held none — "should have" is not evidence.

---

### R-03 — Dataset contamination makes imported questions worthless

| | |
|---|---|
| **Category** | delivery |
| **Likelihood** | 5 |
| **Impact** | 4 |
| **Score** | 20 (high) |
| **Owner** | _unassigned_ — question bank owner |
| **Milestone** | M0 |

**Risk.** [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md) §2 measures MBPP contamination above 60% against public sources. Every legitimately importable dataset — HumanEval, MBPP, CodeContests, LBPP, Exercism — was built to benchmark language models, which means it is in the training data of every model a candidate might use. M0's exit criterion is 200 questions loaded; if all 200 are imported, the bank passes the exit criterion and is still close to worthless above junior level. The failure is silent: the assessment runs, produces scores, and those scores measure nothing.

**Mitigation.** Treat imported content as a bootstrap for entry-level screening only, and say so in the authoring UI. Track the in-house share as a first-class metric — `source_license = 'proprietary'` count — and hold to the PRD §10 target of 150 in-house questions by month 6. Use the nightly psychometrics (FR-5) as the detector: a contaminated question shows a p-value above 0.9 with near-zero discrimination. Adapt rather than copy where the licence permits (CC-BY allows modification with credit).

**Trigger.** More than 40% of published questions carry a non-proprietary `source_license` at the M1 close date of 2026-10-30. Or: any skill whose published questions show a mean p-value above 0.85 with discrimination below 0.1.

**Contingency.** Commission in-house authoring as a funded workstream rather than a spare-time activity, with an explicit IP assignment for any contractor (see licensing §2). Retire the contaminated subset via `exposure_count` retirement rather than deleting it, so the statistics survive. Accept a smaller, honest bank over a large, decorative one.

---

### R-04 — Candidates use AI assistants in coding rounds

| | |
|---|---|
| **Category** | delivery |
| **Likelihood** | 5 |
| **Impact** | 3 |
| **Score** | 15 (high) |
| **Owner** | _unassigned_ — hiring manager and engineering lead jointly |
| **Milestone** | M2, M4 |

**Risk.** PRD §11 states it plainly: candidates will use AI assistants regardless of policy. For imported dataset questions the assistant answers instantly and correctly, so the round measures nothing (compounding R-03). For in-house questions it still shifts what is being measured. Detection is fragile, adversarial and produces false accusations — which is both unfair and a legal exposure. Pretending the problem does not exist produces scores nobody should act on.

**Mitigation.** The policy decision is resolved in [`../docs/16-ai-usage-policy.md`](../docs/16-ai-usage-policy.md) (OQ-001), not left to individual interviewers. Design questions that survive assistance: problems with ambiguous requirements, follow-up constraints, and a spoken defence of the approach. In live rounds, record the candidate's own AI usage as observable evidence — ADR-011 explicitly permits this, since prompting is now part of real engineering work. Never build a detector that produces an automated verdict; that is ADR-007 territory.

**Trigger.** Correlation between async assessment score and 90-day manager rating (PRD §10) falling below the level at which the test is predictive. Or: a coding question's p-value jumping above 0.9 within one cohort of its publication.

**Contingency.** Move the decisive coding signal from the async round to the live round, where the process is observable, and demote the async round to a filter for non-programmers. This is a product repositioning, not a bug fix, and needs the hiring manager to agree.

---

### R-05 — EU AI Act classifies the platform as a high-risk system

| | |
|---|---|
| **Category** | legal |
| **Likelihood** | 3 |
| **Impact** | 5 |
| **Score** | 15 (high) |
| **Owner** | _unassigned_ — legal / DPO |
| **Milestone** | M4, and any EU deployment |

**Risk.** Systems used for recruitment, candidate filtering and evaluation are high-risk under Annex III. Obligations include risk management, data governance, technical documentation, logging, human oversight, accuracy and robustness measures, and conformity assessment. Whether a purely deterministic weighted-sum scorer falls inside the Act's definition of an AI system is genuinely unsettled — tracked as OQ-009. Discovering after launch that it does means a conformity assessment on a system that was not built to be assessed.

**Mitigation.** Build as if it does; the cost is low and the retrofit is not. ADR-007 (no automated rejection) and ADR-011 (no AI in the scoring path) keep the product out of the most heavily regulated behaviours. The append-only audit log and immutable question versions already satisfy a large part of the logging and traceability obligations. Manual override with a mandatory reason and `POST /attempts/{id}/void` constitute documented human oversight. [`../docs/11-data-retention-and-dpia.md`](../docs/11-data-retention-and-dpia.md) carries the DPIA.

**Trigger.** Any of: a decision to deploy for EU-based candidates; counsel's answer to OQ-009 arriving; any proposal to add an automated ranking, filtering or recommendation feature; publication of guidance narrowing or widening the Annex III scope.

**Contingency.** Freeze feature work on anything resembling automated decision-making, commission a conformity assessment against the existing audit trail, and if necessary restrict EU deployments to the non-proctored, human-reviewed configuration until assessment completes.

---

### R-06 — NYC Local Law 144 bias audit becomes mandatory

| | |
|---|---|
| **Category** | legal |
| **Likelihood** | 2 |
| **Impact** | 4 |
| **Score** | 8 (medium) |
| **Owner** | _unassigned_ — people / legal |
| **Milestone** | M4 |

**Risk.** NYC requires an annual independent bias audit and candidate notice for automated employment decision tools, and equivalent rules are emerging in other jurisdictions. The obligation attaches when automated scoring substantially assists a decision — which a pass mark on an assessment plausibly does. An audit requires historical selection-rate data broken down by group; if that data was never collected in a usable shape, the audit cannot be performed and the tool cannot lawfully be used in that jurisdiction.

**Mitigation.** `GET /reports/adverse-impact` exists for exactly this and is a tracked task (H-107), with a four-fifths-rule breakdown by voluntarily collected group. Collect demographic data voluntarily, separately from the assessment record, with an explicit lawful basis — OQ-011 is open on this and must be answered before the first large cohort, because retrofitting demographic data onto past attempts is impossible.

**Trigger.** Hiring in NYC, Illinois, Colorado or any jurisdiction with an equivalent rule. Or the first cohort exceeding 100 candidates in any single assessment, at which point the four-fifths rule becomes statistically meaningful.

**Contingency.** Run the assessment as an advisory input with a documented human review of every decision, and do not publish a pass mark, until an audit can be commissioned. Commission an external auditor with at least eight weeks' lead time.

---

### R-07 — Skill taxonomy rot

| | |
|---|---|
| **Category** | operational |
| **Likelihood** | 4 |
| **Impact** | 3 |
| **Score** | 12 (medium) |
| **Owner** | _unassigned_ — question bank owner |
| **Milestone** | M0 onward, continuous |

**Risk.** ADR-009 names this itself: *"an unmaintained taxonomy with `python`, `python3`, and `Python` is worse than no taxonomy."* The whole design rests on skills being the join between roles and questions. If the taxonomy fragments, role coverage reports lie, random draws miss valid questions, per-skill sub-scores split across duplicates, and `GET /job-roles/{id}/coverage` says the bank is thin when it is not. Rot is gradual and nobody notices until the reports stop making sense.

**Mitigation.** Keep it shallow — two levels, enforced in the schema. Make it org-editable but not free-text on the question form: authors pick from the taxonomy, and adding a skill is a deliberate action with a duplicate check. Seed a curated starter taxonomy (task H-018) rather than letting it grow organically from the first import. Name an owner — OQ-010 is open on exactly this.

**Trigger.** Skill count growing faster than published question count month over month. Any two skills with a normalised-name edit distance below 3. Any skill with fewer than three published questions after 90 days.

**Contingency.** Freeze skill creation, run a merge pass (the merge is a data migration, not a UI action, because `question_skills` and `job_role_skills` both need rewriting), and re-tag from the merged set. Cheap at 50 skills, painful at 300 — which is why the trigger is set early.

---

### R-08 — A prohibited-licence dependency reaches production

| | |
|---|---|
| **Category** | legal |
| **Likelihood** | 3 |
| **Impact** | 4 |
| **Score** | 12 (medium) |
| **Owner** | _unassigned_ — engineering lead |
| **Milestone** | M-1 onward, continuous |

**Risk.** Two named traps in [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md) §1. **MinIO is AGPL-3.0** and is the default answer to "self-hosted S3-compatible store" — running it inside a candidate-facing networked product is exactly what the AGPL is written to catch. **Redis after 7.2 is RSALv2/SSPL.** Both are easy to reach for absent-mindedly: a tutorial, a Docker image someone copies, a transitive dependency. ADR-001 exists because a copyleft component discovered after launch means either source disclosure or a rewrite.

**Mitigation.** SeaweedFS (Apache-2.0) and Valkey 8 (BSD-3) are the canonical choices for this repository, wired into the compose stack so the easy path is the compliant path. The CI licence gate fails the build on GPL, LGPL-static, AGPL, SSPL, BSL/BUSL and Commons Clause, including transitive dependencies (task H-007), verified against a deliberately planted AGPL fixture (task H-039). A CycloneDX SBOM per release. Quarterly dependency licence review per the licensing doc's ownership checklist.

**Trigger.** The licence gate failing. A dependency changing licence between releases — the gate catches this on the next build, which is why it runs on every build and not only on lockfile changes. Any pull request introducing a container image not defined in `infra/`.

**Contingency.** Revert the dependency. If it already shipped, assess distribution: an internal-only never-distributed deployment changes the analysis substantially (OQ-008), which is precisely why that question needs answering in writing rather than by assumption.

---

### R-09 — RLS degrades query plans on the hot path

| | |
|---|---|
| **Category** | technical |
| **Likelihood** | 3 |
| **Impact** | 3 |
| **Score** | 9 (medium) |
| **Owner** | _unassigned_ — engineering lead |
| **Milestone** | M0, felt in M1 and M2 |

**Risk.** ADR-010 accepts this cost explicitly: *"some query plans degrade — measure before assuming."* An RLS policy is a predicate the planner must incorporate, and `current_setting('app.current_org')::uuid` is opaque to it in ways a literal is not. The symptom appears under load, not in development: the attempt read path and the reporting queries slow down exactly when 500 candidates are mid-assessment, and the API p95 < 300 ms NFR fails.

**Mitigation.** Capture an `EXPLAIN` baseline with RLS enabled during M0 (task H-020), not after the regression. Mark policy functions `STABLE` and keep `org_id` first in composite indexes so the policy predicate is index-satisfiable. Route reporting to a read replica so the transactional path is not competing with cohort analytics (HLD §6). Include the attempt read path in the load scenarios in [`../docs/07-load-and-capacity-testing.md`](../docs/07-load-and-capacity-testing.md).

**Trigger.** API p95 above 250 ms on any non-execution endpoint in staging load runs. Any query plan in the M0 baseline changing from index scan to sequential scan after a migration.

**Contingency.** Add covering indexes; if that is insufficient, introduce a security-definer accessor for the two or three hottest reads while keeping RLS as the backstop everywhere else. Do not disable RLS — a forgotten `WHERE` clause returning another tenant's data is the failure that ends products, and a slow query is not.

---

### R-10 — Piston is not mature enough for what we need

| | |
|---|---|
| **Category** | technical |
| **Likelihood** | 3 |
| **Impact** | 4 |
| **Score** | 12 (medium) |
| **Owner** | _unassigned_ — engineering lead |
| **Milestone** | M2 |

**Risk.** ADR-002 accepts a known capability gap: Judge0 has 90+ languages, multi-file support and years of production use in assessment products; Piston is smaller and we own more of the operational burden — runtime installation, container recycling, resource tuning. The gap could bite as a missing language a hiring manager needs, weak multi-file support for M3's workspace, unreliable resource enforcement, or simply more operational time than the plan allows. Piston's public API is no longer freely available, so self-hosting was required regardless.

**Mitigation.** The adapter is the mitigation. `packages/exec-adapter` exposes `execute(language, version, files, stdin, limits) → result` and nothing above it knows Piston exists (task H-064). Pin runtime images and treat the language matrix as a product decision with a named supported set, rather than "whatever Piston ships". Validate multi-file and SQL fixtures early in M2 rather than at the end.

**Trigger.** A language required by a live hiring loop that Piston does not package. Execution nodes needing more than one unplanned intervention per week. Resource limits not being enforced as configured in the M2 limit tests.

**Contingency.** Swap the adapter implementation. Judge0 is available if the internal-only determination in OQ-008 lands that way (GPL-3 costs nothing when nothing is distributed); otherwise a gVisor-based runner or a commercial sandbox. The adapter means this is one module, and that is the entire reason it exists.

---

### R-11 — An inaccessible candidate experience becomes a discrimination exposure

| | |
|---|---|
| **Category** | legal |
| **Likelihood** | 3 |
| **Impact** | 5 |
| **Score** | 15 (high) |
| **Owner** | _unassigned_ — engineering lead, with legal |
| **Milestone** | M1 onward, verified in M4 |

**Risk.** PRD §8 states it directly: *"A candidate who cannot complete your assessment because of a screen-reader failure is a discrimination exposure, not a bug backlog item."* Under the ADA, the Equality Act and equivalents, an assessment that excludes a disabled candidate is actionable. The two highest-risk surfaces are the hardest to make accessible: a Monaco code editor and a timed interface. Accessibility deferred to M4 means M1 and M2 ship inaccessible and candidates are excluded in the meantime.

**Mitigation.** WCAG 2.1 AA is an NFR for the candidate experience, not a milestone deliverable. Automated axe checks in CI from the first candidate-facing screen, not from M4 (task H-108 is the conformance pass, but the CI gate lands with H-057). Keyboard-navigable throughout, no colour-only information, adjustable text size, screen-reader-tested question rendering. Per-candidate time extensions are a first-class recorded feature applied to `deadline_at`, not an informal favour (task H-049). Conformance detail in [`../docs/15-accessibility-conformance.md`](../docs/15-accessibility-conformance.md).

**Trigger.** Any axe violation at serious or critical severity on a candidate-facing route. Any support ticket describing an assistive-technology failure — these are incidents, not feature requests. The absence of a keyboard-only pass on a new candidate screen.

**Contingency.** Offer an alternative assessment format immediately for the affected candidate, recorded as an accommodation, and treat the underlying defect as a production incident with a runbook entry rather than a backlog item.

---

### R-12 — Single-engineer bus factor, concentrated on M3

| | |
|---|---|
| **Category** | people |
| **Likelihood** | 4 |
| **Impact** | 4 |
| **Score** | 16 (high) |
| **Owner** | _unassigned_ — engineering lead |
| **Milestone** | M3, with knock-on to M4 |

**Risk.** [`../docs/README.md`](../docs/README.md) assumes M3 runs in parallel with a second engineer, and the dates in [`MILESTONES.md`](MILESTONES.md) encode that assumption. If the second engineer is not hired, not confirmed, or leaves, M3 becomes serial and the whole plan slips four weeks — M4 moves to 2027-02-01 → 2027-02-26. Beyond the schedule, M3 is the most specialised surface in the product: Yjs internals, awareness protocol, snapshot semantics and replay reconstruction are held in one head, and ADR-005 notes the CRDT state is an opaque binary blob that cannot be inspected in SQL.

**Mitigation.** Confirm the second engineer by 2026-10-16 so the M2-parallel ramp-up window is still recoverable (OQ-012). Keep `session_events` as the queryable parallel stream so replay, analytics and audit do not require CRDT expertise (ADR-005). Require the collab work to land with the convergence test (folded into task H-082) so behaviour is specified in code rather than in one person's understanding. Pair-review every collab pull request.

**Trigger.** 2026-10-16 passing without a confirmed second engineer. Any week where the collab track has no merged pull request. A collab defect that takes more than two days to diagnose — that is the bus-factor symptom, not a hard bug.

**Contingency.** Re-plan as serial: M3 2027-01-05 → 2027-01-30, M4 2027-02-01 → 2027-02-26, and update [`MILESTONES.md`](MILESTONES.md) and [`STATUS.md`](STATUS.md) the same week rather than quietly absorbing the slip. If live interviews are needed sooner, run them on an existing tool and integrate the scorecard only — the scorecard is the part that affects the hiring record, and it does not depend on the CRDT.

---

### R-13 — Question-bank cold start

| | |
|---|---|
| **Category** | delivery |
| **Likelihood** | 4 |
| **Impact** | 4 |
| **Score** | 16 (high) |
| **Owner** | _unassigned_ — question bank owner |
| **Milestone** | M0, felt from M1 |

**Risk.** The shared bank is the product's whole premise, and on day one it is empty. Every downstream feature degrades against a thin bank: random draws become infeasible and `simulate` fails (ADR-004), `exclude_seen_days` cannot be honoured so the same questions leak across a cohort (FR-6), exposure counts climb until questions must be retired with nothing to replace them (FR-4), and psychometrics need n ≥ 30 per version before they say anything (FR-5). PRD §3 warns that authors *"will abandon the tool if authoring takes longer than writing the question in a text file"* — so the obvious fix, asking senior engineers to write questions, is the one most likely to stall.

**Mitigation.** Import for breadth, author for depth — 200 imported questions get M0 over its exit line while in-house authoring runs alongside (see R-03 for why imports alone are not enough). Make authoring genuinely fast: markdown prompt, inline test-case editor, no YAML, no multi-step wizard (task H-038). Use `GET /job-roles/{id}/coverage` to direct authoring effort at the thin skills rather than wherever an author feels like writing. Start with a small number of roles; three is the M0 exit criterion and is enough.

**Trigger.** Any `POST /assessments/{id}/simulate` returning `feasible: false` for a role a recruiter actually wants to hire for. Any skill with fewer than 3× the questions a draw rule needs. In-house authored count below 25 by 2026-10-30.

**Contingency.** Narrow the draw rules — widen the difficulty band and drop `exclude_seen_days` to zero — and accept higher exposure temporarily, with the exposure explicitly recorded so those questions are retired first. Fund authoring as scheduled work with an IP assignment for contractors, rather than hoping for volunteers.

---

### R-14 — Yjs state is opaque, so replay divergence is hard to diagnose

| | |
|---|---|
| **Category** | technical |
| **Likelihood** | 3 |
| **Impact** | 3 |
| **Score** | 9 (medium) |
| **Owner** | _unassigned_ — engineer 2 |
| **Milestone** | M3 |

**Risk.** ADR-005 accepts the cost: Yjs document state is a binary blob that cannot be queried in SQL. If a replay reconstructs to a different final document than `doc_state`, or an interview appears to lose work, there is no query that explains why — only a snapshot, an event stream, and a client that has since disconnected. FR-18 requires the full event stream be recorded and replayable; a divergence undermines the only evidence a live round produces.

**Mitigation.** `session_events` exists precisely as the parallel, queryable, append-only stream (ADR-005, task H-085). Snapshot on `COLLAB_SNAPSHOT_INTERVAL_MS` so the loss window is bounded and known. Assert in a test that replaying the event stream reconstructs to the same final text as the stored `doc_state`, at multiple speeds (tasks H-086 and H-087). Propagate a trace id from client through collab into the event append, per HLD §8.

**Trigger.** Any replay whose reconstructed text differs from `doc_state`. Any session where `session_events` row count is inconsistent with the client's update count. Collab instance restart during an active session.

**Contingency.** Fall back to the event stream as the record of the session — it is the audit source of truth by design — and treat `doc_state` as a performance cache. If divergence is systematic, shorten the snapshot interval and add a per-update checksum to localise where the streams parted.

---

### R-15 — Candidates lose work through autosave failure

| | |
|---|---|
| **Category** | technical |
| **Likelihood** | 2 |
| **Impact** | 5 |
| **Score** | 10 (medium) |
| **Owner** | _unassigned_ — engineering lead |
| **Milestone** | M1 |

**Risk.** FR-9 requires autosave within 5 seconds and no data loss on disconnect; the NFR table requires zero answer loss. PRD §3 says candidates care about *"not losing work when wifi drops"*. Lost work is the single most damaging candidate-experience failure: it is unrecoverable, it is visibly our fault, and it produces a score that understates the candidate. The realistic failure is not a crash but connection churn — a candidate on campus wifi whose autosave requests silently fail while the UI shows everything is fine.

**Mitigation.** Client-side buffer with replay on reconnect, so the autosave is durable locally before it is durable remotely (task H-058). Explicit save-state indicator in the candidate UI — saved, saving, retrying — rather than an optimistic green tick. Server-side autosave failure rate as a paging alert, per HLD §8: *"Autosave failure rate above zero → candidates losing work, page immediately."* The deadline sweep grades whatever was autosaved rather than discarding the attempt (ADR-006, task H-052).

**Trigger.** `autosave_failure_total` above zero in any five-minute window. Any attempt finalising with fewer answered questions than its heartbeat activity implies.

**Contingency.** Extend the affected candidates' deadlines as recorded accommodations and let them resume; if the answers are genuinely gone, void the attempt with a reason and re-invite. Never finalise a score built on a known-lossy attempt.

---

### R-16 — At-least-once webhooks cause duplicate ATS stage moves

| | |
|---|---|
| **Category** | technical |
| **Likelihood** | 3 |
| **Impact** | 2 |
| **Score** | 6 (low) |
| **Owner** | _unassigned_ — engineering lead |
| **Milestone** | M1 |

**Risk.** [`../docs/03-API-spec.md`](../docs/03-API-spec.md) §12 specifies at-least-once delivery with a 24-hour retry window, and notes consumers must be idempotent on `event_id`. Not every ATS is. A retried `attempt.finalised` can advance a candidate twice, send a duplicate rejection, or overwrite a stage a recruiter set manually in between. The blast radius is a confused recruiter rather than a corrupted score, which is why this is low — but it erodes trust in the integration quickly.

**Mitigation.** Stable `event_id` per event, documented prominently in the integration guide at [`../docs/09-ats-integration.md`](../docs/09-ats-integration.md). HMAC-SHA256 signature over the raw body so a consumer can safely deduplicate before parsing. Delivery log queryable through `GET /webhooks/{id}/deliveries` so a duplicate can be traced rather than argued about (task H-061).

**Trigger.** Any delivery log showing more than two attempts for a single `event_id`. An ATS-side report of a duplicate stage transition.

**Contingency.** Add an org-level delivery-deduplication window on our side as a courtesy for consumers that cannot deduplicate, accepting that it weakens the at-least-once guarantee, and record that trade-off in the integration doc.

---

### R-17 — Delivery pressure erodes ADR-007 or ADR-011

| | |
|---|---|
| **Category** | people |
| **Likelihood** | 3 |
| **Impact** | 5 |
| **Score** | 15 (high) |
| **Owner** | _unassigned_ — engineering lead, escalating to legal |
| **Milestone** | M4, but pressure starts earlier |

**Risk.** ADR-007 anticipates this: *"This is a product constraint, not a configurable setting, and should not be softened under delivery pressure."* The pressure is predictable and reasonable-sounding. The integrity review queue creates human work; someone proposes auto-voiding attempts above a signal threshold "just for obvious cases". The bank is thin; someone proposes AI question generation without review. Subjective grading is slow; someone proposes an AI first-pass score. Each step is small, each is defensible in isolation, and the composite is an automated employment decision system built on weak signals — unfair, and a serious legal exposure under the EU AI Act and GDPR Article 22.

**Mitigation.** Encode the constraint in tests, not only in prose: a release-blocking test asserting no code path lets a proctoring signal alter a score, status or decision (task H-098). Require an ADR to change either decision, which forces the reasoning into the open. [`../docs/16-ai-usage-policy.md`](../docs/16-ai-usage-policy.md) states the boundary explicitly so "does this count as AI in the scoring path" has a written answer rather than a debate.

**Trigger.** Any pull request, ticket or design proposal that would write to `attempts.status`, `raw_score`, `score_pct` or `passed` from a proctoring, heuristic or model-derived source. Any proposal containing the phrase "automatically flag and".

**Contingency.** Escalate to legal before the code is written, not after. If the business genuinely needs automated filtering, that is a new product decision requiring a conformity assessment and an ADR superseding ADR-007 — not a configuration flag, and not a delivery-pressure concession.

---

### R-18 — Database primary fails during an exam window

| | |
|---|---|
| **Category** | operational |
| **Likelihood** | 2 |
| **Impact** | 5 |
| **Score** | 10 (medium) |
| **Owner** | _unassigned_ — engineering lead |
| **Milestone** | M1 onward |

**Risk.** HLD §9 rates a database primary failure as a total outage. During an exam window that means 500 candidates on a server-authoritative timer that keeps running while they cannot save. The NFR is 99.9% availability *during an exam window*, which is a much harder target than 99.9% overall, because the downtime cannot be scheduled into a quiet hour — there is no quiet hour during a campus drive.

**Mitigation.** HA pair with automatic failover and WAL-based durability (HLD §10). Client-side autosave buffering means a short failover is survivable from the candidate's side (see R-15). Attempts resume from autosave rather than restarting. Alert on attempts stuck `in_progress` past `deadline_at`, which is the observable signature of a timer or finalisation problem after a failover (HLD §8). Runbook in [`../docs/12-observability-and-runbooks.md`](../docs/12-observability-and-runbooks.md).

**Trigger.** Failover event. Replication lag above the alert threshold. Any attempt whose `deadline_at` has passed while still `in_progress`.

**Contingency.** Extend `deadline_at` for every attempt live during the outage window, as a recorded, audited bulk accommodation — the server owns the clock, so this is a supported state transition rather than a hack (ADR-006). Communicate to candidates within the window, not afterwards.

---

### R-19 — M4 scope is pulled forward by a certification commitment

| | |
|---|---|
| **Category** | delivery |
| **Likelihood** | 3 |
| **Impact** | 3 |
| **Score** | 9 (medium) |
| **Owner** | _unassigned_ — engineering lead with hiring manager |
| **Milestone** | M2, M3 |

**Risk.** M4 is last deliberately: [`../docs/README.md`](../docs/README.md) calls it *"the least valuable per unit of effort and the most legally fraught"*. The pressure to move it earlier is predictable — a campus drive needs proctoring, or someone wants to issue certificates before the bank is mature. Pulling M4 forward lands proctoring, consent capture, biometric retention and Safe Exam Browser before the DPIA exists and before the review queue has anyone to staff it, which converts a sequencing decision into a compliance incident.

**Mitigation.** The ordering rationale is written down in the PRD and the docs index, so the argument is against a recorded decision rather than against a preference. Browser-signal proctoring without media capture is the cheap subset and can be discussed independently of webcam capture, which is the expensive, regulated part. The DPIA in [`../docs/11-data-retention-and-dpia.md`](../docs/11-data-retention-and-dpia.md) is a hard prerequisite for any media capture.

**Trigger.** Any commitment to a proctored exam date before 2027-01-30. Any request for certificate issuance before M4 starts.

**Contingency.** Offer in-person invigilation as the near-term answer for high-stakes rounds — it is what the product would fall back on anyway when consent is declined — and keep the M4 sequence intact.

---

### R-20 — Candidate PII leaks through export artifacts or pre-signed URLs

| | |
|---|---|
| **Category** | operational |
| **Likelihood** | 2 |
| **Impact** | 5 |
| **Score** | 10 (medium) |
| **Owner** | _unassigned_ — engineering lead, with DPO |
| **Milestone** | M2 (object storage), M4 (media and export) |

**Risk.** FR-29 and G6 require full export in open formats, and the product deliberately makes it easy to get data out. That same path is the easiest way for data to leave unintentionally: an export artifact with a long-lived URL, a proctor media object readable without a signature, an export containing candidate PII handed to someone who only needed aggregate results. Proctor media is biometric data under GDPR Article 9, with a higher bar and a hard retention ceiling.

**Mitigation.** Object-store access only through short-TTL pre-signed URLs, never a stable public path (tasks H-078 and H-101). Export generation is an audited privileged action. Retention sweeps enforced in code for every `RETENTION_*` clock, with time-travel tests per clock (task H-105) — the licensing doc is explicit that retention must be enforced in code, not in a policy document. GDPR erasure hard-deletes PII while retaining anonymised rows so statistics survive (task H-104).

**Trigger.** Any object served without a signature. Any pre-signed URL issued with a TTL above the configured ceiling. Any `proctor_media` row past `delete_after` still resolving. Any export download not matched by an `audit_log` row.

**Contingency.** Invalidate the signing key, which revokes every outstanding URL at once, and re-issue. Notify the DPO and assess breach-notification obligations within the statutory window — the decision to notify is legal's, and the technical evidence must be available to them from the audit log immediately, not reconstructed later.

---

## Summary

| ID | Risk | Category | L | I | Score | Band | Milestone |
|---|---|---|---|---|---|---|---|
| R-03 | Dataset contamination makes imported questions worthless | delivery | 5 | 4 | 20 | high | M0 |
| R-01 | Deadline stampede exhausts execution capacity | technical | 4 | 4 | 16 | high | M2 |
| R-12 | Single-engineer bus factor, concentrated on M3 | people | 4 | 4 | 16 | high | M3 |
| R-13 | Question-bank cold start | delivery | 4 | 4 | 16 | high | M0 |
| R-04 | Candidates use AI assistants in coding rounds | delivery | 5 | 3 | 15 | high | M2 |
| R-05 | EU AI Act high-risk classification | legal | 3 | 5 | 15 | high | M4 |
| R-11 | Inaccessible candidate experience as discrimination exposure | legal | 3 | 5 | 15 | high | M1 |
| R-17 | Delivery pressure erodes ADR-007 or ADR-011 | people | 3 | 5 | 15 | high | M4 |
| R-07 | Skill taxonomy rot | operational | 4 | 3 | 12 | medium | M0 |
| R-08 | Prohibited-licence dependency reaches production | legal | 3 | 4 | 12 | medium | M-1 |
| R-10 | Piston maturity gap against Judge0 | technical | 3 | 4 | 12 | medium | M2 |
| R-02 | Sandbox escape from a candidate submission | technical | 2 | 5 | 10 | medium | M2 |
| R-15 | Candidates lose work through autosave failure | technical | 2 | 5 | 10 | medium | M1 |
| R-18 | Database primary fails during an exam window | operational | 2 | 5 | 10 | medium | M1 |
| R-20 | Candidate PII leaks through exports or pre-signed URLs | operational | 2 | 5 | 10 | medium | M2 |
| R-09 | RLS degrades query plans on the hot path | technical | 3 | 3 | 9 | medium | M0 |
| R-14 | Yjs state is opaque, replay divergence hard to diagnose | technical | 3 | 3 | 9 | medium | M3 |
| R-19 | M4 scope pulled forward by a certification commitment | delivery | 3 | 3 | 9 | medium | M2 |
| R-06 | NYC Local Law 144 bias audit becomes mandatory | legal | 2 | 4 | 8 | medium | M4 |
| R-16 | At-least-once webhooks cause duplicate ATS stage moves | technical | 3 | 2 | 6 | low | M1 |

Eight high, eleven medium, one low. Three of the eight high risks — R-03, R-13, R-04 — are the same underlying problem seen from different angles: **the bank is the product, and a bank that does not discriminate between strong and weak candidates makes every other feature decorative.** That is where the attention belongs.
