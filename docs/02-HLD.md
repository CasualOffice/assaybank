# High-level design — technical hiring platform

**Status:** draft
**Owner:** _unassigned_ (engineering lead)
**Last updated:** 2026-09-15
**Companion docs:** [`01-PRD.md`](01-PRD.md), [`03-API-spec.md`](03-API-spec.md), [`04-ADRs.md`](04-ADRs.md), [`hiring_platform_schema.sql`](hiring_platform_schema.sql), [`../CODE-GRAPH.md`](../CODE-GRAPH.md)

---

## 1. Design principles

**The server owns the truth about time, scoring, and question selection.** Every one of these has been attacked in every assessment product ever built. The client renders; it does not decide.

**Grading is asynchronous and idempotent.** A slow test case must never block the API. A replayed grading job must produce the same score.

**Nothing the candidate must not see ever reaches the client.** Hidden test cases, reference solutions, and correct-answer flags are filtered server-side, not hidden with CSS.

**Permissive licenses only.** Every dependency is MIT, Apache-2.0, BSD, or ISC. This keeps commercialisation open and removes a class of legal review from the critical path. See ADR-001.

**Boring infrastructure.** Postgres, Redis, object storage, Docker. The novel part of this system is the domain model, not the plumbing.

## 2. System context

```
   ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
   │  Recruiter   │        │  Interviewer │        │  Candidate   │
   │   console    │        │   console    │        │     app      │
   └──────┬───────┘        └──────┬───────┘        └──────┬───────┘
          │                       │                       │
          └───────────────────────┼───────────────────────┘
                                  │ HTTPS / WSS
                        ┌─────────▼──────────┐
                        │     Core API       │
                        │  (auth, domain,    │
                        │   orchestration)   │
                        └─────────┬──────────┘
        ┌──────────────┬──────────┼──────────┬───────────────┐
        │              │          │          │               │
  ┌─────▼─────┐  ┌─────▼─────┐ ┌──▼───┐ ┌────▼─────┐  ┌──────▼──────┐
  │ Execution │  │   Collab  │ │ Mail │ │  Object  │  │   Grading   │
  │  service  │  │  service  │ │      │ │  store   │  │   workers   │
  │ (Piston)  │  │  (Yjs)    │ │      │ │          │  │             │
  └─────┬─────┘  └─────┬─────┘ └──────┘ └──────────┘  └──────┬──────┘
        │              │                                      │
        └──────────────┴──────────────┬───────────────────────┘
                                      │
                        ┌─────────────▼─────────────┐
                        │  PostgreSQL  │   Redis    │
                        └───────────────────────────┘

  External: ATS (webhooks), SSO/IdP (OIDC), Safe Exam Browser (cert mode)
```

## 3. Components

### 3.1 Core API

The only component with database write access for domain entities. Stateless, horizontally scalable behind a load balancer.

Responsibilities:
- AuthN (session + OIDC for staff, signed one-time tokens for candidates)
- AuthZ (per-action permission checks, org isolation)
- Question bank CRUD and version lifecycle
- Assessment composition and rule resolution
- Attempt lifecycle and the server-authoritative timer
- Enqueuing grading jobs
- Report generation and export
- Webhook emission to the ATS

Explicitly **not** responsible for: running candidate code, holding WebSocket document state, computing scores synchronously.

### 3.2 Execution service

Piston behind a thin adapter. The adapter exists so Piston is swappable — if you later need firecracker-based isolation or a different language matrix, only the adapter changes.

- Accepts `{language, version, files[], stdin, args, limits}`
- Returns `{compile: {...}, run: {stdout, stderr, code, signal}}`
- Enforces: CPU time, wall time, memory, max processes, max output size, **no network egress**
- Runs on dedicated nodes, never co-located with the API or database

The adapter never receives a question ID. It receives code and inputs. Test-case expectations are compared in the grading worker, not in the sandbox — so a candidate who escapes the sandbox still learns nothing about hidden cases.

### 3.3 Collaboration service

`y-websocket` server holding live Yjs documents for interview sessions.

- One document per session, keyed by room code
- Awareness protocol carries cursors, selections, and participant presence
- Redis pub/sub for cross-instance fanout when horizontally scaled
- Periodic snapshot of the document state vector to Postgres (`interview_sessions.doc_state`)
- Every applied update is also appended to `session_events` for replay

Session state is ephemeral in memory and durable in Postgres. An instance crash loses at most the snapshot interval.

### 3.4 Grading workers

Pull from a Redis-backed queue. One job = one submission.

Pipeline per job:
1. Load submission, question version, test cases
2. For each test case: call execution adapter, compare output per the grading mode
3. Compute weighted score
4. Write `submission_results` rows and update `submissions`
5. If this is the final submission for an attempt question, update `answers.auto_score`
6. If all questions in the attempt are graded, finalise `attempts`

Idempotent by submission ID. Retries are safe. Failures after N attempts go to a dead-letter queue with an alert, and the attempt sits in `under_review` rather than silently scoring zero.

### 3.5 Storage

