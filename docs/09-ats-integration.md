# ATS integration

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`01-PRD.md`](01-PRD.md), [`02-HLD.md`](02-HLD.md), [`03-API-spec.md`](03-API-spec.md), [`04-ADRs.md`](04-ADRs.md), [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md), [`hiring_platform_schema.sql`](hiring_platform_schema.sql), [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md), [`14-threat-model.md`](14-threat-model.md)

---

## 1. The question this document closes

`docs/README.md` lists "ATS integration is webhooks only; no direct connector specified" as a known gap, and PRD open question 2 asks whether to build a generic webhook layer first or a direct connector to whatever we currently use.

**Recommendation: build a generic outbound webhook layer and a thin inbound REST surface first. Build a named connector only when a specific customer with a specific ATS has a specific need that the generic surface cannot meet, and build it as a separate deployable, never inside `apps/api`.**

The argument is maintenance cost, and it is not close.

A webhook layer is written once. Its contract is ours, it changes when we decide it changes, and it fails in one place with one set of semantics we control. A connector is a permanent liability attached to a vendor's roadmap. Greenhouse, Lever, Ashby, Workday, SmartRecruiters and Teamtailor each have their own auth model, their own rate limits, their own pagination idioms, their own idea of what a "candidate" and an "application" are, and their own deprecation schedule. Every one of those changes without asking us. Six connectors is not six times the work of one — it is six independent on-call surfaces, six sets of credentials to store and rotate, six mappings from our domain model to theirs that drift, and six sources of "the integration is broken" tickets where the fault is upstream and the customer does not care.

There is a second argument, which is that a connector built before a customer exists is built against a guess. The interesting question is never "can we call the Harvest API" — we can, it is a REST API — it is "what does this customer's recruiting workflow actually need pushed where, and at which stage". That is discoverable only from a real pipeline. A generic webhook layer lets the first three customers integrate with an afternoon of their own engineering time, and what they build tells us which connector is worth owning.

The refinement that makes this work is that our webhook contract must be **good enough that a customer's integration engineer never needs to ask us a question**: complete payloads, stable event names, real signing, honest delivery semantics, and a deliveries UI they can debug against without opening a support ticket. A mediocre webhook layer forces connectors. A good one defers them indefinitely.

### Scope by milestone

| Capability | Lands | Notes |
|---|---|---|
| Outbound webhooks: subscription CRUD, signing, retry, DLQ, deliveries view | M1 | `invitation.sent`, `attempt.started`, `attempt.submitted`, `attempt.finalised` |
| Inbound REST: candidate, application, invitation creation with idempotency and `external_ref` | M1 | Same endpoints staff use, with a service credential |
| Coding and integrity events on the same bus | M2 | `attempt.flagged` becomes meaningful in M4 |
| Session and scorecard events | M3 | |
| First named connector | Post-M4, demand-driven | Separate deployable, see §11 |

---

## 2. Integration model

Two directions, deliberately asymmetric. Inbound is a normal authenticated REST call into the same API staff use. Outbound is an event bus we own. Nothing in the ATS's shape leaks into the domain model in either direction.

```mermaid
flowchart LR
    subgraph ATS["Customer ATS (Greenhouse / Lever / Ashby / ...)"]
        A1[Candidate record]
        A2[Job / requisition]
        A3[Stage automation]
    end

    subgraph GLUE["Customer glue OR our connector (separate deployable)"]
        G1[Inbound caller]
        G2[Webhook receiver]
    end

    subgraph AB["Assaybank"]
        API["apps/api<br/>the only writer of domain tables"]
        WQ["apps/worker<br/>BullMQ webhook queue"]
        DB[("PostgreSQL 16")]
        EG["Egress proxy<br/>SSRF-guarded"]
    end

    A3 -->|"candidate reaches<br/>Assessment stage"| G1
    G1 -->|"POST /candidates<br/>POST /applications<br/>POST /invitations<br/>Idempotency-Key + external_ref"| API
    API --> DB
    API -->|"enqueue webhook_deliveries"| WQ
    WQ --> EG
    EG -->|"POST customer URL<br/>X-Assaybank-Signature"| G2
    G2 -->|"write score back,<br/>advance stage"| A3
    G2 -.->|"optional read-back<br/>GET /attempts/{id}/report"| API
```

Three properties of this shape are load-bearing:

1. **The ATS never reaches the database and never gets a special code path.** Inbound integration uses the endpoints in [`03-API-spec.md`](03-API-spec.md) §6, authenticated as a service principal with a restricted permission set. A bug in integration handling cannot be a bug in domain-write handling, because there is only one write path.
2. **Outbound delivery is a worker concern, never a request concern.** The API writes a `webhook_deliveries` row inside the same transaction that produces the event and enqueues a BullMQ job. A slow or dead customer endpoint cannot slow an attempt submission. This is the same reasoning as ADR-008.
3. **All egress goes through one guarded path.** Customer-supplied URLs are attacker-supplied URLs (§12). Exactly one component in the system makes outbound HTTP to an arbitrary host, and it is hardened.

---

## 3. Outbound event catalogue

Expands [`03-API-spec.md`](03-API-spec.md) §12. All events share one envelope.

### 3.1 Envelope

```json
{
  "event_id":   "evt_01JBQ8X2M7ZK4T9N6S3W5H2D1F",
  "event_type": "attempt.finalised",
  "occurred_at":"2026-11-03T14:22:09.184Z",
  "sequence":   918342,
  "org_id":     "3f2a...",
  "api_version":"2026-10-01",
  "livemode":   true,
  "data":       { }
}
```

| Field | Meaning |
|---|---|
| `event_id` | ULID, stable across every retry of the same event. **The consumer's idempotency key.** |
| `event_type` | Stable string. Never renamed; a rename is a new event plus a deprecation of the old one |
| `occurred_at` | When the domain fact happened, not when we attempted delivery |
| `sequence` | Monotonic per `org_id`, from a Postgres sequence. Lets a consumer detect gaps and order out-of-order arrivals |
| `org_id` | Tenant, so a consumer integrating several tenants can route |
| `api_version` | Dated payload contract. Pinned per webhook subscription; see §3.4 |
| `livemode` | `false` for events produced by `POST /webhooks/{id}/test` and by non-production environments |

`data` always contains fully-expanded objects, not bare IDs. A consumer should not have to call back to act on an event; the read-back path in §2 exists for detail, not for basics. This is the single biggest determinant of whether a customer's integration takes a day or a week.

### 3.2 Catalogue

