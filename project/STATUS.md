# Status

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`MILESTONES.md`](MILESTONES.md), [`TRACKER.md`](TRACKER.md), [`RISKS.md`](RISKS.md), [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md)

---

**Last reviewed:** 2026-09-15 · **Next review:** 2026-09-25
**Cadence:** updated every Friday by the engineering lead, and at every milestone close as part of the ritual in [`MILESTONES.md`](MILESTONES.md). One screen, always. If it needs two, the detail belongs in the tracker.

| | |
|---|---|
| **Current milestone** | M-1 Foundation (2026-09-15 → 2026-09-18) |
| **Next milestone** | M0 Question bank, starts Monday 2026-09-21 |
| **Overall RAG** | amber |
| **Schedule** | green — M-1 on track, M0 starts on the planned date |
| **Scope** | green — no changes to PRD §6 |
| **Risk** | amber — eight high risks open, three of them the same question-bank problem (R-03, R-04, R-13) |
| **Staffing** | red — M3 assumes a second engineer who is not confirmed (OQ-012, decide by 2026-10-16) |

Amber overall because the plan is sound and the delivery capacity behind it is not yet confirmed.

## Shipped this period (2026-09-15)

Documentation, infrastructure configuration and process only. **No application code exists in this repository.**

- Repo root identity, canonical `.env.example`, `Makefile`, contributor guide
- Dev and production docker stacks on the canonical ports; Caddy, OTel, Prometheus, Grafana configuration
- ADR-012 closing the Node-vs-Python question left open in HLD §5, plus ADR-013 through ADR-019
- Design docs 06–16: testing, load and capacity, i18n, ATS, certification, retention and DPIA, observability, environments, threat model, accessibility, AI usage policy
- Project management layer: milestones, 109-task backlog, 20-entry risk register, open questions, definition of done, glossary
- CI workflows and the licence gate script (ADR-001); code graph and its generator

## Next

1. Stand up the pnpm workspace and get all thirteen packages compiling empty (H-011 → H-013). This is the only thing between here and M0 starting on code rather than on scaffolding.
2. Appoint the question bank owner before the starter taxonomy is seeded (OQ-010, decide by 2026-09-25).
3. Begin M0: schema sections 1–4, RLS with per-table negative tests, question version lifecycle.

## Blocked

| What | Blocked on | Owner | Since |
|---|---|---|---|
| M3 dates in [`MILESTONES.md`](MILESTONES.md) | Second engineer unconfirmed (OQ-012) | engineering lead | 2026-09-15 |
| Skill taxonomy seed (H-018) | No named owner (OQ-010) | engineering lead | 2026-09-15 |
| ADR-001 reversal analysis | Internal-only determination never written down (OQ-008) | executive sponsor | 2026-09-15 |
| Licence gate verification (H-039) | No `pnpm-lock.yaml` exists to grade | engineering lead | 2026-09-15 |

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