**PostgreSQL** — all domain data. Row-level security enforces org isolation. Partition `session_events` and `proctor_events` by month.

**Redis** — job queue, session presence, rate limiting, short-lived candidate session cache. Nothing here is a source of truth.

**Object store (S3/R2)** — session recordings, proctor media, large submission artifacts, export files. Accessed only through pre-signed short-lived URLs.

## 4. Key flows

### 4.1 Candidate takes an assessment

```
Candidate                Core API              Postgres         Queue
   │  GET /t/{token}        │                     │               │
   ├───────────────────────►│ verify hash, expiry │               │
   │                        ├────────────────────►│               │
   │  ◄── assessment meta ──┤                     │               │
   │                        │                     │               │
   │  POST /attempts/start  │                     │               │
   ├───────────────────────►│ resolve section     │               │
   │                        │ rules, draw random  │               │
   │                        │ questions, shuffle  │               │
   │                        │ options             │               │
   │                        ├── INSERT attempt ──►│               │
   │                        ├── INSERT attempt_  ─►│              │
   │                        │   questions (N)     │               │
   │                        │ deadline_at = now() │               │
   │                        │   + duration        │               │
   │  ◄── attempt + Q[0] ───┤                     │               │
   │                        │                     │               │
   │  PATCH /answers (auto- │                     │               │
   │  save, every ≤5s)      │                     │               │
   ├───────────────────────►├────────────────────►│               │
   │                        │                     │               │
   │  POST /submit          │ reject if now() >   │               │
   ├───────────────────────►│   deadline_at       │               │
   │                        ├─ grade MCQ inline ─►│               │
   │                        ├─ enqueue coding ────────────────────►│
   │  ◄── submitted ────────┤                     │               │
```

The question draw happens exactly once. `attempt_questions` is the record of what was served, and every later operation reads from it rather than re-resolving the rules.

### 4.2 Coding submission

```
Candidate → API: POST /submissions {code, language}
API       → DB:  INSERT submissions (status='queued')
API       → Q:   enqueue {submission_id}
API       → Candidate: 202 {submission_id}     ← returns immediately

Worker    ← Q:   dequeue
Worker    → DB:  load question version, test cases, limits
  for each test case:
    Worker → Exec: POST /execute {code, stdin, limits}
    Exec   → Worker: {stdout, stderr, exit_code, time, memory}
    Worker: compare per grading_mode, truncate stdout before storing
Worker    → DB:  INSERT submission_results, UPDATE submissions
Worker    → Redis: publish result

Candidate: SSE /submissions/{id}/stream  ← receives result
```

Candidate-visible results are filtered: sample cases show full detail, hidden cases show pass/fail only.

### 4.3 Live interview join

```
Interviewer creates session → room_code generated
Candidate opens /join/{room_code}
  → API validates code, issues short-lived WS ticket
  → Client connects WSS to collab service with ticket
  → Collab service validates ticket, loads or creates Yjs doc
  → Awareness broadcasts presence to both participants
  → Every update appended to session_events (async, batched)
On end: snapshot doc_state to Postgres, close room
```

### 4.4 Grading and finalisation

MCQ and short-answer grade inline at submit — they are pure comparisons. Coding grades asynchronously. Subjective and system-design questions move the attempt to `under_review` and wait for a human.

An attempt reaches `finalised` only when every question has a `final_score`. This is a single transition guarded by a database-level check, which prevents the classic bug where a report is generated from a half-graded attempt.

## 5. Technology selection

| Concern | Choice | License | Why |
|---|---|---|---|
| API runtime | Node + TypeScript (Fastify) or Python (FastAPI) | MIT | Team familiarity should decide this, not us |
| Database | PostgreSQL 16 | PostgreSQL (permissive) | RLS, JSONB, partitioning, arrays |
| ORM / query | Drizzle or SQLAlchemy | Apache-2.0 / MIT | Migrations as code |
| Cache / queue | Redis + BullMQ | BSD-3 / MIT | Simple, proven, good retry semantics |
| Code execution | Piston | **MIT** | Permissive; Judge0 is GPL-3 (ADR-002) |
| Editor | Monaco or CodeMirror 6 | MIT | Monaco for desktop-first, CM6 if mobile matters |
| Collaboration | Yjs + y-websocket | MIT | CRDT, no central lock (ADR-005) |
| Auth | Lucia or Better Auth | MIT | Session-based, no vendor |
| Frontend | React + TanStack Router | MIT | — |
| Object store | S3-compatible (MinIO self-hosted) | Apache-2.0 | — |
| Video (live rounds) | LiveKit | Apache-2.0 | Self-hostable SFU |
| Lockdown (cert mode) | Safe Exam Browser | MPL / open | Only serious open option |

Every entry is MIT, Apache-2.0, BSD, or MPL. No GPL, no AGPL, no BSL/SSPL.

## 6. Scaling

The system has three independent scaling axes and one real bottleneck.

**API tier** — stateless, scale horizontally. Nothing interesting here.

**Execution tier** — the bottleneck. Each execution consumes a full CPU slot for its time limit. At 5s limits and 100 concurrent executions you need roughly 100 cores, or you accept queueing. Practical approach:

- Size the worker pool to `cores × 0.8`
- Queue depth is the primary autoscaling signal
- Separate queues for interactive "Run" (low latency, high priority) and batch "Submit" grading
- Pre-warm runtime containers; cold start dominates for short programs
- Cap per-attempt execution budget so one candidate cannot starve the pool

**Collaboration tier** — memory-bound, not CPU-bound. Each live document is small; a single node handles hundreds of concurrent sessions. Scale on connection count with sticky routing by room code, Redis pub/sub for cross-node awareness.

**Database** — read replicas for reporting, which is where the expensive queries live. Keep the transactional path on the primary. Partition the two event tables by month and archive to object storage after 90 days.

### Capacity worked example — campus drive

1000 candidates, 90-minute window, 3 coding questions each.

- Peak concurrent attempts: ~1000
- API requests: ~1000 × 1 autosave / 5s = 200 req/s. Trivial.
- Executions: assume 6 runs per question (5 trial + 1 submit) = 18 per candidate = 18,000 total over 90 min = ~3.3/s average, but arrivals cluster near deadline. Size for 5× average: ~17/s. At 3s mean execution, that is ~50 concurrent slots. Two 32-core execution nodes.
- Database writes: dominated by autosave. Batch them.

The failure mode is not throughput, it is the deadline stampede. Stagger start times or rate-limit the final-minute submission burst.

## 7. Security

### Sandbox
Treat every submission as hostile. Assume the sandbox will eventually be escaped — Piston and Judge0 have both had documented escapes. Therefore:

- Execution nodes hold no secrets, no database credentials, no cloud IAM roles
- Execution nodes are network-isolated: no egress, no access to the API or database
- Test-case expectations never enter the sandbox
- Nodes are ephemeral and recycled regularly
- Resource limits enforced by the kernel (cgroups), not by the application

### Candidate tokens
- Invitation tokens are high-entropy, hashed at rest, single-purpose, expiring
- A token grants access to exactly one attempt, nothing else
- WebSocket tickets are separate, short-lived (60s), and single-use

### Data protection
- Row-level security on every tenant table; `app.current_org` set per connection
- Reference solutions and correct-answer flags stripped in the serialisation layer, with a test asserting they never appear in candidate-facing responses
- Proctor media accessed only through pre-signed URLs with short TTL
- Audit log for every privileged action, append-only

### Secrets and supply chain
- No secrets in the repository; injected at runtime
- Dependency license scanning in CI, failing the build on GPL/AGPL/BSL (ADR-001)
- SBOM generated per release

## 8. Observability

**Metrics:** queue depth by priority, execution latency histogram, sandbox timeout rate, attempt completion rate, autosave failure rate, WebSocket reconnect rate.

**Alerts that matter:**
- Queue depth growing during an exam window → execution capacity
- Autosave failure rate above zero → candidates losing work, page immediately
- Attempts stuck in `in_progress` past deadline → timer or finalisation bug
- Dead-letter queue non-empty → ungraded submissions

**Tracing:** propagate a trace ID from the candidate request through the queue into the worker and execution call. Debugging "why did this candidate's score differ on re-grade" is impossible without it.

**Audit:** separate from logs, in the database, queryable, retained per policy.

## 9. Failure modes

| Failure | Blast radius | Mitigation |
|---|---|---|
| Execution service down | Coding rounds only; MCQ unaffected | Queue holds submissions; candidates see "grading in progress", attempt stays valid |
| Collab service down | Live interviews only | Client buffers locally, reconnects; snapshot limits loss |
| Redis down | Grading pauses, sessions degrade | Queue backed by Redis persistence; API keeps accepting submissions |
| Database primary down | Total outage | HA pair with automatic failover; in-flight attempts resume from autosave |
| Candidate loses network | One candidate | Local buffer, resume on reconnect, server timer unaffected |
| Sandbox escape | Potentially the execution node | Isolation means the node holds nothing; recycle and investigate |

The important property: **an infrastructure failure must never silently score a candidate as zero.** Every failure path either preserves the attempt or moves it to human review.

## 10. Deployment

Single-region to start. Three node groups:

- **app** — API + collab, 2+ instances, behind a load balancer with sticky sessions for WS
- **exec** — execution workers, network-isolated, autoscaled on queue depth
- **data** — Postgres HA pair, Redis, MinIO

Environments: dev, staging (with production-shaped data volumes — assessment bugs only appear under concurrency), production.

Blue-green for the API. Execution nodes drain rather than cut over, since a running submission must finish.

Migrations are expand-contract: add nullable, backfill, switch reads, drop old. Never break a running exam window.

## 11. What we deliberately are not building

- Our own sandbox. Use Piston.
- Our own CRDT. Use Yjs.
- Our own video SFU. Use LiveKit.
- AI proctoring from scratch. The open-source options are abandoned student projects, the accuracy is poor across skin tones and disabilities, and the legal exposure is real. Browser signals plus Safe Exam Browser cover the defensible cases.
