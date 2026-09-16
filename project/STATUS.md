# Status

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-17
**Companion docs:** [`MILESTONES.md`](MILESTONES.md), [`TRACKER.md`](TRACKER.md), [`RISKS.md`](RISKS.md), [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md)

---

**Last reviewed:** 2026-09-17 · **Next review:** 2026-09-25
**Cadence:** updated every Friday by the engineering lead, and at every milestone close as part of the ritual in [`MILESTONES.md`](MILESTONES.md). One screen, always. If it needs two, the detail belongs in the tracker.

| | |
|---|---|
| **Current milestone** | M0 Question bank — P1 complete, P2 three of six tracks complete |
| **Next milestone** | M1 Async MCQ assessment, phase P3 |
| **Overall RAG** | amber |
| **Build** | green — CI, Security, Docs and Licences all passing on `main` since 2026-09-17, the first green run; **2,295 tests**, 0 failing, 0 skipped |
| **Schedule** | amber — ahead of the re-baselined plan (P0 and P1 are complete before their planned start of 2026-09-21), but the 25-week baseline is still unsigned (OQ-015) and build pace so far says little about the judgement-heavy phases ahead |
| **Scope** | green — no changes to PRD §6 |
| **Risk** | amber — eight high risks open, three of them the same question-bank problem (R-03, R-04, R-13) |
| **Staffing** | red — M3 assumes a second engineer who is not confirmed (OQ-012, decide by 2026-10-16) |

Amber overall, not green, despite the build: the baseline is unsigned, the second engineer is unconfirmed, and GitHub-native secret scanning is still off.

## Shipped this period (2026-09-15 → 2026-09-17)

**Application code now exists.** 53 of 135 backlog tasks are done, reconciled against the code.

- **P0 foundation** — fourteen workspaces, strict TypeScript, lint-enforced layering, CI enforcing, MPL-2.0 with a header gate, the licence gate proven to fail on a planted AGPL dependency
- **P1 tenancy, identity and audit** — per-checkout org context proven by an interleaved test, RLS proven per table against real Postgres, OIDC and password login, per-action permissions with a route-enumeration test, append-only audit at the database
- **P2 question bank, five tracks** — immutable versions with a database trigger (ADR-003); an audience-typed serialisation boundary where a candidate view that could carry an answer key fails to compile; skills, merging and role coverage that reports a required skill with no questions rather than dropping it; and the kind rule — content a kind can never use is refused on every write, content it still lacks is refused at publish, so an ungradeable question cannot become immutable; and nightly question statistics — difficulty and discrimination against the rest score, not the total, null below 30 responses, computed per tenant under RLS and matched to values computed independently in Python; and job roles with their skill requirements, plus question tagging — every skill id resolved under RLS before it is written
- **Security** — an external scanner flagged realistic-looking fixture passwords on the public repository. None was a real credential. All renamed to look fake on sight, and a new gate enforces it. `docs/14` had claimed history secret scanning was in place; it was not, and now says so
- **Two tenancy defects found and fixed in built code** — a tenant could delete or claim a *global* skill or system role (the policy admitted shared rows to every command; migration 0008), and could tag its questions with another tenant's skill, because PostgreSQL checks foreign keys without RLS. Both proven by tests that failed first; recorded as T-041. The taxonomy routes had also been registered outside `/api/v1` and answered refusals with 500s — they had no HTTP test, and now have 29
- **CI green for the first time** — it had been red since the first push without being checked

## In progress

P2 question bank: import/export (the M0 exit criterion) and the authoring console. The two file formats are built and round-trip every kind exactly — the JSON bank document with full history and attribution, the QTI 2.1 package for the served version; the import job, routes and the database round trip are next.

## Next

1. Finish P2 and close M0 against its exit criterion: 200 questions, tagged to three roles, exported and re-imported without loss.
2. Enable GitHub secret scanning and push protection — both disabled (security lead, by 2026-09-24).
3. Get the schedule baseline signed off (OQ-015).

## Blocked

| What | Blocked on | Owner | Since |
|---|---|---|---|
| M3 dates | Second engineer unconfirmed (OQ-012) | engineering lead | 2026-09-15 |
| Skill taxonomy seed (H-018) | No named owner (OQ-010) | engineering lead | 2026-09-15 |
| ADR-001 reversal analysis | Internal-only determination never written down (OQ-008) | executive sponsor | 2026-09-15 |
| Schedule baseline | Re-baseline from 18 to 25 weeks unsigned (OQ-015) | engineering lead | 2026-09-15 |
| Clean-clone timing (H-135) | Needs a second machine and someone who did not build the repository | engineering lead | 2026-09-17 |

## Key metrics

From [`../docs/01-PRD.md`](../docs/01-PRD.md) §10. Nothing is measurable yet — the platform has no users, no questions and no attempts.

| Metric | Target | Current | Measurement starts |
|---|---|---|---|
| Technical roles run through the platform | ≥ 80% within 2 quarters | not yet measurable | 2026-11-02 |
| Questions authored in-house | ≥ 150 by month 6 | not yet measurable | 2026-10-09 |
| Published questions in the 0.2–0.8 p-value band | ≥ 60% | not yet measurable | 2026-12-01 (needs n ≥ 30 per version) |
| Question discrimination ≥ 0.2 | 70% of the bank | not yet measurable | 2026-12-01 |
| Score vs 90-day manager rating | positive correlation | not yet measurable | 2027-04-01 (90 days after the first hire) |
| Invite sent → score available | < 24 h median | not yet measurable | 2026-11-02 |
| Interviewer time per loop | reduced vs baseline | not yet measurable | 2026-12-24 (needs a baseline; none recorded) |
| Batching during campus drives | zero | not yet measurable | first campus drive — date TBD, owner: recruiting, decide by 2026-10-30 |
| Completion rate of started attempts | ≥ 85% | not yet measurable | 2026-11-02 |
| Candidate satisfaction | ≥ 4/5 | not yet measurable | 2026-11-02 (needs a post-attempt survey; not yet specified) |
| Support tickets per 100 attempts | < 2 | not yet measurable | 2026-11-02 |

Two of these need work before they can be measured at all: the interviewer-time baseline does not exist, and there is no candidate survey. Both are cheap now and impossible retroactively.
