# Hiring workflows — the journeys the product owes

**Status:** draft
**Owner:** _unassigned_ (product lead, with engineering lead)
**Last updated:** 2026-09-20
**Companion docs:** [`01-PRD.md`](01-PRD.md), [`03-API-spec.md`](03-API-spec.md), [`09-ats-integration.md`](09-ats-integration.md), [`16-ai-usage-policy.md`](16-ai-usage-policy.md), [`04-ADRs.md`](04-ADRs.md)

---

## 0. Why this document exists

Everything built so far is correct and almost none of it is reachable. The question bank enforces
immutable versions, the skill taxonomy merges duplicates, job roles carry weighted skill
requirements with difficulty bands, and `GET /job-roles/{id}/coverage` will tell you exactly which
required skill the bank cannot measure — and the console shows a recruiter a list of questions and
a button that says **New question**.

That is the difference between a set of capabilities and a product, and it is the difference a
customer sees first. A recruiter opening this today is asked to think like a question author: find
the questions, judge their difficulty, assemble a set, hope it is fair. Every one of those is a job
the system has the data to do for them, and every one of them done by hand is also a way the bank
degrades — a recruiter who cannot find the question they want writes another one, and a bank fills
with near-duplicates that split a role's coverage and make a score mean less than it did.

This document is the flow the product owes, stated end to end, with what exists marked as existing
and what does not marked with the task that builds it. It is written to be argued with: the point
is that the sequence is decided once and deliberately, rather than one screen at a time.

**What it does not change.** [ADR-011](04-ADRs.md) keeps every model out of the scoring and
decision path, [ADR-007](04-ADRs.md) keeps every signal advisory, and [ADR-009](04-ADRs.md) keeps
questions tagged with skills rather than job roles. §5 is about exactly where that leaves
automation, because the answer is not "nowhere" and is also not "wherever it is convenient".

---

## 1. The shape of the journey

Seven stages. A recruiter should be able to walk them without ever opening the question bank, and
the bank should still be the thing the whole flow rests on.

```
  1. Role              2. Coverage          3. Assessment       4. Invite
  what are you    →    can we measure  →    composed from  →    candidates, from
  hiring for?          it yet?              the role             a list or an ATS
                                                                      │
  7. Decide       ←    6. Read         ←    5. Track        ←──────────┘
  a person, with       percentage,          who is where,
  the evidence         per skill,           what is waiting
                       the evidence
```

The bank sits underneath, fed by import and by authoring, and touched by a recruiter only when the
coverage report says something is missing.

---

## 2. The stages

### 2.1 Role — what are you hiring for?

**The user does:** names the role, or pulls it from the ATS, or pastes the job description.

**The system does:** derives the skills the role needs, with a weight and a difficulty band each,
and holds them as the role's requirement. A JD is a paragraph; a requirement is a list the bank can
be queried with.

**Built.** `job_roles`, `job_role_skills` with `weight`, `min_difficulty`, `max_difficulty` and
`is_required`, and the taxonomy underneath with merge so two spellings of one skill do not split a
role in half. `GET /job-roles`, `POST /job-roles`, `PUT /job-roles/{id}/skills`.

**Built 2026-09-20.** The screen (`H-178`) — `/roles`, one card per role with its requirement and
the verdict on it.

**Missing.** JD as an input (`H-185`), which is where a suggestion engine belongs and where §5
applies. Creating and editing a role from the console: the endpoints exist, the screen reads only.

### 2.2 Coverage — can we measure it yet?

**The user does:** looks at one screen and learns whether this role can be assessed.

**The system does:** counts published questions per required skill *inside the role's difficulty
band*, and names the skills with none. Not a percentage — a list of what is missing and what closes
it.

This is the stage that replaces "go and write some questions". A recruiter is never asked to judge
whether the bank is sufficient; they are told which skill has nothing in band, and offered the two
things that fix it: import a dataset that covers it, or write one question with the skill and band
pre-filled.

