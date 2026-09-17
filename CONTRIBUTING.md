# Contributing

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-17
**Companion docs:** [`CLAUDE.md`](CLAUDE.md), [`README.md`](README.md), [`project/DEFINITION-OF-DONE.md`](project/DEFINITION-OF-DONE.md), [`docs/04-ADRs.md`](docs/04-ADRs.md), [`docs/05-licensing-and-compliance.md`](docs/05-licensing-and-compliance.md)

---

[`CLAUDE.md`](CLAUDE.md) states the hard rules and the documentation-maintenance contract. This file covers mechanics: how to get the stack running, how to name a branch, what a reviewable pull request looks like, and the two processes — adding an ADR and adding a dependency — that have gates in front of them.

## Local setup

The repository is documentation and scaffolding as of 2026-09-15; application code lands from M0 (starting 2026-09-21). The infrastructure stack runs today.

```sh
# 1. Toolchain
node -v                       # must be 22.x — see .nvmrc; `nvm use` if you have nvm
corepack enable && corepack prepare pnpm@latest --activate
docker compose version        # Compose v2.20+

# 2. Configuration
cp .env.example .env
openssl rand -hex 32          # generate SESSION_SECRET
openssl rand -hex 32          # generate TOKEN_PEPPER
# paste both into .env, replacing the CHANGE_ME placeholders

# 3. Stack
make up                       # postgres, valkey, piston, seaweedfs, mailpit, otel, prometheus, grafana
make ps                       # confirm everything is healthy
make logs S=piston            # Piston pulls language runtimes on first boot; this is the slow part

# 4. From M0 onward
pnpm install
make migrate
make seed
```

`make help` lists everything. Ports and local URLs are in [`README.md`](README.md); container-level detail is in [`infra/README.md`](infra/README.md).

If `make up` fails, the usual causes are a port already bound (5432 and 6379 are the common collisions with a locally installed Postgres or Redis), insufficient memory for Piston, or a `.env` still containing a `CHANGE_ME` placeholder — `packages/config` fails fast at boot rather than starting with a broken secret.

`make migrate` runs from the host against `DATABASE_OWNER_URL`, which defaults to `localhost:5432`. If a locally installed Postgres already owns that port, the migrations are applied to **that** database rather than the stack's, and the command succeeds — nothing warns you. Stop the local Postgres, or set `POSTGRES_PORT` in `.env` and change the port in `DATABASE_OWNER_URL` to match.

## Branches

Branch from `main`. One branch per backlog item.

```
<type>/<tracker-id>-<short-slug>
```

| Type | For |
|---|---|
| `feat` | New user-visible capability |
| `fix` | Defect repair |
| `refactor` | Behaviour-preserving change |
| `docs` | Documentation only |
| `chore` | Tooling, CI, dependencies |
| `test` | Tests only |
| `infra` | Compose, Dockerfiles, deployment configuration |

Examples: `feat/M0-14-question-version-publish`, `fix/M1-07-deadline-sweep-off-by-one`, `docs/M2-03-exec-limits-table`.

The tracker ID is the identifier from [`project/TRACKER.md`](project/TRACKER.md). A branch with no tracker item means the work was not planned; add the item first, even if you add it five minutes before starting.

`main` is protected. It is always deployable, and every change reaches it through a pull request with a passing CI run and at least one approval.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). The type set matches the branch types above, plus `perf`, `build`, `ci` and `revert`.

```
<type>(<scope>): <imperative summary, lower case, no full stop>

<body: what changed and why the alternative was rejected>

<footer: Refs: M0-14 / BREAKING CHANGE: …>
```

Scope is the workspace directory without its prefix: `api`, `worker`, `collab`, `web`, `candidate`, `contracts`, `db`, `core-domain`, `exec-adapter`, `grading`, `auth`, `config`, `observability`, `ui`, `infra`, `docs`, `project`.

```
feat(core-domain): materialise option shuffle order at attempt start

Resolving the draw lazily meant a refresh could re-roll the shuffle, so two
renders of the same attempt disagreed. The order is now written to
attempt_questions at start and read back verbatim. See ADR-004.

Refs: M1-22
```

