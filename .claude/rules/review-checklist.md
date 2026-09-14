# Rule: review checklist

**Status:** draft
**Owner:** _unassigned_ (engineering lead)
**Last updated:** 2026-09-15
**Companion docs:** [`../../project/DEFINITION-OF-DONE.md`](../../project/DEFINITION-OF-DONE.md), [`invariants.md`](invariants.md), [`doc-maintenance.md`](doc-maintenance.md), [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md)

---

What a human reviewer checks, ordered by how expensive the mistake is to discover later. The order is the whole point: attention is finite and it degrades through a review, so the things that cannot be undone come first and the things a linter would catch come last — or, better, are not reviewed by a human at all.

[`project/DEFINITION-OF-DONE.md`](../../project/DEFINITION-OF-DONE.md) is the author's list and the pull-request template mirrors it. This is the reviewer's list, and it is shorter, because a reviewer who re-runs the author's checklist is doing the wrong job.

## Tier 1 — unrecoverable. Block the merge.

A mistake here cannot be fixed by a later commit. The damage is to candidate data, to the question bank, or to a legal position.

- **Does anything let a signal become a decision?** A proctoring signal, an AI-use signal, a heuristic, a threshold — anything that changes a score, an attempt status, or an advance/reject outcome without a person. Invariant 6, ADR-007. There is no version of this that is acceptable because it is behind a feature flag.
- **Does a model touch the scoring or decision path?** Invariant 4, ADR-011. Drafting assistance with a human publisher is fine. Anything producing or adjusting a number is not.
- **Can hidden content reach a candidate?** `is_correct`, `rationale_md`, `solution_code`, hidden expectations — in a response body, an error body, an SSE frame, a WebSocket awareness payload, a log line, a source map. Invariant 7. Once the bank leaks, every historical score measured something different from what you thought, and there is no re-grade that fixes it.
- **Is a new tenant table missing `org_id` or an RLS policy?** Invariant 8. The reporting query that finds this for you will find it in front of a customer.
- **Is the migration destructive in one step?** Drop, rename, type-narrow, or a `NOT NULL` without a backfill. Invariant 15. Exam windows do not pause for deploys.
- **Does a new dependency carry a prohibited licence?** Invariant guard: `node scripts/check-licences.mjs`. Removing a dependency the product already depends on is a project, not a fix.
- **Does candidate PII or proctor media gain a new home without a retention clock?** [`docs/11-data-retention-and-dpia.md`](../../docs/11-data-retention-and-dpia.md). Data you did not plan to delete is data you will be asked about.

If any Tier 1 item is in doubt, the reviewer's move is to ask, not to approve with a comment. "Left a note" is how these ship.

## Tier 2 — expensive. Fix before merge.

Recoverable, but the recovery costs days and usually involves a data migration or an apology.

- **Immutability and determinism.** Does anything mutate a published `question_version`, or recompute a draw after attempt start? Invariants 1 and 2. Does any collection feeding a score lack an explicit sort, or any grading query lack a total order? Invariant 3 — a re-grade that differs is indistinguishable from a bug you cannot reproduce.
- **Clock.** Is any deadline, timer or expiry derived from a client-supplied timestamp? Invariant 12. Look specifically at new SSE frames and new candidate-facing components.
- **Credential domains.** Can a staff session reach a candidate surface, or an attempt token reach a staff one? Invariant 11.
- **Execution payload.** Does anything add a question id, an attempt id or an expectation to what goes into `packages/exec-adapter`? Invariant 10.
- **Idempotency and the failure path.** Is a new job idempotent by its natural key? Does the exhausted-retry path move the attempt to `under_review` rather than finalising it with whatever it has? Invariants 13 and 14.
- **API compatibility.** Is a response field removed, a type narrowed, or an error code's meaning changed? Additive first, deprecate, then remove — expand-contract applied to consumers.
- **Layering.** Does a package import in a direction `CODE-GRAPH.md` forbids? Does `apps/candidate` import from `apps/web` or from anything holding bank queries? Does `packages/core-domain` or `packages/grading` perform I/O?

## Tier 3 — operability. Usually a comment, occasionally a block.

The system will work and then be difficult to run.

- A new async path — job, queue, sweep, stream, external call — ships with at least one metric or span, and a runbook entry in [`docs/12-observability-and-runbooks.md`](../../docs/12-observability-and-runbooks.md). An alert with no runbook wakes someone who then works it out at 03:00.
- A trace id propagates from the request through the queue into the worker and any execution call. Without it, "why did this candidate's score differ on re-grade" is unanswerable.
- A privileged action — score change, void, expire, publish, retire, permission grant, token issue, export — writes an `audit_log` row naming the actor, the entity and the reason.
- A new environment variable is in `.env.example`, `docker-compose.yml`, `packages/config` and [`docs/13-environments-and-release.md`](../../docs/13-environments-and-release.md), and fails at boot rather than at use.
- Rate-limit scope is decided, or explicitly recorded as unlimited with a reason.

## Tier 4 — truth of the record. Cheap now, corrosive later.

CI catches most of this. What CI cannot catch is the one that matters.

- The trigger rules passed (`node scripts/check-doc-freshness.mjs --changed …`), and — the part no gate can check — **the documents that were updated say something true**. A date bumped without the text being re-read is a review failure, not a shortcut.
- `code-graph.json` changed if a boundary, package, queue or external dependency changed, and `CODE-GRAPH.md` was regenerated rather than hand-edited.
- The tracker row flipped in this pull request, and any satisfied milestone exit criterion is marked with its date and evidence.
- A decision expensive to reverse has an ADR, and no accepted ADR was edited in place.
- An answered open question left [`project/OPEN-QUESTIONS.md`](../../project/OPEN-QUESTIONS.md) and landed in the document that owns the subject.

## Tier 5 — candidate experience. Never skip it for a candidate-facing change.

Ordered last because it applies to a subset of changes, not because it matters least. For anything shipping in `apps/candidate`:

- Keyboard-only path works, run by a person. Axe reports no serious or critical violations. No information is carried by colour alone.
- No work is lost: autosave within five seconds, local buffering, replay on reconnect, and a save state the candidate can see — never an optimistic tick.
- The copy is comprehensible to a nervous person under time pressure. "Grading in progress" beats a spinner; "your work is saved" beats silence.

## What not to spend review attention on

Formatting, import order, naming that the linter accepts, and preferences dressed as standards. If it can be automated, automate it rather than mentioning it; if it cannot and it is genuinely a preference, say so explicitly and let the author decide. Every comment of this kind spends attention that Tier 1 needed.