| Event | Trigger | `data` contains | Carries scores | Ordering guarantee |
|---|---|---|---|---|
| `invitation.sent` | Invitation created and the mail handed to SMTP | invitation (id, `external_ref`, expiry, max attempts, locale, accommodations), candidate, assessment summary, `join_url` | No | Per invitation, precedes all attempt events for it |
| `invitation.expired` | Sweep passes `expires_at` with no attempt started | invitation, candidate, assessment summary | No | Terminal for that invitation |
| `invitation.revoked` | `DELETE /invitations/{id}` | invitation, candidate, actor, reason | No | Terminal for that invitation |
| `attempt.started` | `POST /attempt/start` succeeds; question set materialised | attempt (id, status, `started_at`, `deadline_at`, locale), candidate, assessment, invitation ref, question count | No | First attempt event; precedes every other event for that attempt |
| `attempt.submitted` | Candidate submits, or the sweep expires the attempt | attempt (status `submitted` or `expired`), `submitted_at`, per-section completion counts | **No** — grading has not run | After `attempt.started` |
| `attempt.auto_graded` | Grading workers finish every auto-gradable answer | attempt, `raw_score`, `max_score`, `score_pct`, per-section scores, `needs_human_review` | Yes, provisional | After `attempt.submitted` |
| `attempt.finalised` | Attempt reaches `finalised` | attempt, final scores, `passed`, per-skill breakdown, per-section breakdown, question count, `report_url`, locale, integrity summary | **Yes, authoritative** | After `attempt.auto_graded`. This is the event an ATS acts on |
| `attempt.regraded` | `POST /attempts/{id}/regrade` completes | attempt, previous scores, new scores, actor, reason, `grading_run_id` | Yes, supersedes the prior value | After a prior `attempt.finalised` |
| `attempt.voided` | `POST /attempts/{id}/void` | attempt, actor, reason, prior status | Scores present but marked void | Terminal for that attempt |
| `attempt.flagged` | Integrity review queue receives the attempt | attempt, integrity event summary by type with counts and timestamps, reviewer queue link | No | May precede or follow `attempt.finalised` |
| `attempt.integrity_reviewed` | A human closes the integrity review | attempt, reviewer, outcome, reason | No | After `attempt.flagged` |
| `session.scheduled` | `POST /sessions` | session, `room_code`, `join_url`, `scheduled_at`, participants | No | First session event |
| `session.started` | First participant joins | session, actual start, participants | No | After `session.scheduled` |
| `session.ended` | `POST /sessions/{id}/end` or timeout | session, duration, participants, `replay_url` | No | Terminal for that session |
| `scorecard.submitted` | `POST /scorecards/{id}/submit` | scorecard, template, criterion ratings with anchors, overall, reviewer | Yes, human ratings | After the session or attempt it belongs to |
| `candidate.erased` | Retention sweep or `DELETE /candidates/{id}` completes erasure | candidate id, `external_ref`, `erased_at`. **No PII** | No | Terminal for that candidate |

Notes that matter to a consumer:

- **`attempt.finalised` is the one to build on.** `attempt.auto_graded` exists so a dashboard can show a provisional number, but it fires before human review of subjective answers and before any override. An ATS that advances candidates on `auto_graded` will advance some of them wrongly.
- **Scores can change after finalisation.** `attempt.regraded` and `attempt.voided` are not edge cases; FR-21 makes manual override a first-class feature. A consumer that treats `attempt.finalised` as immutable will show a stale score forever. The documented obligation is: apply the event with the highest `sequence` for a given attempt.
- **Nothing in any payload constitutes a decision.** Consistent with ADR-007 and FR-23, `attempt.flagged` carries evidence and counts, never a verdict, and no event carries a recommendation. `passed` on `attempt.finalised` is the mechanical result of `score_pct >= pass_score_pct`, which is a threshold the customer set, not a judgement we made. An ATS automation that auto-rejects on `passed: false` is the customer's decision inside their own system; we neither encourage it nor can prevent it, and the integration guide says so plainly.
- **`candidate.erased` deliberately carries no PII**, because it is often delivered to a system that is the reason the erasure is happening. It exists so a downstream copy can be erased too. See §13.

### 3.3 Ordering

Guaranteed: events for a single entity (an attempt, an invitation, a session) are **enqueued** in causal order, and `sequence` is monotonic per org.

Not guaranteed: **arrival** order. Delivery is concurrent across entities, and a retry of event N can land after event N+1. The consumer's obligation is to order on `sequence` per entity and to ignore an event whose `sequence` is lower than one already applied for that entity. This is stated explicitly rather than hidden, because a consumer that assumes ordered arrival breaks in exactly the case that matters — a transient failure on `attempt.submitted` delivering after `attempt.finalised`.

Per-entity FIFO delivery is achievable with a BullMQ group key on the entity ID, and is a candidate improvement if consumer feedback demands it. It costs throughput and it does not remove the consumer's need to be idempotent, so it is not in the M1 scope.

### 3.4 Payload versioning

`api_version` is a date string pinned per webhook subscription at creation time. Rules:

- **Additive changes are not versioned.** New fields may appear in any payload at any time. Consumers must ignore unknown fields; the integration guide says this in the first paragraph.
- Removing a field, renaming a field, changing a type, or changing the meaning of a value requires a new `api_version`. Existing subscriptions keep receiving the old shape until explicitly migrated via `PATCH /webhooks/{id} {api_version}`.
- At most two versions are supported concurrently. Deprecation is announced, dated, and surfaced in the deliveries UI on every affected subscription.
- Adding a new `event_type` is additive. A subscription only receives the events it subscribed to, so a new event is silent for existing consumers.

---

## 4. Signing

HMAC-SHA256, and the detail matters because the two common failure modes — signing the parsed body, and omitting the timestamp — both produce a signature scheme that looks fine and defends nothing.

### 4.1 What is signed

The signed string is `{timestamp}.{raw_request_body}`, where `timestamp` is Unix seconds and `raw_request_body` is the exact bytes on the wire.

```
signed_payload = timestamp + "." + raw_body_bytes
signature      = hex(HMAC_SHA256(key = webhook_secret, message = signed_payload))
```

Signing the **raw bytes** rather than a re-serialisation is the rule. JSON key order, unicode escaping and whitespace all differ between serialisers; a consumer that parses and re-serialises before verifying will get a mismatch and will conclude our signing is broken. Every consumer framework that makes raw-body access awkward (Express with `express.json()` applied globally is the classic) needs this called out, and the integration guide does.