A `BREAKING CHANGE:` footer is required for any change to a published API shape, an error code's meaning, a queue name, or a database contract another service reads. Commits are squashed on merge; the squash message is the pull request title and body, so write the pull request as if it were the permanent record — it is.

## Pull requests

Keep them small enough to review properly. A pull request that touches more than one milestone's worth of surface is two pull requests.

The template in [`.github/pull_request_template.md`](.github/pull_request_template.md) carries the checklist. It mirrors the Definition of Done:

- [ ] Tests written and passing (`make test`); the new behaviour has a test that failed before the change
- [ ] `make lint` and `make typecheck` clean
- [ ] Contracts updated in `packages/contracts` if any request, response or error shape changed
- [ ] Migration is expand-contract (add nullable → backfill → switch reads → drop old, across deploys)
- [ ] Any new tenant table carries `org_id` and an RLS policy
- [ ] No hidden test-case content, reference solution or `is_correct` flag is reachable from a candidate-scoped response, including error output
- [ ] No proctoring signal drives an automatic reject, void or score adjustment
- [ ] New or changed dependency passes `make licences`
- [ ] `make secrets` passes — any password in a fixture, test or example must look fake on sight
- [ ] `code-graph.json` updated and `make graph` re-run if a service boundary, package, queue or external dependency changed
- [ ] [`project/TRACKER.md`](project/TRACKER.md) and [`project/STATUS.md`](project/STATUS.md) updated for any completed item
- [ ] [`project/MILESTONES.md`](project/MILESTONES.md) updated if an exit criterion was met
- [ ] New ADR added for any decision expensive to reverse; no accepted ADR edited in place
- [ ] Any answered open question moved out of [`project/OPEN-QUESTIONS.md`](project/OPEN-QUESTIONS.md) into its owning doc
- [ ] `**Last updated:**` bumped on every document touched (`make docs-check` passes)
- [ ] Every `H-NNN` mentioned is a real tracker row, and any new task was added there first
- [ ] New env var present in `.env.example`, `docker-compose.yml`, `packages/config` and [`docs/13-environments-and-release.md`](docs/13-environments-and-release.md)

The full version is [`project/DEFINITION-OF-DONE.md`](project/DEFINITION-OF-DONE.md).

Unchecking a box is fine when it does not apply; deleting it is not. A reviewer needs to see that you considered it.

## Review expectations

**As an author.** Describe the problem before the solution, and say what you rejected. Link the tracker item and any ADR the change depends on. If the change touches attempts, execution, tenancy, proctoring or scoring, say explicitly in the description which of the hard rules in [`CLAUDE.md`](CLAUDE.md) you checked against — reviewers will ask otherwise. Respond to every comment, including the ones you disagree with; "no, because X" is a complete answer.

**As a reviewer.** First pass is correctness against the specification: does this match [`docs/03-API-spec.md`](docs/03-API-spec.md), the schema, and the relevant ADR. Second pass is the leak surface: could any of this reach a candidate response. Third pass is style, and style comments are suggestions unless they are in the conventions section of [`CLAUDE.md`](CLAUDE.md).

Block on: a hard-rule violation, a missing RLS policy, a destructive migration, a prohibited licence, an untested state transition, or a contract change without a contracts update. Do not block on formatting — `make fmt` settles it.

Target a first response within one working day. A pull request open longer than three working days is an escalation, not a queue.

[`.github/CODEOWNERS`](.github/CODEOWNERS) routes review automatically. Ownership of documents is separate and lives in [`docs/DOC-OWNERSHIP.md`](docs/DOC-OWNERSHIP.md).

## Adding an ADR

An ADR is for a decision that is expensive to reverse: a technology at a boundary, a data-model invariant, a security or legal posture, a contract other systems depend on. A reversible choice inside one package is a code comment, not an ADR.