**Built.** `GET /job-roles/{id}/coverage` returns `in_band`, `published`, `by_difficulty` per
skill and a `gaps` list. It is advisory by design — the judgement about how thin is too thin
belongs to a person, and it is `POST /assessments/{id}/simulate` (P3) that actually refuses.

**Built 2026-09-20** (`H-178`). Three verdicts rather than a number: **blocked** — a required skill
with nothing published in band, so an assessment cannot be composed at all; **thin** — composable,
but with too few questions to give two candidates meaningfully different papers, which is §3.2's
problem rather than a feasibility one; and **ready**, said plainly, because a screen that only ever
warns is one people learn to ignore. A blocked role offers the bank; a ready one offers the
composition step that P3 builds.

### 2.3 Assessment — composed from the role, not from the bank

**The user does:** chooses a length and a time budget. Confirms.

**The system does:** derives the draw rules from the role — one section per weighted skill, count
proportional to weight, difficulty band from the requirement, recency exclusion so a candidate who
sat a similar assessment last month does not see the same questions. Then runs the feasibility
check *before* asking the user to name the thing, because discovering at save time that a section
cannot be filled is discovering it too late.

**Built.** The draw-rule model is specified (FR-6) and the assessment engine is P3.

**Missing.** All of it (`H-179`). The composition-from-role step is the one that makes the
difference between a builder and a wizard, and it is the reason `H-179` depends on `H-178` rather
than the other way round.

### 2.4 Invite — from a list, a file, or the ATS

**The user does:** pastes addresses, uploads a CSV, or picks candidates already in the ATS.

**The system does:** mints one invitation per candidate with its own token and expiry, sends the
email, and shows the delivery state per row. A resend re-sends the same invitation rather than
minting a second attempt — which is the failure that produces two attempts for one candidate and an
argument about which one counts.

**Built.** The invitation model and `invitations.accommodations` are specified; tokens are a
separate credential domain in `packages/auth` and already tested against every surface they do not
belong to.

**Missing.** Sending from the console (`H-182`) and the email itself (`H-189`). The email is the
first thing the product writes on a customer's behalf to someone outside their company, which is
why it has a row of its own and a preview in it.

### 2.5 Track — who is where

**The user does:** watches a pipeline, filters it, sorts it, and answers "who is waiting on me".

**The system does:** one row per candidate per role, with stage, invitation state, attempt state,
score when there is one, and per-skill score when there is one. Filterable by every one of those and
sortable by any, with the filter in the URL so a view is a link a colleague can open.

**Missing.** Everything (`H-181`). This is the screen a recruiter lives in, and it does not exist.

### 2.6 Read — percentage, per skill, and the evidence

**The user does:** opens a result and understands it in under a minute.

**The system does:** shows the overall percentage, the score per skill against the *role's* required
band, and — behind each number — the questions, the answers, and the version served. A
side-by-side view compares candidates for one role on the same axes.

The comparison **ranks nothing and recommends nothing**. It lines up the same numbers for two
people and stops. That is ADR-011 and it is not a limitation of this release; it is the product
constraint, and §5 explains what it costs and what it buys.

**Built.** The scoring model (FR-20), the immutable version reference that makes a score
explainable years later (ADR-003, ADR-004), and `manual_score` structurally distinct from
`auto_score` so a human override never overwrites a machine number.

**Missing.** The screen (`H-183`).

### 2.7 Decide — a person, with the evidence

**The user does:** advances or rejects, and records why.

**The system does:** writes an `audit_log` row naming the actor, the entity and the reason, and
emits the domain event the webhook layer carries back to the ATS.

This stage has no automation in it and will not acquire any. FR-23 and ADR-007 make it a product
constraint with legal exposure attached, not a configuration option.

---

## 3. The three mechanisms the flow rests on

### 3.1 Skills, not roles — and why that is what makes this work