Including the **timestamp inside** the signed string is what makes it a replay defence. A timestamp sent in a header but not signed can be rewritten by whoever captured the request.

### 4.2 Headers

```
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: Assaybank-Webhooks/1.0
X-Assaybank-Event-Id: evt_01JBQ8X2M7ZK4T9N6S3W5H2D1F
X-Assaybank-Event-Type: attempt.finalised
X-Assaybank-Delivery-Id: dlv_01JBQ8X9R2C5V8B1N4M7K0J3L6
X-Assaybank-Delivery-Attempt: 3
X-Assaybank-Timestamp: 1793368929
X-Assaybank-Signature: v1=8f3c...a91d, v1=2b7e...ccf0
```

- `X-Assaybank-Signature` is a comma-separated list of `scheme=hex` pairs. Multiple `v1` entries appear during secret rotation (§4.4) — one per active secret. A consumer accepts the request if **any** entry verifies.
- The scheme prefix exists so a future algorithm change is expressible without a new header.
- `X-Assaybank-Delivery-Attempt` starts at 1 and is purely informational; it must never influence verification, and a consumer must not treat attempt 1 as more trustworthy than attempt 4.
- `X-Assaybank-Event-Id` duplicates `event_id` in the body so a consumer can dedupe before parsing.
- This header set supersedes the single `X-Signature` header named in [`03-API-spec.md`](03-API-spec.md) §12. That section predates this document and is the one that needs updating.

### 4.3 Tolerance window

**Five minutes.** A request whose `X-Assaybank-Timestamp` is more than 300 seconds from the receiver's clock, in either direction, must be rejected. Our retry schedule (§5) re-signs with a fresh timestamp on every attempt, so a legitimate retry twelve hours later carries a current timestamp and passes. Only a captured-and-replayed request carries a stale one.

Rejecting future-dated timestamps as well as past-dated ones matters: without it, an attacker with a captured request can wait out any window by having originally captured a request from a sender with a fast clock.

### 4.4 Secret rotation

Secrets are per subscription, generated server-side, 32 random bytes hex-encoded, and returned **once** at creation — the same discipline as invitation tokens in [`03-API-spec.md`](03-API-spec.md) §6. The database stores them encrypted at rest; they are not password-hashed, because we need the plaintext to sign.

Rotation is overlapping and never has a cutover moment:

```
POST /webhooks/{id}/secrets/rotate   → { secret: "whsec_...", expires_previous_at: "2026-11-10T00:00:00Z" }
```

1. A second active secret is created. Both are now active.
2. Every delivery is signed with **both** and carries two `v1=` entries.
3. The consumer updates their stored secret at their leisure. Either value verifies, so there is no coordinated deploy and no dropped delivery.
4. At `expires_previous_at` — default 72 hours, configurable — the old secret is retired automatically.
5. `WEBHOOK_SIGNING_SECRET_ROTATION_DAYS` (see the canonical environment variables) drives a scheduled reminder surfaced in the console when a secret exceeds its age policy. It **warns**; it does not force-rotate, because a forced rotation on a customer who is not watching breaks their integration.

At most two secrets are active at once. A rotation started while one is in flight extends the existing overlap rather than creating a third.

### 4.5 Verification, consumer side

Node 22, which is what we can support best:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 300;

/** @param rawBody Buffer - the exact bytes received, NOT a parsed-and-restringified object. */
export function verifyAssaybankWebhook(rawBody, headers, secrets) {
  const timestamp = headers['x-assaybank-timestamp'];
  const header    = headers['x-assaybank-signature'];
  if (!timestamp || !header) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false;   // replay defence

  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);

  const presented = header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => Buffer.from(part.slice(3), 'hex'));

  // Accept if ANY presented signature matches ANY active secret (rotation overlap).
  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(signed).digest();
    return presented.some(
      (sig) => sig.length === expected.length && timingSafeEqual(sig, expected),
    );
  });
}
```

Three things the guide must repeat, because all three are made wrong routinely: use the raw body, use a constant-time comparison, and check the timestamp. A signature check with `===` on hex strings leaks through timing; a signature check without a timestamp check is not a replay defence; a signature check on a re-serialised body simply does not work.

---

## 5. Delivery semantics

### 5.1 At-least-once, and why not exactly-once

Delivery is at-least-once. Exactly-once across a network boundary we do not control is not available: the failure where the consumer commits and the response is lost in transit is indistinguishable, from our side, from the failure where the consumer never received it. We retry, and the consumer dedupes.

Duplicates are therefore **normal traffic, not an incident**. They happen on response timeouts, on worker restarts mid-flight, and on any 5xx that the consumer actually processed before failing to reply.

### 5.2 Retry schedule

A delivery succeeds on any 2xx. Everything else retries, inside a 24-hour window, with exponential backoff and jitter:

| Attempt | Nominal delay after previous | Cumulative |
|---|---|---|
| 1 | immediate | 0 |
| 2 | 10 s | 10 s |
| 3 | 1 min | ~1 min |
| 4 | 5 min | ~6 min |
| 5 | 30 min | ~36 min |
| 6 | 2 h | ~2.6 h |
| 7 | 6 h | ~8.6 h |
| 8 | 12 h | ~20.6 h |
| — | give up at 24 h from first attempt | dead-letter |

Full jitter of ±20% is applied to every delay so that a customer endpoint recovering from an outage does not receive a thundering herd of every queued delivery simultaneously. The `webhooks.deliver` queue carries its own attempt limit of 8 and its own backoff curve, configured on that queue rather than from the global `QUEUE_MAX_ATTEMPTS` (3) and `QUEUE_BACKOFF_MS`, which govern grading jobs. A grading job and a webhook delivery have genuinely different retry economics: a candidate is waiting for one and nobody is waiting for the other.

Response handling:

| Consumer response | Behaviour |
|---|---|
| 2xx | Success. Response body ignored and not stored beyond the first 2 KB for debugging |
| 410 Gone | **Stop immediately.** Disable the subscription, do not retry, notify the org admin. The endpoint is telling us it no longer exists |
| 429 with `Retry-After` | Honour the header if it is within the 24-hour window; otherwise use the schedule |
| 4xx other | Retry on the schedule. A consumer bug that returns 400 for a valid event should not silently lose their data |
| 5xx, timeout, connection error, TLS failure | Retry on the schedule |
| Redirect (3xx) | **Not followed.** Treated as a failure. See §12 |

Timeouts: 10 s to connect, 30 s total. A consumer needing more than 30 s to acknowledge should acknowledge first and process asynchronously, which is the advice in the guide.

### 5.3 Circuit breaking

A subscription with 20 consecutive failures across at least 3 distinct events is marked `degraded`: deliveries continue but at reduced concurrency, and the org admin is notified. At 200 consecutive failures, or 72 hours with zero successes, the subscription is marked `disabled` and new events stop being queued for it. Re-enabling is an explicit action, and the console offers replay of the dead-lettered events from the retention window.

This exists because a customer who deletes their endpoint without telling us otherwise generates unbounded futile load forever.

### 5.4 Dead letters

A delivery that exhausts the 24-hour window moves to `status = 'dead'`. It is not deleted. It is visible in the deliveries view, retains its payload for 30 days, and can be replayed manually:

```
POST /webhooks/{id}/deliveries/{delivery_id}/replay
```

A replay is a **new delivery attempt of the same event** — same `event_id`, same body, new `X-Assaybank-Delivery-Id`, new timestamp, freshly signed. The consumer's idempotency handling makes this safe, which is the point of requiring it.

Dead letters older than 30 days have their payload nulled and their metadata retained, because the payload contains candidate PII and holding it indefinitely in a delivery log would violate the retention policy in [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md).

### 5.5 The consumer's obligation

Stated as a contract, because "be idempotent" without specifics is not actionable:

1. **Dedupe on `event_id`.** Store processed `event_id` values with a TTL of at least 30 days — longer than our 24-hour retry window plus the replay window. Do this **before** doing any work, in the same transaction as the work if possible.
2. **Order on `sequence` per entity.** Apply an event only if its `sequence` exceeds the highest already applied for that attempt or session. Do not order on `occurred_at`; clock precision is not a valid ordering key.
3. **Acknowledge fast, process async.** Return 2xx as soon as the event is durably stored. Do not do the ATS write inside the request.
4. **Ignore unknown fields and unknown event types.** Both appear without notice; both are additive changes.
5. **Verify before parsing.** Signature check on the raw body first, parse second. A consumer that parses untrusted JSON before verification has widened its attack surface for no reason.

---

## 6. Delivery observability

A customer debugging their own integration without our help is the difference between a webhook layer that defers connectors and one that does not.

```
GET  /webhooks                              → subscriptions with health summary
POST /webhooks                              {url, events[], api_version?, description?}
                                            → {id, secret}   secret returned once
