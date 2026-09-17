# Rule: documentation maintenance

**Status:** draft
**Owner:** _unassigned_ (delivery lead)
**Last updated:** 2026-09-17
**Companion docs:** [`../../CLAUDE.md`](../../CLAUDE.md), [`../../docs/DOC-OWNERSHIP.md`](../../docs/DOC-OWNERSHIP.md), [`invariants.md`](invariants.md), [`review-checklist.md`](review-checklist.md)

---

The contract in [`CLAUDE.md`](../../CLAUDE.md) "Keeping the docs true", expanded into what each rule actually requires, with the two worked examples that matter. Point an agent at this file when it is about to change something structural.

Every rule below applies **in the same change** that causes it. Not in a follow-up commit, not in a tidy-up pull request, not in a ticket. A follow-up is a promise, and the failure mode this whole mechanism exists to prevent is a promise that was made honestly and then overtaken by the next piece of work.

## The eight rules, and what each one costs to skip

| # | Rule | Skipping it costs |
|---|---|---|
| 1 | A structural change updates `code-graph.json` and regenerates `CODE-GRAPH.md` with `node scripts/gen-code-graph.mjs`. Never hand-edit the generated region. | The module map becomes fiction. It is worse than nothing because people trust it enough to act on it. |
| 2 | Work that reaches done flips its row in `project/TRACKER.md` and the summary in `project/STATUS.md`. | Two weeks and the tracker is a historical document nobody consults, so planning happens in someone's head. |
| 3 | A satisfied milestone exit criterion is marked in `project/MILESTONES.md` with the date and the evidence. | The milestone closes on a feeling instead of on evidence, and the next milestone inherits the gap. |
| 4 | A decision that is expensive to reverse becomes a **new** ADR in `docs/04-ADRs.md`. Accepted ADRs are superseded, never rewritten. | The reasoning is lost. Someone re-opens the decision in six months with none of the constraints that drove it. |
| 5 | An answered question is deleted from `project/OPEN-QUESTIONS.md` and written into the document that owns the subject. | An open-questions file that only grows is a file nobody reads, which means genuinely open questions hide in it. |
| 6 | Every document you touch gets its `**Last updated:**` bumped to the date of the change. | The freshness gate cannot tell a reviewed document from an abandoned one, so the cadence mechanism stops working. |
| 7 | A new environment variable lands in `.env.example`, `docker-compose.yml`, `packages/config` and `docs/13-environments-and-release.md` together. | It fails at 03:00 in an exam window instead of at boot, which is the entire reason `packages/config` validates at startup. |
| 8 | A task id is allocated in `project/TRACKER.md` and nowhere else; a document cites, never mints. | The reference silently comes to name a different task once the backlog grows past it, and reads correctly the whole time. `docs/14-threat-model.md` lost twenty-six of its mitigations this way. `scripts/check-task-ids.mjs` is the gate. |

Two mechanical consequences follow from rule 6. The registry column in [`docs/DOC-OWNERSHIP.md`](../../docs/DOC-OWNERSHIP.md) mirrors each document's header date, so run `node scripts/check-doc-freshness.mjs --sync` after bumping. And bumping a date without re-reading the document is a review failure, not a shortcut — the date asserts that someone looked.

## The trigger rules

The registry maps path patterns to documents. If your diff touches a pattern, the document must be in the same diff. `node scripts/check-doc-freshness.mjs --changed <files>` is what CI runs; run it locally against your own diff before pushing:

```
node scripts/check-doc-freshness.mjs --changed $(git diff --name-only origin/main...HEAD)
```

The frequently-fired ones, in the order you are most likely to meet them:

| You changed | You must also change |
|---|---|
| `apps/api/src/routes/**` or `packages/contracts/**` | `docs/03-API-spec.md` |
| `code-graph.json`, `apps/*/package.json`, `packages/*/package.json` | `CODE-GRAPH.md` (regenerated, not edited) and `docs/02-HLD.md` for a boundary change |
| `.env.example`, `docker-compose.yml`, `packages/config/**` | `docs/13-environments-and-release.md` |
| `packages/auth/**`, `packages/exec-adapter/**`, `infra/piston/**`, `infra/postgres/init/03-rls.sql` | `docs/14-threat-model.md` — any new trust boundary or auth change |
| `packages/db/schema/**` | `docs/hiring_platform_schema.sql` and `docs/11-data-retention-and-dpia.md` |
| `packages/observability/**`, `infra/otel/**`, `infra/prometheus/**` | `docs/12-observability-and-runbooks.md` |
| `docs/04-ADRs.md` | [`invariants.md`](invariants.md) — a new ADR may add or change an invariant |

**Test-only changes do not fire triggers.** A file named `*.test.*` or `*.spec.*`, or living under a `test/`, `tests/`, `__tests__/` or `fixtures/` directory, is ignored when the gate decides which documents a diff must touch. A test asserts behaviour the source already has; when the behaviour changes, the source changes too and fires the trigger itself. Before this rule, renaming a fixture value demanded an edit to the observability runbook, and the only way to satisfy it was to bump a date on a document nobody had re-read.

If a trigger genuinely does not apply to your change, the answer is to narrow the pattern in the registry and say why in the pull request. It is never to bypass the gate.

## Worked example: a compliant change

**Task.** Add a `GET /api/v1/attempts/{id}/events` SSE endpoint so the candidate app can stream grading progress.

The diff contains, in one pull request:

```
packages/contracts/src/attempts.ts        zod schema for the event frames, new error code
packages/contracts/openapi.json           regenerated, committed
apps/api/src/routes/attempts/events.ts    the route
apps/api/test/attempts.events.test.ts     integration test against the dev stack
docs/03-API-spec.md                       new endpoint, frame shapes, error codes; Last updated bumped
docs/12-observability-and-runbooks.md     the new stream's metric and what to do when it stalls; Last updated bumped
docs/DOC-OWNERSHIP.md                     Last updated column synced for both
project/TRACKER.md                        H-0xx flipped to done
project/STATUS.md                         summary line updated
```

Why each is there. The contract changed, so `packages/contracts` and the OpenAPI document changed together — they are one artefact. The route pattern fired the `docs/03-API-spec.md` trigger. SSE is a new async path, so the definition of done requires a metric and a runbook entry, which fires `docs/12`. `code-graph.json` did **not** change, because no boundary, package, queue or external dependency changed — adding a route inside an existing app is not a structural change. No ADR, because reverting this needs a revert and nothing else.

`node scripts/check-doc-freshness.mjs --changed <the list above>` passes, and so does `node scripts/check-links.mjs`.

## Worked example: a non-compliant change

**Task.** Same endpoint. The diff contains:

```
packages/contracts/src/attempts.ts
apps/api/src/routes/attempts/events.ts
apps/api/test/attempts.events.test.ts
```

Five failures, in descending order of how expensive they are later:

1. **`docs/03-API-spec.md` is now wrong.** It describes an API that no longer matches the server. The next person integrating against the spec writes a client that does not work and spends an afternoon deciding whether the spec or the server is authoritative. CI catches this: the trigger rule fires and names the document.
2. **No runbook entry.** The first time the stream stalls at 02:00, whoever is on call learns the endpoint exists from the stack trace.
3. **OpenAPI not regenerated.** The generated document and the zod schemas disagree, which means the contract test fails on the next unrelated pull request and someone bisects it.
4. **Tracker not flipped.** The work is done and the board says it is not, so someone else picks it up or the delivery lead reports the wrong state.
5. **No `Last updated` bumps.** Nothing signals that anyone reviewed the affected documents.

The fix is not a follow-up pull request. It is four more files in this one.

## The one legitimate escape hatch

A change that is genuinely mechanical across many files — a rename, a formatting pass, a dependency bump with no behavioural change — may state in the pull request body that it touches trigger paths without changing behaviour, and narrow or adjust the trigger pattern if the pattern is the thing that is wrong. That is a reviewed decision recorded in the diff. Editing the registry to remove a trigger so your pull request goes green, without saying so, is the only thing here that counts as dishonest rather than merely incomplete.