[ADR-009](04-ADRs.md) tags questions with skills and derives role relevance through the taxonomy.
The flow above is the payoff: one question tagged `sql.window-functions` serves every role that
needs it, and a new role is a new *requirement* rather than a new set of questions. A bank tagged
with job titles would need re-tagging for every role a customer invents, and would make the coverage
report in §2.2 impossible to compute.

### 3.2 Different questions per candidate, comparable difficulty across them

Two candidates for one role must not sit the same paper — one tells the other — and must not sit
papers of different difficulty, or the comparison in §2.6 is meaningless and the decision built on
it is indefensible.

The draw is per attempt and materialised at start (ADR-004, FR-7), so the two requirements are:
select different questions, and balance the sets.

Balanced on what is the interesting part, and the honest answer changes over time:

- **Before a question has been answered 30 times**, the only difficulty available is the one the
  author declared, which is a judgement. Sets are balanced on declared difficulty and the product
  says so rather than implying a precision it does not have.
- **After n ≥ 30**, `question_stats` carries an observed p-value and a discrimination index per
  version (FR-5, built). Balancing on observed p-value is the real thing, and it is strictly better
  than an author's guess because it is measured on this population.

`H-180` builds the draw and asserts parity across a simulated cohort, because "comparable" is a
claim that has to be tested rather than asserted. It is P0 for a reason: a fairness property nobody
tested is a fairness property you find out about in a tribunal.

### 3.3 A bank that does not fill with near-duplicates

The user's objection to manual authoring is right and the mechanism is worth naming: a recruiter who
cannot find the question they want writes a new one. Do that for a year and a role's coverage is
split across four phrasings of the same question, the exposure count on each is a quarter of the
truth, and the statistics in §3.2 never reach n ≥ 30.

Three defences, in the order they bite:

1. **Nobody hunts for questions.** §2.2 and §2.3 mean the common path never asks a recruiter to
   search the bank at all. This is the one that matters; the other two are for what leaks through.
2. **`external_ref` is unique per source.** Built — re-importing a dataset updates rather than
   duplicating.
3. **A near-duplicate check on import and on save** (`H-184`): a normalised fingerprint of the
   prompt plus a shingled similarity comparison, surfaced as *"this looks like question X"* with the
   author deciding. Never an automatic merge — a false positive that silently discards somebody's
   question is worse than the duplicate it prevented.

---

## 4. What comes in from outside

### 4.1 Job descriptions

A JD is the input a hiring manager already has, and asking them to re-express it as a skill list is
asking them to do the system's work. `H-185` takes a pasted or pulled JD and proposes the skills it
implies, from the existing taxonomy, with a confidence per suggestion.

**It proposes. A person approves.** The output is a pre-filled form, not a saved role. This is
inside [`16-ai-usage-policy.md`](16-ai-usage-policy.md)'s allowed surface — drafting assistance with
a human publisher — and outside ADR-011's prohibition, which is about the scoring and decision path.
The distinction is not a technicality: a wrong skill suggestion that a human approves is a human's
mistake, made visible and correctable; a wrong score is a candidate's rejection.

### 4.2 Candidates and resumes, from the ATS

[ADR-019](04-ADRs.md) settled the architecture — a generic webhook layer as the substrate, vendor
connectors as thin adapters above it — and left the first target open as OQ-013, which is now
answered: **Ceipal and Bullhorn**, both staffing-agency systems, which also tells us the first
market is agencies rather than in-house teams.

ADR-019 is about events going **out**. Pulling requisitions and candidate records **in** is a
direction it did not decide, and [ADR-023](04-ADRs.md) decides it: a scheduled ingestion above the
same event contract, with the vendor's stage vocabulary mapped to `applications.stage` in the
adapter and never in the domain. `H-186` builds the ingestion, `H-187` and `H-188` the two adapters
— Bullhorn second on purpose, so the interface is proven by two rather than shaped by one.