PATCH /webhooks/{id}                        {url?, events[]?, api_version?, enabled?}
DELETE /webhooks/{id}
POST /webhooks/{id}/test                    {event_type}   → synthetic event, livemode: false
POST /webhooks/{id}/secrets/rotate          → new secret + overlap window

GET  /webhooks/{id}/deliveries              ?status=pending|delivered|failed|dead
                                            &event_type=&event_id=&from=&to=&limit=&cursor=
GET  /webhooks/{id}/deliveries/{delivery_id}
POST /webhooks/{id}/deliveries/{delivery_id}/replay
GET  /webhooks/{id}/health                  → 24h counts, success rate, p95 latency,
                                              consecutive failures, current state
```

A delivery record shows, for each attempt: timestamp, duration, response status, response headers, first 2 KB of response body, error class for transport failures, the exact request body sent, and the signature headers sent. A customer can copy the body and signature into their own verification code and find their bug in minutes. Response bodies are truncated and scanned for anything that looks like a credential before storage.

Internal observability, feeding [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md):

| Metric | Why |
|---|---|
| `webhook_deliveries_total{event_type,status}` | Volume and failure rate |
| `webhook_delivery_duration_seconds{status}` | Slow consumers are the main queue-depth driver |
| `webhook_queue_depth{queue}` | Backlog, and the first symptom of a stuck egress proxy |
| `webhook_deliveries_dead_total{org_id}` | Per-tenant failure, alertable |
| `webhook_subscriptions_disabled_total` | Circuit breaker firing |
| `webhook_egress_blocked_total{reason}` | §12 blocks. A spike here is a probe, not a bug |

Alerts: dead-letter rate above 1% of deliveries over 15 minutes; queue depth above 5,000 for 10 minutes; any `webhook_egress_blocked_total{reason="private_address"}` increase, which means someone is testing our SSRF defence.

Each delivery carries the originating request's trace context, so an OTel trace runs from the recruiter's click through the attempt lifecycle to the outbound POST.

---

## 7. Inbound direction

Everything an ATS needs to push is already in [`03-API-spec.md`](03-API-spec.md) §6. No integration-specific endpoints are added; an integration is a **credential and a set of permissions**, not a parallel API. The additions below are about identity and safety.

### 7.1 Authentication

Integrations authenticate with a service credential, not a user session:

```
POST /api-keys              {name, permission_keys[], expires_at}   → {id, key}  key shown once
GET  /api-keys
DELETE /api-keys/{id}
```

Presented as `Authorization: Bearer ab_sk_...`. Keys are org-scoped, permission-scoped, expiring, individually revocable, and every action they take is attributed to the key in the audit log. A typical ATS integration key holds `candidate.write`, `invite.send`, `attempt.read` — enough to push candidates and invitations and read results, not enough to touch the question bank. That restriction is the point: an ATS credential that could exfiltrate the question bank is a credential worth stealing.

### 7.2 The three calls

```
POST /candidates        {email, full_name, phone?, source?, external_ref, external_system}
POST /applications      {candidate_id | external_ref, job_opening_id | job_opening_external_ref,
                         external_ref, external_system}
POST /invitations       {assessment_id, application_id, candidate_id, expires_at, max_attempts,
                         opens_at?, locale?, accommodations?, external_ref, external_system}
                        → {id, token, join_url}   token returned once
```

The response to `POST /invitations` carries the plaintext token exactly once (existing rule, §6 of the API spec), and `join_url` is what the ATS writes into its own candidate record or its own outbound email. An ATS that wants us to send the mail omits nothing; an ATS that wants to send its own sets `send_email: false` and uses `join_url`.

Convenience composite, because doing the three calls correctly with idempotency is where integrations get it wrong:

```
POST /integrations/invite   {candidate: {...}, job_opening_external_ref, assessment_id,
                             expires_at, locale?, accommodations?, send_email}
                            → {candidate, application, invitation: {id, token, join_url}}
