# P1 — Tenancy, identity and audit build plan

**Status:** draft
**Owner:** _unassigned_ (engineering lead)
**Last updated:** 2026-09-15
**Companion docs:** [`ROADMAP.md`](ROADMAP.md), [`P0-FOUNDATION-PLAN.md`](P0-FOUNDATION-PLAN.md), [`../docs/17-engineering-standards.md`](../docs/17-engineering-standards.md), [`../docs/14-threat-model.md`](../docs/14-threat-model.md), [`../docs/04-ADRs.md`](../docs/04-ADRs.md)

---

## The goal, stated precisely

P1 is not "authentication works". It is **one request path, proven end to end**:

> A request arrives carrying a session, resolves to an organisation, passes a per-action permission
> check, reads a row that row-level security scoped, writes an audit entry in the same transaction,
> and returns the standard error envelope when any step fails.

Every feature from P2 onward is a variation on that path. Getting it right once is worth more than
getting five features half-right, and it is the reason P1 exists as its own phase instead of being
absorbed into the question bank.

**Dates:** 2026-10-05 → 2026-10-16, ten working days, one engineer. Entry gate: P0 signed.

---

## Why this cannot wait until it is needed

Three things here are effectively impossible to retrofit, which is the whole argument for spending
two weeks before any feature exists:

| Thing | Why retrofitting fails |
|---|---|
| `org_id` and RLS on every table | Adding tenancy to twenty tables of live candidate data is a migration with a security review attached, and one missed `WHERE` clause in the interim is a cross-tenant leak (ADR-010) |
| Token scope | A credential already issued cannot be narrowed. If an attempt token starts life able to read the bank, every issued token can, until they all expire |
| Audit inside the transaction | An audit log written after the fact records what the application *believed* happened. Written in the same transaction, it records what actually committed |

---

## Day allocation

| Days | Steps | Output |
|---|---|---|
| 1–2 | 1–2 | Org context through the pool, RLS policies live and proven |
| 3–4 | 3 | Staff identity: sessions, password, OIDC |
| 5–6 | 4 | Permissions as data, per-action checks |
| 7 | 5 | Audit log, transactional |
| 8 | 6 | Candidate token model and WS tickets |
| 9 | 7 | The vertical slice test, leak suite grown |
| 10 | 8 | Exit gate, plan-cost measurement, P2 entry review |

---

## Step 1 — Organisation context through the connection pool

`app.current_org` is set **per checkout, inside the transaction that runs the work**, never per
connection. A pooled connection outlives a request; setting it per connection means request B
inherits request A's org, which is the leak this design exists to prevent.

Produces: `withOrg(db, orgId, fn)` promoted from its P0 skeleton to the real implementation, the
pool hook, and an explicit `withElevated(db, reason, fn)` for background jobs using the job role —
which writes its own audit entry every time, because an elevated path with no trail is where
incidents hide.

**Verified by.** A test that runs two interleaved `withOrg` calls on the same pool and asserts
neither sees the other's rows. Interleaving is the case that a naive implementation passes
sequentially and fails under load.

## Step 2 — RLS policies, complete and proven complete

Policies on every `org_id` table, with the **generated** suite from P0 step 7 now running against
real tables and real data rather than a fixture.

The property being established is not "RLS works". It is **"no table was missed, and none can be"**:
the suite enumerates `TENANT_TABLES` from the schema, so a table added in P2 without a policy fails
CI without anyone remembering to add a test.

**Verified by.** The generated suite green; a deliberately added policy-less table failing it; and
`EXPLAIN` output captured for the five hottest queries so plan degradation (`R-09`) is a number
recorded now, not a surprise at P7.

## Step 3 — Staff identity

Sessions, password login, OIDC start and callback, `GET /auth/me`. Better Auth wired directly —
**not** wrapped in an abstraction, per [`../docs/17-engineering-standards.md`](../docs/17-engineering-standards.md):
wrapping a library used exactly once produces the wrong abstraction permanently.

Session cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, rotated on privilege change. Fixation and
CSRF are named threats in [`../docs/14-threat-model.md`](../docs/14-threat-model.md); both get a test.

## Step 4 — Authorisation, per action

Permissions are data, not enum members, so an organisation can define a custom role (FR-27). The
check is a function call at the route, and the test that matters enumerates every registered route
and **fails on any route with no declared permission** — a route that forgot its check is
indistinguishable from a public route, and this is the only way to find it reliably.

## Step 5 — Audit log

Append-only, in the same transaction as the action. If the action rolls back, the audit entry rolls
back with it; if it commits, the entry committed. Records actor, entity, action, and the reason
where a reason is required — voiding, manual score override, elevated job access (FR-21, FR-25).

Not telemetry. It lives in Postgres, is queryable, and is retained seven years
([`../docs/12-observability-and-runbooks.md`](../docs/12-observability-and-runbooks.md) §9).

## Step 6 — Candidate tokens and WS tickets

Promoted from the P0 skeleton to the real flow: invitation token hashed at rest, redeemed exactly
once for an attempt-scoped token; WS tickets single-use with a 60-second life.

Built now, before there is an attempt to scope to, because the token model is a security boundary.

**Verified by.** Timing-safe comparison; a token presented for a different attempt rejected; a
redeemed invitation refused on replay; an expired token rejected against the injected clock.

## Step 7 — The vertical slice, and the leak suite

One integration test walking the whole path in the goal statement above, asserting each stage
including the audit row and the envelope shape on failure.

The leak suite grows its second and third assertions: a candidate-scoped principal cannot reach any
staff route, and no staff-shaped payload appears in any candidate response.

## Step 8 — Exit gate

| Criterion | Verified by |
|---|---|
| The full slice works end to end | The step 7 integration test |
| Cross-org reads return zero rows on every tenant table | Generated RLS suite; a policy-less table fails it |
| Every route declares a permission | Route enumeration test |
| Privileged actions audit, and roll back with a failed transaction | Integration test |
| A candidate token reaches no staff route | Leak suite |
| RLS plan cost is measured and recorded | `EXPLAIN` output committed as evidence |

---

## What P1 deliberately does not build

No question CRUD, no assessment composition, no candidate-facing screen. The temptation is to start
the question bank because it is visible progress and tenancy is not. Resist it: the bank built on an
unproven tenancy spine is the bank that has to be re-tested after the spine changes.

## The two ways this phase fails

1. **RLS declared done when it is merely present.** Present means policies exist. Done means the
   suite proves no table was missed *and* a new table cannot silently skip one. Only the second is
   worth anything.
2. **Auth over-abstracted.** One identity provider, one session store, no plugin architecture, no
   strategy pattern. There is no second implementation and there is no evidence there will be.