A resume arrives as an attachment with a retention clock from the moment it lands
([`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md)). It is evidence a human reads. It
is not an input to a score, and nothing in the scoring path may read it.

---

## 5. Where automation is allowed, and where it is not

This section exists because "use AI for analysis" is a reasonable-sounding request that spans a line
the product cannot cross, and the useful answer is neither "yes" nor "no" but *where*.

**Allowed, and worth building:**

| Use | Why it is allowed |
|---|---|
| JD → suggested skills, human-approved (`H-185`) | A pre-filled form. A person saves the role. |
| Drafting a question's prompt, options or explanation for an author | The author publishes it, and publishing is a separate permission with review. |
| Summarising a candidate's own written answer *for a reviewer to read* | It produces prose a human reads beside the answer, not a number. The answer stays on screen. |
| Suggesting which questions would close a coverage gap | A search result. The recruiter chooses. |
| Detecting near-duplicate questions (`H-184`) | Operates on the bank, not on a candidate. |

**Not allowed, at any confidence, behind any flag:**

| Use | Why not |
|---|---|
| Producing or adjusting a score | ADR-011, invariant 4. `packages/grading` is pure and performs no I/O; a structural test asserts it. |
| Ranking or shortlisting candidates | ADR-011. The comparison in §2.6 lines up numbers and stops. |
| Drafting an advance/reject recommendation | ADR-011. A recommendation is a decision with a disclaimer on it. |
| Acting on a proctoring signal | ADR-007, invariant 6. Signals raise a flag for a human. |
| Reading a resume into anything that affects an outcome | §4.2. This is where hiring discrimination claims start. |

The second table is not reviewer judgement. Softening either of the first two rows requires a new
ADR superseding ADR-011 or ADR-007, a conversation with counsel, and an entry in
[`../project/RISKS.md`](../project/RISKS.md) as R-17 — the process is written down in
[`../.claude/rules/invariants.md`](../.claude/rules/invariants.md) precisely so that it cannot be
softened by someone in a hurry.

**What the constraint costs.** A competitor will demo an AI that ranks a shortlist, and it will look
better in twenty minutes than a product that refuses to. What it buys is a score that can be
defended line by line, years later, against a candidate's lawyer — every question, the exact version
served, the answer, the comparison, and the human who decided. The EU AI Act classifies employment
screening as high-risk, and a scoring path with no model in it is not a compliance burden we carry;
it is the reason the compliance burden is small.

---

## 6. Sequence

Dependency order, not a schedule. The dates are in [`../project/ROADMAP.md`](../project/ROADMAP.md).

1. **`H-178` Roles and coverage.** The smallest change that turns the console from a bank browser
   into a hiring tool, and it needs no new server work — the endpoint is built.
2. **`H-184` Near-duplicate detection.** Cheap, and it protects the asset everything else rests on.
3. **`H-179` → `H-180`** Compose from a role, then the draw with parity. These are one piece of work
   in two halves and the second is the one with the legal exposure.
4. **`H-182` → `H-189`** Invite, and the email that carries it.
5. **`H-181` → `H-183`** The pipeline, then the result. In that order: knowing who is waiting is
   worth more than a prettier view of one result.
6. **`H-185`** JD in.
7. **`H-186` → `H-187` → `H-188`** ATS ingestion and the two adapters.

Steps 1 and 2 are startable today against endpoints that already exist. Everything from 3 onwards
waits on the assessment engine (P3).

---

## 7. How this document is maintained

It describes intent, so it changes when intent changes, and every stage names the tasks that build
it. When a task in §2 or §6 reaches done, the stage's **Missing** line moves to **Built** with the
date — a flow document whose "missing" list is stale is worse than none, because it is the document
somebody reads to decide what to build next.

A new stage or a reordering is a change to §6 and to the tracker in the same diff. A change to §5 is
an ADR first.