```

Upserts the candidate by `(org_id, external_system, external_ref)`, upserts the application, creates the invitation, all in one transaction. Idempotent on `Idempotency-Key`. This is the only endpoint in the system that exists purely for integration ergonomics, and it is justified: it converts a three-call sequence with two failure modes into one call with none.

### 7.3 Idempotency and re-sync

Two independent mechanisms that solve two different problems. Both are required; neither substitutes for the other.

**`Idempotency-Key` solves retry.** Already a convention in [`03-API-spec.md`](03-API-spec.md) §2: a mutating request carrying the header returns the original response on replay. Scope is `(org_id, api_key_id, endpoint, key)`, retained 24 hours, and the stored response includes the status code. A replay with the same key but a **different body** returns `409 conflict` with code `idempotency_key_reuse` rather than silently serving the old response — a client bug should be loud.

**`external_ref` solves re-sync.** An ATS that re-runs a nightly sync, or whose glue code is redeployed, will push the same candidate again a week later with a fresh `Idempotency-Key`. Without a stable external identity, that creates a duplicate candidate, a duplicate application, and a second invitation to a candidate who already sat the test. `external_ref` is the ATS's own immutable ID for the record, and a unique constraint on `(org_id, external_system, external_ref)` makes the second push an upsert.

Behaviour on re-push:

| Case | Result |
|---|---|
| Same `external_ref`, same data | `200`, existing record returned, nothing written |
| Same `external_ref`, changed PII (name, phone) | `200`, record updated, change audited |
| Same `external_ref`, changed email | `200`, email updated, audited, and a `candidate.identity_changed` audit entry — this is the case most likely to be a mistake upstream |
| Different `external_ref`, same email | `409 conflict`, code `candidate_identity_conflict`, with both IDs in `details`. **Never auto-merged.** Two ATS records claiming one human is a human decision |
| No `external_ref` at all | Falls back to `(org_id, email)` uniqueness, which already exists in the schema. Accepted but warned against in the guide |
| Same `external_ref`, candidate previously erased under retention | `409`, code `candidate_erased`, so a re-sync cannot resurrect a record a data subject asked to be deleted |

That last row is not a detail. Without it, an ATS with a stale cache silently undoes a GDPR erasure, which is exactly the kind of quiet failure [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md) exists to prevent.

---

## 8. Identity mapping

DDL additions, in the style of [`hiring_platform_schema.sql`](hiring_platform_schema.sql). Planned, not built. `external_system` is carried alongside `external_ref` throughout so one org can run two ATSs during a migration — which happens more often than anyone plans for.

```sql
-- ============================================================
-- SECTION 14: EXTERNAL SYSTEM INTEGRATION
-- external_ref is the other system's immutable ID for a record.
-- It is what stops a re-sync from duplicating a candidate.
-- ============================================================

ALTER TABLE candidates    ADD COLUMN external_system text;   -- 'greenhouse' | 'lever' | 'ashby' | ...
ALTER TABLE candidates    ADD COLUMN external_ref    text;
ALTER TABLE applications  ADD COLUMN external_system text;
ALTER TABLE applications  ADD COLUMN external_ref    text;
ALTER TABLE job_openings  ADD COLUMN external_system text;
ALTER TABLE job_openings  ADD COLUMN external_ref    text;
ALTER TABLE invitations   ADD COLUMN external_system text;
ALTER TABLE invitations   ADD COLUMN external_ref    text;   -- the ATS's own assessment-request ID

CREATE UNIQUE INDEX candidates_external_identity
    ON candidates (org_id, external_system, external_ref)
    WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX applications_external_identity
    ON applications (org_id, external_system, external_ref)
    WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX job_openings_external_identity
    ON job_openings (org_id, external_system, external_ref)
    WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX invitations_external_identity
    ON invitations (org_id, external_system, external_ref)
    WHERE external_ref IS NOT NULL;

-- Service credentials. Hash stored, plaintext shown once, like invitation tokens.
CREATE TABLE api_keys (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            text NOT NULL,
    key_prefix      text NOT NULL,          -- 'ab_sk_7f2a' — shown in the UI for identification
    key_hash        text NOT NULL UNIQUE,
    external_system text,                   -- which integration this key belongs to
    last_used_at    timestamptz,
    expires_at      timestamptz,
    revoked_at      timestamptz,
    created_by      uuid REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_key_permissions (
    api_key_id      uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    permission_key  text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
    PRIMARY KEY (api_key_id, permission_key)
);

-- Outbound subscriptions.
CREATE TABLE webhook_endpoints (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    url                 text NOT NULL,
    description         text,
    event_types         text[] NOT NULL,
    api_version         text NOT NULL DEFAULT '2026-10-01',
    state               text NOT NULL DEFAULT 'active',   -- active | degraded | disabled
    consecutive_failures int NOT NULL DEFAULT 0,
    disabled_reason     text,
    created_by          uuid REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- Two rows may be active at once during rotation. Never more.
CREATE TABLE webhook_secrets (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    secret_encrypted    bytea NOT NULL,     -- encrypted at rest; we need the plaintext to sign
    created_at          timestamptz NOT NULL DEFAULT now(),
    retires_at          timestamptz
);

-- The event, produced once, in the same transaction as the domain fact.
CREATE TABLE webhook_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event_id        text NOT NULL UNIQUE,   -- ULID, the consumer's idempotency key
    event_type      text NOT NULL,
    sequence        bigint NOT NULL,        -- monotonic per org
    entity_type     text NOT NULL,          -- 'attempt' | 'invitation' | 'session' | 'scorecard'
    entity_id       uuid NOT NULL,
    payload         jsonb NOT NULL,
    occurred_at     timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, sequence)
);

-- One row per (event, subscription). Attempts are appended to attempts_log.
CREATE TABLE webhook_deliveries (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    webhook_event_id    uuid NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
    webhook_endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    status              text NOT NULL DEFAULT 'pending',  -- pending|delivered|failed|dead
    attempt_count       int  NOT NULL DEFAULT 0,
    next_attempt_at     timestamptz,
    first_attempt_at    timestamptz,
    delivered_at        timestamptz,
    last_status_code    int,
    last_error          text,
    attempts_log        jsonb NOT NULL DEFAULT '[]',      -- [{at, duration_ms, status, error}]
    payload_purged_at   timestamptz,                      -- PII removed after 30 days
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (webhook_event_id, webhook_endpoint_id)
);