1. Append to [`docs/04-ADRs.md`](docs/04-ADRs.md). Take the next free number; numbers are never reused, even for a withdrawn ADR.
2. Use the existing structure: a `## ADR-0NN — <decision stated as an assertion>` heading, then context, decision, consequences, and **reversal conditions** — the observable circumstance under which we would change our mind. An ADR without reversal conditions is an opinion.
3. **Never edit an accepted ADR to say something different.** If the decision changes, write a new ADR, mark the old one `Superseded by ADR-0NN`, and link forward from the old and back from the new. The record of what we used to believe is why the ADRs are worth keeping.
4. Link the ADR from the documents it constrains, and from the code that implements it — a comment naming the ADR number at the invariant it enforces is cheap and saves the next person an archaeology session.
5. If the ADR resolves something in [`project/OPEN-QUESTIONS.md`](project/OPEN-QUESTIONS.md), delete it from there in the same change.

ADRs are reviewed by the owner named in [`docs/DOC-OWNERSHIP.md`](docs/DOC-OWNERSHIP.md) for the affected area, not merged by the author alone.

## Adding a dependency

Every dependency is a licence decision and a supply-chain decision, so there is a gate.

1. **Check the licence against the policy** in [`docs/05-licensing-and-compliance.md`](docs/05-licensing-and-compliance.md) §1. Permitted: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, PostgreSQL, Unlicense, CC0. Prohibited anywhere in the tree, including transitively: GPL, LGPL where static linking applies, AGPL, SSPL, BSL/BUSL, Commons Clause, source-available, and anything with a field-of-use restriction.
2. **Check the transitive tree**, not just the top-level package. `pnpm why <pkg>` and `make licences` between them will tell you; the gate fails on transitive violations and that is the point. The two traps this project has already hit are MinIO (AGPL-3.0 — we use SeaweedFS) and Redis after 7.2 (RSALv2/SSPL — we use Valkey 8).
3. **Justify it.** In the pull request, say what it does, why the standard library or an existing dependency does not, its maintenance signal (last release, open critical issues, bus factor), and its install-size and transitive-count cost. "It is popular" is not a justification.
4. **Pin it.** Exact version in `package.json`, lockfile committed. No ranges on anything in the runtime dependency tree.
5. **Run `make licences` locally** before pushing. CI runs `scripts/check-licences.mjs` and fails the build on a violation; do not add an allowlist entry to get past it without the licence owner's sign-off recorded in the pull request.
6. **A dependency at a service boundary updates the graph.** If it is an external system — a database, a queue, an object store, an identity provider — it goes into `code-graph.json` and `make graph` is re-run in the same change.

Grafana is the one AGPL-3.0 component present: it is an operator-run dashboard in `infra/`, never imported, linked or distributed with the product, and nothing in `apps/` or `packages/` may depend on it. Any similar case needs the same explicit carve-out, written down, before it lands.

## Documentation changes

The maintenance contract is the numbered list in [`CLAUDE.md`](CLAUDE.md) under "Keeping the docs true". Mechanically:

- Every document opens with an H1, then `**Status:**`, `**Owner:**`, `**Last updated:**`, `**Companion docs:**`, then a `---` rule.
- Bump `**Last updated:**` to the date of your change on every document you touch. `make docs-check` and CI both enforce it, and a local `PostToolUse` hook warns you first.
- Relative links only. `scripts/check-links.mjs` fails on a broken one.
- Cite a task id, never invent one. Ids live in [`project/TRACKER.md`](project/TRACKER.md); if the work is not a row there, add the row in the same change. `scripts/check-task-ids.mjs` fails on a reference to an id the tracker does not hold.
- British spelling, plain declarative prose, absolute ISO dates, no bare "TBD" — write "TBD — owner: `<role>`, decide by `<absolute date>`".
- `CODE-GRAPH.md` is generated. Edit `code-graph.json` and run `make graph`.

## Security issues

Do not open a public issue for a vulnerability in this platform — sandbox escape, tenant isolation failure, token forgery, or a leak of hidden test-case content. Report it to the security owner named in [`docs/DOC-OWNERSHIP.md`](docs/DOC-OWNERSHIP.md), privately, with reproduction steps. The threat model and the classes of attack we expect are in [`docs/14-threat-model.md`](docs/14-threat-model.md).