CREATE INDEX ON webhook_deliveries (status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX ON webhook_deliveries (webhook_endpoint_id, created_at DESC);
CREATE INDEX ON webhook_events (org_id, sequence DESC);
CREATE INDEX ON webhook_events (entity_type, entity_id);
CREATE INDEX ON api_keys (org_id) WHERE revoked_at IS NULL;
```

`webhook_events` and `webhook_deliveries` are tenant-scoped and therefore carry `org_id` and get RLS policies like everything else (ADR-010). The worker reads them under `DATABASE_JOB_ROLE`, which is the elevated role ADR-010 already anticipates.

The `UNIQUE (webhook_event_id, webhook_endpoint_id)` constraint is what makes the transactional-outbox pattern safe: the API writes the event and its delivery rows in the domain transaction, then enqueues. If the enqueue fails, a sweep finds `pending` rows with a `next_attempt_at` in the past and re-enqueues them. No event is produced without a delivery row, and no delivery row is produced twice.

---

## 9. Target comparison

Assessed for a future connector decision. Effort is a rough engineer-week estimate for a **bidirectional** connector — push candidates in, push results back, handle stage advancement — including error handling, credential storage, and a test suite against the vendor's sandbox, but excluding certification or marketplace listing.

| ATS | Auth model | Rate limits | Direction supported | Partner/assessment pattern | Connector effort |
|---|---|---|---|---|---|
| **Greenhouse** (Harvest API) | HTTP Basic with a per-customer API key; `On-Behalf-Of` header identifies the acting user | Documented per-key throttle in the low tens of requests per rolling window; 429 with retry guidance | Both. Harvest for read/write; Ingestion for events out of Greenhouse | Yes — a defined take-home-test / assessment partner flow where Greenhouse requests a test and the partner posts back a status and score | 3–4 weeks |
| **Lever** | API key over Basic for customer-owned integrations; OAuth 2.0 for partner apps | Per-key request-rate cap with 429; bulk reads need pagination discipline | Both. Postings, opportunities, stages readable and writable; native webhooks out | Partner integration programme; assessment results attach to an opportunity | 3–4 weeks |
| **Ashby** | API key over Basic; webhooks out with their own signing | Generous relative to peers; documented per-endpoint | Both. Strong, well-shaped REST surface | Yes — an assessment-partner pattern with a defined request/result cycle | 2–3 weeks |
| **SmartRecruiters** | OAuth 2.0 for marketplace apps; API key for customer-owned | Per-app quota; marketplace apps have their own tier | Both, plus a formal Marketplace listing path | Yes — an explicit Assessment partner API: SmartRecruiters requests, partner returns score and report URL | 4–5 weeks including marketplace review |
| **Teamtailor** | Bearer API token, versioned via an `X-Api-Version` header | Per-token limit, 429 with `Retry-After` | Both. JSON:API-shaped, so pagination and relationships are consistent | Partner integrations exist; assessment pattern less formalised | 2–3 weeks |
| **Workday** (Recruiting) | OAuth 2.0 against a tenant-specific endpoint, or SOAP for older surfaces; per-tenant configuration by the customer's Workday admin | Tenant-dependent; effectively negotiated per customer | Both, but every field mapping is tenant-configurable | Yes, but through a partner/certification programme with a long lead time | 8–12 weeks, and the long pole is the customer's Workday team, not ours |

The specific rate-limit numbers are the thing most likely to be stale here and none of them should be hard-coded from this table. TBD — verify auth models, current rate limits and partner-programme requirements against each vendor's live documentation before committing to any connector, owner: whoever owns the first connector, decide by the connector's own kickoff.

Reading of the table:

- **Ashby and Teamtailor are the cheapest first connectors.** Modern REST, sane auth, consistent pagination.
- **Greenhouse is the most likely to be asked for**, because it has the largest share among the engineering-led companies this product targets, and its assessment-partner flow is the closest fit to what we do.
- **Workday is a different category of project.** Its cost is organisational, not technical, and it should only be attempted against a contract that funds it.
- **Every one of them supports both directions**, which is the finding that most supports the recommendation in §1. There is nothing a connector can do that a customer's own glue against our webhooks and REST surface cannot, except do it without the customer writing code. That convenience is real and it is worth money, but it is not worth pre-building.

---

## 10. The assessment-provider pattern

Several of these ATSs offer a partner shape specifically for assessment vendors, and it is consistent enough across them to design toward. Stripped of vendor naming, it is:

```mermaid
sequenceDiagram
    participant R as Recruiter in ATS
    participant A as ATS
    participant M as Assaybank
    participant C as Candidate

    R->>A: Move candidate to "Assessment" stage,<br/>pick a test from a list
    A->>M: 1. GET catalogue of available assessments
    M-->>A: [{id, name, duration, job_role}]
    A->>M: 2. POST request: candidate + chosen assessment
    M-->>A: {request_id, status: "pending", join_url?}
    M->>C: invitation email (or the ATS sends it)
    C->>M: sits the assessment
    M->>A: 3. POST status update: started
    M->>A: 4. POST result: score, pass/fail, report URL
    A->>R: score visible on the candidate record
    R->>M: 5. opens report URL (SSO or signed link)
```

Five obligations fall out, and matching them shapes our generic API in ways that cost nothing now and save a connector rewrite later:

1. **A listable catalogue.** The ATS shows a recruiter a dropdown of our assessments. `GET /assessments?status=published` already returns this; the requirement is that it be callable with an API key holding only `assessment.read`, and that the response carry `duration_seconds`, `job_role`, and a human-readable description without expanding the whole composition. A recruiter picking a test must not be able to read its questions.
2. **A request object with a lifecycle.** The ATS wants one ID it can poll or attach an update to, covering `pending → started → completed | expired | cancelled`. `invitations.external_ref` plus the invitation ID serve this; `GET /invitations/{id}` must return a lifecycle status that maps cleanly onto those five words rather than exposing the eight-state attempt machine (§8 of the API spec) that no ATS models.
3. **Status updates, not just a final result.** `attempt.started` and `attempt.submitted` exist for precisely this. A recruiter watching a candidate who never started needs to see "invited, not started" in the ATS, not silence.
4. **A result with a URL, not just a number.** `attempt.finalised` carries `report_url`. The report must be openable by a recruiter who is authenticated to the ATS and possibly not to us, which means a signed, expiring, read-only report link — scoped to one attempt, no session, revocable, and logged as an access in the audit trail. That link is the deliverable an ATS integration is actually judged on.
5. **A cancellation path.** The ATS may withdraw a candidate. `DELETE /invitations/{id}` revokes the token; if an attempt is in progress it is not voided automatically, because voiding is an integrity action requiring a reason (FR-25) and a withdrawal is not an integrity event.

Designing the generic surface to satisfy these five means a future connector is a translation layer of a few hundred lines rather than a feature project. That is the whole reason this section exists at this stage of the build.

---

## 11. Connector architecture, when one is built

Rules, so that "we built a connector" never means "we changed the core".

- A connector is a **separate deployable** — `services/connector-{vendor}` outside the `apps/` tier — that talks to us over the same public API and credential model any customer would use. It gets no private endpoints and no database access. If a connector needs something, the generic API gains it, and every customer gets it.
- The connector is a **webhook consumer and an inbound caller**. It is not in the request path for any attempt operation. A connector outage delays a sync; it never affects a candidate sitting a test.
- **Credentials for the customer's ATS live with the connector**, encrypted per tenant, and never in the core database. A connector compromise must not be a core compromise.
- **The mapping is data, not code.** Stage names, requisition-to-job-role mapping, and which assessment corresponds to which ATS test ID are per-customer configuration. A connector containing one customer's stage names is a fork waiting to happen.
- Every connector ships a **reconciliation job**: periodically list what the ATS believes and what we believe and report the differences. Event-driven sync drifts; without reconciliation the drift is invisible until a candidate falls through.

---

## 12. Security: outbound requests to customer-supplied URLs

A webhook URL is user input that we make an HTTP request to from inside our network. That is server-side request forgery by construction, and the only question is whether it is controlled. A hostile or merely careless org admin can point a subscription at `http://169.254.169.254/latest/meta-data/`, `http://localhost:5432`, or an internal service, and our worker will dutifully fetch it and show the response body in the deliveries UI — which turns SSRF into a complete read primitive. Cross-reference [`14-threat-model.md`](14-threat-model.md).

Mitigations, layered, because each has a known bypass on its own:

### URL validation, at subscription time

- **HTTPS only in production.** Plain HTTP permitted only when `APP_ENV` is a development environment, so local testing works without weakening the deployed system.
- **Default port only** (443), or an explicit allowlist. No `:22`, no `:5432`, no `:6379`.
- Scheme allowlist. `http`/`https` only — never `file:`, `gopher:`, `ftp:`, `data:`.
- No credentials in the URL (`https://user:pass@host/`), which some HTTP clients interpret in surprising ways.
- Hostname must resolve publicly. Literal IPs are rejected outright; a legitimate webhook endpoint has a DNS name.

### Address-range denylist, enforced at connect time

Rejected destinations, checked against the **resolved** address, both IPv4 and IPv6:

```
0.0.0.0/8         127.0.0.0/8       10.0.0.0/8        172.16.0.0/12
192.168.0.0/16    169.254.0.0/16    100.64.0.0/10     192.0.0.0/24
192.0.2.0/24      198.18.0.0/15     198.51.100.0/24   203.0.113.0/24
224.0.0.0/4       240.0.0.0/4       255.255.255.255/32
::1/128           fc00::/7          fe80::/10         ::ffff:0:0/96   (IPv4-mapped)
2001:db8::/32     64:ff9b::/96      (NAT64 — maps to IPv4 and must be checked as such)
```

IPv4-mapped IPv6 and NAT64 are the two that get missed. An address literal of `::ffff:169.254.169.254` passes a naive IPv6 check and reaches the metadata service.

### DNS rebinding

The classic bypass: the hostname resolves to a public address during validation, then to `169.254.169.254` when the request is actually made, seconds later. Blocking this requires that **the address checked is the address connected to**:

- Resolve the hostname once, check every returned address against the denylist, then **connect to the checked IP directly** with the `Host` header and TLS SNI/verification set to the original hostname. In Node this is a custom `lookup` function on the agent that returns only the vetted address, or a pre-resolved connection.
- Re-validate on every redirect — except that redirects are not followed at all (below), which removes the whole class.
- Cache nothing across the validate/connect boundary; the check and the connection must be the same resolution.

### No redirects

**Redirects are never followed.** A 3xx response is a delivery failure. This removes redirect-to-internal-address entirely, which is the most common SSRF bypass and the hardest to close properly. A customer whose endpoint redirects is told to subscribe to the final URL. This is a small inconvenience that buys a large simplification, and the deliveries UI shows the `Location` header so the fix is obvious to them.

### Egress proxy

All webhook delivery traffic leaves through a dedicated egress proxy with its own network policy. The worker has no general outbound internet route. The proxy enforces the denylist a second time, at a layer the application cannot bypass even with a code bug, and it is the enforcement point for a per-org egress allowlist where a customer wants one. This is also where `EXEC_*`-style resource discipline lives for HTTP: connection caps, total bytes, and a hard timeout.

This is distinct from the execution tier's posture in [`02-HLD.md`](02-HLD.md) §3, where the answer is simply "no egress". Webhooks need egress by definition, so the answer is "one controlled path".

### Response handling

- Read at most 2 KB of response body, then close. A consumer that streams a gigabyte back does not fill our disk.
- Store the response body **only for the org that owns the subscription**, and redact anything matching common credential patterns before storing.
- Never surface the response body anywhere except that subscription's own deliveries view.
- Response headers are stored except `Set-Cookie` and `Authorization`.

### Other hardening

- Per-org concurrency and rate caps on delivery, so one tenant's fan-out cannot starve another's.
- Verify the subscription URL on creation with a challenge: we POST a signed test event and require a 2xx before the subscription becomes `active`. A URL nobody controls cannot be subscribed.
- Webhook payloads contain candidate PII and go to a customer-chosen destination. Creating or editing a subscription requires `org.admin`, is audited with the actor and the URL, and notifies the org's other admins. An attacker with a lesser credential must not be able to add an exfiltration endpoint quietly.

---

## 13. Data protection

Candidate PII crossing into a third party is a processing event with legal consequences, and the integration design has to reflect that rather than assume the customer will handle it.

**Controller and processor.** For candidate data in an assessment run for a hiring organisation, that organisation is the **controller** — it decides why and how the data is processed. We are a **processor** acting on its documented instructions. Self-hosting complicates the picture usefully: where a customer runs this platform on their own infrastructure, we may not be a processor at all, because we never receive the data. Where it is hosted for them, we are, and a data-processing agreement is required. The ATS is independently a processor for the same controller. A webhook from us to their ATS is therefore a **processor-to-processor transfer authorised by the controller**, and the controller's DPA with each of us must permit it. See [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md) for the fuller treatment; the integration-specific obligations are:

1. **Configuring a webhook is an instruction from the controller.** The org admin who creates a subscription is exercising the controller's authority. That is why subscription creation requires `org.admin`, is audited with the URL, and is listed in the org's own data-flow view. A record of each destination and what it receives is what a controller needs for its Article 30 processing register.
2. **Transfer mechanism.** Where the webhook destination is outside the originating jurisdiction, the controller needs a lawful transfer mechanism — adequacy, standard contractual clauses, or equivalent — between itself and the ATS. That is not our contract to hold, but the product must make the destination **visible** so the question is askable. The subscription view shows the resolved country of the endpoint's address at creation time, purely as an informational signal.
3. **Minimisation per event.** Payloads carry what the event needs and no more. `attempt.finalised` carries scores and a per-skill breakdown; it does not carry the candidate's answers, their submitted code, proctoring media, or any proctoring event detail. An ATS integration is not a mechanism for shipping the entire attempt record to a third party. A consumer that needs detail reads it back over an authenticated call, which is auditable and revocable in a way a firehose is not.
4. **Proctoring data never leaves over webhooks.** `attempt.flagged` carries counts by signal type. No media, no frames, no raw event stream. ADR-007 makes proctoring advisory; shipping the evidence into a system with its own automation rules is exactly how advisory signals become automated rejections somewhere we cannot see. Evidence stays in the review queue, behind authentication, with a retention ceiling.
5. **Retention interaction.** Delivery payloads are stored copies of candidate PII. They are purged at 30 days, well inside `RETENTION_ATTEMPT_DATA_MONTHS`, and the purge nulls the payload while retaining delivery metadata for operational history. When a candidate is erased under `RETENTION_CANDIDATE_PII_MONTHS` or an erasure request, any undelivered or dead-lettered payload referencing them is purged as part of the same transaction — otherwise an erasure leaves PII sitting in a retry queue, which is the sort of thing that is discovered in an audit rather than in testing.
6. **Downstream erasure is the consumer's obligation, and we help.** `candidate.erased` fires on erasure carrying only the IDs, so a consumer can delete its own copy. We cannot enforce that they do. The integration guide states the obligation and the DPA should carry it.
7. **Right of access.** A candidate exercising a subject access request is entitled to know who their data went to. `GET /candidates/{id}/disclosures` — planned — lists the webhook destinations that received events about them and when, derived from `webhook_deliveries`. This is cheap to build because the data is already there, and expensive to reconstruct later if the deliveries are purged without an index.

---

## 14. Phased plan

Against the milestone calendar: M0 see ROADMAP, M1 see ROADMAP, M2 see ROADMAP, M3 see ROADMAP, M4 see ROADMAP.

### Phase 1 — Event spine (M1)

Nothing ships to a customer in this phase; it establishes the shape everything else hangs on.

- `webhook_events`, `webhook_deliveries`, `webhook_endpoints`, `webhook_secrets` migrations, with RLS.
- Transactional outbox: the API writes the event and delivery rows in the domain transaction, the worker delivers. Sweep for orphaned `pending` rows.
- BullMQ `webhooks` queue in `apps/worker`, with the §5.2 backoff and dead-lettering.
- HMAC signing with dual-secret support from day one. Retrofitting rotation is harder than building it.
- SSRF guard and egress proxy (§12). **This is phase 1 work, not a hardening pass later.** A webhook layer without it should never be deployed even internally.
- Events live: `invitation.sent`, `invitation.expired`, `invitation.revoked`, `attempt.started`, `attempt.submitted`, `attempt.finalised`, `attempt.voided`.
- `POST /webhooks`, `GET /webhooks/{id}/deliveries`, `POST /webhooks/{id}/test`.

**Exit criteria:** a test consumer receives every event for a full invite-to-finalise cycle, verifies signatures with the §4.5 snippet unmodified, survives a 90-second endpoint outage with no event loss, and a subscription pointed at `169.254.169.254` is refused at creation and counted in `webhook_egress_blocked_total`.

### Phase 2 — Inbound surface (M1)

- `api_keys` and `api_key_permissions`; bearer authentication in `packages/auth`.
- `external_system` / `external_ref` columns and unique indexes across candidates, applications, job openings, invitations.
- Upsert semantics and the conflict matrix in §7.3.
- `POST /integrations/invite` composite.
- Signed, expiring, attempt-scoped report links (§10, obligation 4).

**Exit criteria:** a script using only an API key creates a candidate, an application and an invitation, receives `attempt.finalised`, and opens the report link — and running that script twice produces exactly one candidate and one invitation.

### Phase 3 — Coding and integrity events (M2)

- `attempt.auto_graded` and `attempt.regraded`, which only become meaningful once asynchronous grading exists.
- Per-section and per-skill breakdown in `attempt.finalised` payloads.
- `/webhooks/{id}/health`, the circuit breaker, and the delivery metrics in §6.
- First real integration with a live pipeline, written by the customer against the generic surface. **This is the phase that produces the connector decision**, and the deliverable is the friction log from it, not a connector.

### Phase 4 — Session and scorecard events (M3)

- `session.scheduled`, `session.started`, `session.ended`, `scorecard.submitted`.
- `attempt.flagged` and `attempt.integrity_reviewed` wired but inert until M4 supplies proctoring signals.

### Phase 5 — Connector, only on demand (post-M4)

Entry conditions, all of which must hold:

1. A named customer with a named ATS, whose requirement the generic surface demonstrably cannot meet — "we do not want to write glue" counts as a requirement, and it is a commercial decision rather than a technical one.
2. The five partner obligations in §10 are already satisfied by the generic API, verified against that vendor's actual partner documentation.
3. Sandbox access to that vendor's API exists and their partner programme's requirements are understood.
4. Someone owns it on call. A connector without a named owner is an outage with a delay fuse.

Build order if it fires: Ashby or Teamtailor first, as the cheapest complete proof of the connector architecture in §11; Greenhouse second, as the most-demanded. Workday only against a contract that funds it.

---

## 15. Open items

| Item | Owner | Decide by |
|---|---|---|
| Verify each vendor's auth model, current rate limits and partner-programme requirements against live documentation | connector owner | at connector kickoff |
| Whether per-entity FIFO delivery is worth the throughput cost | engineering lead | end of M2 |
| Signed report-link lifetime and whether it is single-use | product, with security review | end of M1 |
| Whether `attempt.auto_graded` is exposed to customers at all, or kept internal to avoid ATSs acting on provisional scores | product | end of M2 |
| Dead-letter payload retention of 30 days, pending the retention sign-off tracked in [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md) | legal, with engineering lead | 2026-11-27 |
| Whether an org-level egress allowlist is offered as a customer-facing control or kept as an operator control | engineering lead | end of M1 |
