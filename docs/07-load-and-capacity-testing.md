# Load and capacity testing

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`01-PRD.md`](01-PRD.md), [`02-HLD.md`](02-HLD.md), [`03-API-spec.md`](03-API-spec.md), [`04-ADRs.md`](04-ADRs.md), [`06-testing-strategy.md`](06-testing-strategy.md), [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md), [`13-environments-and-release.md`](13-environments-and-release.md), [`../project/MILESTONES.md`](../project/MILESTONES.md), [`../project/RISKS.md`](../project/RISKS.md)

---

Nothing described here has been built or run. This document specifies the workload model, the scenarios, the capacity arithmetic and the gates. It closes the gap [`README.md`](README.md) names — *"Load testing plan not written — needs to exist before the first campus drive"* — and resolves OQ-006 in [`../project/OPEN-QUESTIONS.md`](../project/OPEN-QUESTIONS.md).

## 1. Why this document exists

Three of the five milestone exit criteria in [`01-PRD.md`](01-PRD.md) §6 are load statements — 50 concurrent candidates, 100 concurrent submissions at p95 under 8 s, and the 500-sustained / 1000-peak figures in §8. None of them can be claimed without a written, repeatable scenario, and an exit criterion assessed by impression is not an exit criterion.

The second reason is sharper. [`02-HLD.md`](02-HLD.md) §9 names the property this system must hold above all others: **an infrastructure failure must never silently score a candidate as zero.** Load is the condition under which that property is tested for real. A queue that backs up, a connection pool that exhausts, an autosave that times out — each of these can turn into a candidate's score, and each only appears above a threshold nobody reaches by clicking around staging. HLD §10 says the same thing about environments: assessment bugs only appear under concurrency.

The third reason is that the known bottleneck is already identified. HLD §6 says the failure mode is not throughput but the deadline stampede, and R-01 in [`../project/RISKS.md`](../project/RISKS.md) carries it as a live risk. A stampede is not something you discover; it is something you either measured beforehand or experienced in front of a thousand students.

## 2. Workload model

### 2.1 The reference workload

Derived from the campus-drive worked example in [`02-HLD.md`](02-HLD.md) §6, which is the hardest shape this system is asked to take.

| Parameter | Value | Source |
|---|---|---|
| Candidates in the cohort | 1000 | HLD §6 |
| Window | 90 minutes (5400 s) | HLD §6 |
| Coding questions per candidate | 3 | HLD §6 |
| MCQ questions per candidate | 20 | Representative mixed assessment |
| Trial runs per coding question | 5 | HLD §6 |
| Submits per coding question | 1 | HLD §6 |
| Autosave interval | ≤ 5 s after the last change (FR-9) | PRD §7 |
| Heartbeat interval | 15 s | API spec §7 |
| Hidden test cases per coding question | 10 | Typical published question |
| Sample test cases per coding question | 2 | Typical published question |

### 2.2 The correction to the HLD arithmetic

HLD §6 computes 18 executions per candidate — 6 per question, being 5 trial runs plus 1 submit, times 3 questions — and sizes the execution tier from that. That count is right for *execution requests* and wrong for *sandbox invocations*, because a submit is not one invocation: it runs every hidden case. The real figure is:

```
per candidate = 3 questions x [ 5 trial runs x 1 case + 1 submit x 10 hidden cases ]
              = 3 x [ 5 + 10 ]
              = 45 sandbox invocations, not 18
```

The correction matters because the execution tier is the bottleneck and a 2.5x underestimate there is the difference between a queue that drains and one that grows for the whole window. It does not, as it happens, change the HLD's conclusion — because its other assumption ran conservative in the opposite direction. HLD §6 assumes 3 s mean execution time uniformly. In practice a hidden-case invocation on a working solution is short; the 5 s limit is a ceiling that only failing and pathological submissions reach. Modelling the two classes separately:

```
trial run    : mean wall 1.5 s   (candidate code mid-development, 1 sample case)
hidden case  : mean wall 1.0 s   (a passing solution on one case)

core-seconds per candidate = 3 x [ 5 x 1.5 + 10 x 1.0 ] = 3 x 17.5 = 52.5
```

Both figures are assumptions until the first real run measures them. **The first job of the `exec-saturation` scenario (§5.6) is to replace them with observations**, and this section is updated in the same change that produces the measurement. Until then the model is stated so it can be falsified, which is the only useful property an assumption has.

### 2.3 Derived rates

| Quantity | Arithmetic | Result |
|---|---|---|
| Autosave requests | 1000 candidates / 5 s | 200 req/s |
| Heartbeats | 1000 / 15 s | 67 req/s |
| Question reads and navigation | ~0.03 req/s per candidate | 30 req/s |
| **Steady API rate at N=1000** | 200 + 67 + 30 | **~300 req/s** |
| Sandbox invocations, whole window | 1000 x 45 | 45,000 |
| Average invocation rate | 45,000 / 5400 s | 8.3 /s |
| Average core demand | 1000 x 52.5 core-s / 5400 s | 9.7 cores |
| Peak core demand at 5x clustering | 9.7 x 5 | 48.6 cores |
| Cores at 0.8 packing (HLD §6 rule) | 48.6 / 0.8 | **61 cores → 64** |
| Execution slots at peak | 8.3 /s x 5 x 1.2 s mean | **~50 concurrent** |

Two 32-core execution nodes, which is where HLD §6 landed. The model now shows its working, so the next person can change an assumption and see what moves.

### 2.4 Arrival distribution — the part the averages hide

An average rate of 8.3 invocations per second is a true statement about the window and a useless statement about capacity, because candidates do not arrive uniformly. Two clusters dominate.

**The start blast.** A campus drive begins when an invigilator says begin. Redemptions and attempt starts land in the first two to three minutes. Attempt start is the heaviest write in the system: it resolves every section rule and materialises the full `attempt_questions` set (ADR-004). At 1000 candidates in 180 s that is 5.6 starts/s, each writing roughly 23 rows plus the attempt row — about 135 inserts/s, trivial in volume, but each start also runs the rule-resolution query against the bank, and that query is the one that has never been measured under concurrency.

**The deadline stampede.** Candidates work until they are stopped. Submissions cluster hard against the deadline, and the tail is heavier than intuition suggests: the modelling assumption is **80% of final submissions in the final 5 minutes**, i.e. 800 submits in 300 s, which is 2.7 submits/s, each fanning out to 10 hidden cases — 27 sandbox invocations per second against a tier sized for 50 concurrent slots at ~1.2 s each, or roughly 42 invocations/s of capacity. That is inside capacity but only just, and it assumes nothing else is running. Trial runs do not stop during the final minutes; candidates run more, not less, as the clock closes.

```
invocations/s
   ^
50 |                                                         ####
   |                                                         ####
40 |                                                         ####
   |                                                         ####
30 |                                                         ####
   |                                                         ####
20 |  ##                                                    #####
   |  ##                                                  #######
10 |  ##     ...........................................#########
   |  ##.....                                            #########
 0 +--+-----------------------------------------------------+----->
    0   5                                                85  90  min
   start blast          steady working                deadline stampede
```

The k6 implementation approximates this with a `ramping-arrival-rate` executor rather than a fixed rate, in five stages:

| Stage | Duration | Target arrival rate (submits/s) | Represents |
|---|---|---|---|
| 1 | 3 min | ramp 0 → 5.6 starts/s then drop to 0 | Start blast |
| 2 | 10 min | 0.5 | Early exploration, mostly reads and autosaves |
| 3 | 60 min | 1.2 | Steady working, trial runs dominant |
| 4 | 12 min | ramp 1.2 → 3.0 | Candidates beginning to finish |
| 5 | 5 min | ramp 3.0 → 8.0 | Deadline stampede |

Stage 5 is the scenario that matters. A load test that runs at the average rate for 90 minutes proves the system can handle a workload it will never see.

### 2.5 Per-candidate request budget

One virtual user models one candidate for the whole window, holding its own attempt token, its own SSE connection, and its own think time. This matters: a k6 script that fires independent requests from a shared pool cannot exhibit the failure modes that come from per-attempt state — the rate limits in [`03-API-spec.md`](03-API-spec.md) §2 are per attempt, the execution budget is per attempt, and the autosave ordering guarantee is per answer. Modelled per candidate, a virtual user issues roughly:

```
  1  token redemption + attempt start
 20  question reads
~90  autosaves          (20 answers, several edits each, debounced at 5 s)
360  heartbeats         (90 min / 15 s)
 15  trial runs         (3 questions x 5)
  3  submits            (3 questions)
  3  SSE streams        (one per submit, open until the terminal event)
  1  final submit
```

About 490 HTTP requests and 3 streams per candidate over 90 minutes.

## 3. What is being measured

The load tool measures what a client can see. Everything else comes from the platform's own telemetry, which is why the load run and the observability stack ship together — a load run without server-side metrics tells you a request was slow and nothing about why.

| Measure | Why it matters | Source |
|---|---|---|
| API latency p50 / p95 / p99 **by endpoint class** | A single aggregate hides the problem: autosave is 85% of traffic and is fast, so a slow attempt-start disappears into the average | `http_request_duration_seconds` histogram, labelled by route class, from Prometheus |
| Endpoint classes | `autosave`, `heartbeat`, `read`, `attempt-start`, `submit`, `run`, `report`, `staff` | Route label |
| Queue depth **by priority** | The primary autoscaling signal (HLD §6) and the leading indicator of a stampede | `queue_depth{queue="grading.run"|"grading.submit"}` |
| Time-in-queue by priority | Depth without time-in-queue does not distinguish a deep fast queue from a shallow stalled one | `queue_time_in_queue_seconds` |
| Execution wall time distribution | Full distribution, not the mean. The tail is what saturates slots, and it is where the model's assumptions are falsified | `exec_wall_time_seconds` histogram |
| Submit-to-result latency | The M2 exit criterion, measured end to end from the submit request to the final SSE frame | `exec_result_latency_seconds` |
| **Autosave failure rate** | Must be zero. Non-zero means candidates are losing work (FR-9, R-15), which is a stop condition, not a metric to tune | `autosave_failures_total`, and k6's own count of non-2xx autosaves |
| Database connection saturation | The failure that turns a slow run into an outage; the pool exhausts and every request queues behind it | `db_connections_in_use / DATABASE_POOL_MAX`, plus `pg_stat_activity` |
| Slowest queries under load | An `EXPLAIN` plan that was fine in M0 can invert under RLS and concurrency (R-09) | `pg_stat_statements` before and after the run |
| WebSocket reconnect rate | A rising reconnect rate during a live session is degradation the participants feel as lost keystrokes | `ws_reconnects_total` |
| Active SSE connections | One per in-flight submission; a leak here exhausts file descriptors before it exhausts CPU | `sse_connections_active` |
| Dead-letter depth | Must be zero. A non-empty DLQ during a load run is an ungraded submission | `queue_depth{queue=~".*\\.dlq"}` |
| Attempts stuck `in_progress` past deadline | Timer or finalisation bug, invisible in latency percentiles | Query after the run |
| Error rate by code | Distinguishes a rate limit doing its job from a 500 doing damage | `http_requests_total` by code |

The metric names above are the ones this document assumes. [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md) owns the canonical registry; where the two disagree, that document wins and this one is corrected in the same change.

**Client-side measures k6 owns:** request duration per scenario and per endpoint class, iteration duration, dropped iterations (which indicate the load generator itself could not keep up and invalidate the run), and custom trends for submit-to-result and for autosave success.

## 4. Tooling

### 4.1 k6

k6 is the tool. Scripts are JavaScript, so the team writes them in the language it already uses; the executors model arrival rates rather than only virtual-user counts, which is exactly what §2.4 needs; thresholds are declared inside the script, so a scenario is its own pass/fail gate rather than a graph someone interprets; and output goes to Prometheus remote-write so client-side and server-side series sit on one dashboard with one time axis.

k6 also covers the two non-HTTP surfaces this system needs: `k6/experimental/sse` for the submission result stream and `k6/experimental/websockets` for the collaboration tier. A load tool that cannot hold an SSE connection cannot model this workload at all, since every coding submission opens one.

**Licence position, stated plainly.** Grafana k6 is distributed under the **AGPL-3.0**, which is on the prohibited list in [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md) §1. It is nevertheless admissible here under a boundary that must be written down rather than assumed:

- k6 is executed as a standalone binary against a running system. It is not linked into any artifact, not imported by any workspace package, and never appears in `pnpm-lock.yaml` or in the CycloneDX SBOM of a release.
- We do not modify k6 and we do not expose k6 itself as a network service to third parties, which is what the AGPL's §13 network clause attaches to. Running unmodified AGPL software as a test client creates no conveyance and no network-interaction obligation toward our candidates or customers.
- The k6 binary is installed only in the load-runner image described in §8, which is never part of a production deployment.

That boundary — *AGPL tooling that is executed, never linked and never distributed, is out of scope for the dependency gate; AGPL software that is part of the running product is not, which is exactly why MinIO was rejected in favour of SeaweedFS* — needs ratification by the licence owner rather than being decided inside a testing document. TBD — owner: compliance owner named in [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md), ratify or reject by **2026-10-16**, before the first gated run. If it is rejected, the fallback is **Gatling** (Apache-2.0) at the cost of a JVM and Scala in the toolchain, or **Artillery** (MPL-2.0) at the cost of weaker arrival-rate modelling. `autocannon` (MIT) is not a substitute; it measures endpoint throughput and cannot model a candidate journey.

### 4.2 Why not JMeter or Locust

Neither is rejected on licence — JMeter is Apache-2.0 and Locust is MIT, both permitted.

**JMeter** is rejected on the shape of the artifact. Scenarios are XML authored through a desktop GUI, which means they are unreviewable in a pull request: a diff of a JMeter plan does not tell a reviewer what changed about the workload. Its SSE support requires a plugin, its arrival-rate modelling is awkward compared with declaring stages, and a thread-per-virtual-user model makes 1000 concurrent candidates with held-open streams expensive on the load generator itself. A load plan that lives outside code review will drift from the system it tests.

**Locust** is rejected on toolchain cost and on concurrency shape. It would introduce Python as a second language in a repository that decided on Node and TypeScript (ADR-012) purely to run load tests, which means a second dependency tree, a second licence scan and a second set of CI images. Its default concurrency is gevent-based within a GIL-bound process, so reaching 1000 held-open connections with SSE means running distributed workers — operationally heavier than the single k6 binary that does it natively.

### 4.3 Script shape

Scripts live in a planned top-level `load/` directory. Creating it requires a `code-graph.json` update and a `make graph` run in the same change ([`../CLAUDE.md`](../CLAUDE.md)).

```
load/
  lib/
    journey-candidate.js     one virtual user = one candidate, start to submit
    journey-interviewer.js   live-session participant
    seed-client.js           reads the frozen dataset manifest, never creates data
    thresholds.js            the SLO gates from section 6, imported by every scenario
    metrics.js               custom Trend and Rate definitions
  scenarios/
    mcq-50-concurrent.js
    coding-100-inflight.js
    steady-500.js
    peak-1000.js
    deadline-stampede.js
    exec-saturation.js
    autosave-storm.js
    sse-fanout.js
    collab-session-scale.js
    cold-cache.js
    start-blast.js
    soak-4h.js
  README.md                  how to run one, and what must be frozen first
```

Every scenario shares one shape, so a reviewer reads the workload rather than the plumbing:

```js
import { thresholds } from '../lib/thresholds.js';
import { candidateJourney } from '../lib/journey-candidate.js';

export const options = {
  scenarios: {
    deadline_stampede: {
      executor: 'ramping-arrival-rate',
      startRate: 0, timeUnit: '1s',
      preAllocatedVUs: 1200, maxVUs: 1500,
      stages: [
        { target: 1.2, duration: '10m' },   // steady working
        { target: 3.0, duration: '12m' },   // early finishers
        { target: 8.0, duration: '5m'  },   // the stampede
      ],
    },
  },
  thresholds,                                 // the gate lives in the script
};

export default function () { candidateJourney({ codingQuestions: 3 }); }
```

Three rules for the scripts themselves. **Thresholds are imported, never redefined per scenario**, so a passing run means the same thing everywhere. **Scenarios read a frozen dataset and never create questions or assessments**, so a run does not mutate the thing it measures. **`dropped_iterations` is itself a threshold** — if the generator could not keep up, the run is void rather than green, and that mistake is easy to make and hard to notice.

## 5. Scenarios

Twelve scenarios. Each names what it is trying to break, not what it is trying to demonstrate.

| # | Scenario | Shape | Breaks what | Gates |
|---|---|---|---|---|
| 1 | `mcq-50-concurrent` | 50 VUs, 30-question MCQ assessment, full journey | The M1 exit criterion | M1 |
| 2 | `coding-100-inflight` | 100 submissions in flight against two execution nodes | The M2 exit criterion | M2 |
| 3 | `steady-500` | 500 concurrent candidates, 60 min, mixed assessment | The sustained NFR | Release |
| 4 | `peak-1000` | 1000 concurrent, 90 min, full campus profile including the start blast | The peak NFR | Campus drive |
| 5 | `deadline-stampede` | 1000 candidates, 80% of submits in the final 5 min | R-01, the named failure mode | Campus drive |
| 6 | `exec-saturation` | Submit-only, ramped past known execution capacity | Queue behaviour past the limit | Release |
| 7 | `autosave-storm` | 1000 candidates typing continuously, autosave at the rate limit | FR-9 and R-15 | Campus drive |
| 8 | `sse-fanout` | 1000 concurrent open result streams | Connection and descriptor limits | Release |
| 9 | `collab-session-scale` | 50 live sessions, 2–4 participants each, continuous editing | The collaboration tier | M3 |
| 10 | `cold-cache` | `peak-1000` immediately after a cold start | The first five minutes after a deploy | Campus drive |
| 11 | `start-blast` | 1000 redemptions and attempt starts in 180 s | Rule resolution and materialisation under concurrency | Campus drive |
| 12 | `soak-4h` | 300 concurrent, 4 hours, back-to-back windows | Leaks, drift, unbounded growth | Release |

### 5.1 `mcq-50-concurrent` — M1 exit evidence

50 virtual users complete a 30-question assessment built from one fixed section and one random-draw section, so both the `section_questions` and the `section_rules` paths are exercised (FR-6). Each does the full journey: redeem, start, read every question, answer with realistic edit patterns, autosave, heartbeat, submit.

Pass: 50/50 attempts reach `finalised`; **zero** autosave failures; API p95 < 300 ms; every attempt's served question set matches what was materialised at start. The run is followed by the re-grade check in [`06-testing-strategy.md`](06-testing-strategy.md) §8.3, since the exit criterion has two halves and only one of them is load.

### 5.2 `coding-100-inflight` — M2 exit evidence

Ramp to 100 submissions in flight and hold. Two execution nodes sized per §7. Pass: 100/100 submissions reach a terminal state; submit-to-result p95 < 8 s measured to the final SSE frame; dead-letter queue empty; no submission graded twice; every `submissions` row carries `language_version` and `runtime_image`.

The submitted code is deliberately mixed — 70% correct solutions, 15% wrong answers, 10% timeouts, 5% compile errors — because a load test that only submits working code never exercises the timeout path, and the timeout path is the one that holds a slot for its full limit.

### 5.3 `steady-500` — the sustained NFR

500 concurrent candidates for 60 minutes on a mixed assessment. This is the closest thing to a normal day at full size and the baseline every other run is compared against. Pass: the full SLO gate table in §6, plus flat memory and flat connection counts over the hour.

### 5.4 `peak-1000` — the campus profile

The reference workload from §2 end to end, including the start blast and the stampede, at the peak figure from PRD §8. This is the scenario whose result determines whether a campus drive is allowed to run unbatched — which is a stated product goal (G3) and a success metric ("zero batching required during campus drives").

### 5.5 `deadline-stampede` — the named failure mode

Runs the last 20 minutes of `peak-1000` only, so it can be iterated in twenty minutes rather than ninety. 80% of the cohort's final submits land inside the last 5 minutes.

What it must show, in order of severity: no submission is rejected because the system is busy; no attempt is expired by the sweep while its submit was queued behind the burst; queue depth peaks and then **drains** rather than growing monotonically; submit-to-result degrades gracefully past 8 s rather than failing. Degrading past the SLO during the stampede is acceptable and expected — the candidate has already submitted and their attempt is valid whether or not grading has finished (ADR-008). What is not acceptable is a rejection, a lost submission, or an attempt that expires with work unrecorded.

This scenario is also where the two mitigations in §10 get their evidence: the run is repeated with the final-minute rate limit enabled and disabled, and with staggered `opens_at` values across the cohort, and the difference is recorded.

### 5.6 `exec-saturation` — deliberately past the limit

Ramp submissions until the execution tier is saturated and keep going to 2x capacity. The system is expected to queue, not to fail. Assertions: the interactive `grading.run` queue keeps its own concurrency and a candidate pressing Run still gets a result within a bounded time while `grading.submit` is backed up (this is the entire reason the queues are split); the per-attempt execution budget stops one candidate consuming a disproportionate share; nothing enters the dead-letter queue purely from queueing delay; the queue drains at the predicted rate once the load stops.

This scenario also produces the measured execution wall-time distribution that replaces the assumptions in §2.2.

### 5.7 `autosave-storm` — the zero-tolerance one

1000 candidates typing continuously, autosaving at the API's per-attempt rate limit of 60/min. The pass condition is absolute: **zero autosave failures**, and every answer readable back exactly as written after the run. A 429 from the documented rate limit is a correct response and is counted separately from a failure; a 500, a timeout, or a connection reset is a failure and fails the run at any count above zero.

The run includes a connection-churn phase — 10% of virtual users dropping and reconnecting every 30 s — because R-15 identifies the realistic failure not as a crash but as autosaves silently failing on bad campus wifi while the UI shows everything is fine.

### 5.8 `sse-fanout`

1000 concurrent open result streams held for the duration of grading. Measures file descriptors, memory per connection, the Valkey subscription fan-out that feeds the streams, and behaviour when an API instance is drained mid-stream during a rolling deploy — clients must reconnect and resume without duplicating a result.

### 5.9 `collab-session-scale` — M3

50 concurrent live sessions, 2–4 participants each, continuous editing with realistic burst typing, plus in-session code execution routed to the interactive queue. Measures editor sync latency p95 against the 150 ms NFR via the awareness round trip, memory per document, snapshot write cost at `COLLAB_SNAPSHOT_INTERVAL_MS`, `session_events` append throughput, and behaviour when one collab instance is killed — sessions must survive with at most the snapshot interval lost.

Out of scope here: LiveKit media bitrate and quality. That is separate capacity work, noted as a gap in [`06-testing-strategy.md`](06-testing-strategy.md) §20.

### 5.10 `cold-cache`

`peak-1000` started within 60 seconds of a cold deployment: empty Valkey, cold Postgres buffer cache, no pre-warmed Piston containers, empty connection pools. This is the realistic first five minutes of an exam window that starts right after a release, and it is the scenario most likely to expose a cold-start cliff, since HLD §6 warns that container cold start dominates for short programs. Pass: the SLO gates are met within 5 minutes of the start, and no request fails during the warm-up.

### 5.11 `start-blast`

1000 token redemptions and attempt starts inside 180 seconds. Attempt start is the heaviest write path in the system and the only one that runs rule resolution against the whole bank under contention. Assertions: every candidate gets exactly one attempt with one materialised question set (the concurrency invariant from [`06-testing-strategy.md`](06-testing-strategy.md) §11.1, now under real load); `exposure_count` totals are exactly correct afterwards, since a lost or doubled increment corrupts the retirement signal; attempt-start p95 < 1 s, which is a deliberately looser class than the 300 ms general target because a start does materially more work and a candidate expects a brief "preparing your assessment".

### 5.12 `soak-4h`

300 concurrent candidates over four hours across three back-to-back assessment windows. Looks for what short runs cannot see: memory growth in the API, worker and collab processes; connection-pool leaks; Valkey key growth from expired sessions and rate-limit keys; `session_events` and `proctor_events` partition behaviour; unbounded growth in any table that should be bounded; and latency drift — p95 at hour four compared with hour one, which must not be materially worse.

## 6. SLO gates

The PRD §8 targets restated as pass/fail gates. A scenario declares these as k6 thresholds so the run itself is the verdict, with no interpretation step. Every gate names its measurement method, because "p95 latency" means three different things depending on where it is measured.

| # | Gate | Threshold | Measured how | Applies to |
|---|---|---|---|---|
| G1 | API p95, non-execution endpoints | < 300 ms | Server-side `http_request_duration_seconds` p95 over the run window, excluding `run`, `submit`, `attempt-start` and `report` classes. Server-side rather than client-side so generator saturation cannot flatter the number | All |
| G2 | API p99, non-execution | < 1000 ms | Same series, p99. p95 alone hides a systematic stall affecting one candidate in fifty — which at 1000 candidates is twenty people | All |
| G3 | Attempt start p95 | < 1000 ms | `attempt-start` class only | `start-blast`, `peak-1000` |
| G4 | Execution result p95 | < 8 s | `exec_result_latency_seconds`, submit request to final SSE frame, cross-checked against k6's client-side Trend | `coding-100-inflight`, `steady-500`, `peak-1000` |
| G5 | Autosave failure rate | **= 0** | `autosave_failures_total` plus k6's count of non-2xx, non-429 autosave responses. Any non-zero value fails the run | All |
| G6 | Attempts reaching a terminal state | 100% | Post-run query: no attempt left `in_progress` past `deadline_at` | All |
| G7 | Dead-letter depth | **= 0** | `queue_depth` on every `.dlq` queue at run end and 10 min after | All |
| G8 | Submissions graded exactly once | 100% | Post-run query: one result set per submission, no duplicate rows on `(submission_id, test_case_id)` | Coding scenarios |
| G9 | Editor sync p95 | < 150 ms | Awareness round trip, same region | `collab-session-scale` |
| G10 | Availability during the window | ≥ 99.9% | Successful non-429 responses over total, computed across the whole run | `peak-1000`, `soak-4h` |
| G11 | Error rate, 5xx | < 0.1% | `http_requests_total{code=~"5.."}` over total | All |
| G12 | Database connection headroom | peak in-use < 80% of pool | `db_connections_in_use` against `DATABASE_POOL_MAX` x instances | All |
| G13 | Queue drains | Depth at end < depth at peak, trending to 0 within 10 min | `queue_depth` over time | `deadline-stampede`, `exec-saturation` |
| G14 | Generator was not the bottleneck | `dropped_iterations` = 0 | k6 built-in. Non-zero voids the run rather than failing it | All |
| G15 | No latency drift | Hour-4 p95 ≤ 1.2 x hour-1 p95 | Compared across the soak window | `soak-4h` |
| G16 | Flat resident memory | End ≤ 1.15 x steady-state after warm-up | Container memory series | `soak-4h` |

G5 is the only gate with a value of exactly zero, and it is deliberate. Every other number here is an engineering target with a defensible tolerance; a candidate losing work is not a tolerance question.

## 7. Capacity model

Sizing from §2.3's per-candidate figures. Every column shows its arithmetic so a changed assumption can be re-run rather than re-guessed.

**Rules.**

```
API req/s          = N x 0.30                      (0.20 autosave + 0.07 heartbeat + 0.03 reads)
API instances      = ceil(req/s / 125) + 1         125 req/s per instance sustained at 50% CPU
                                                   headroom; +1 for N+1 during a rolling deploy
Exec core demand   = N x 52.5 core-s / 5400 s      = N x 0.0097 cores average
Exec cores at peak = average x 5 / 0.8             = N x 0.061   (5x clustering, 0.8 packing)
Worker slots       = exec cores x 0.8              split 30% grading.run / 70% grading.submit
Worker instances   = ceil(slots / 16)              16 concurrent jobs per worker process
DB connections     = api x 10 + worker x 5 + 2 (collab) + 2 (sweeps)
```

| N concurrent | API req/s | API instances | Exec cores | Exec nodes | Worker slots (run / submit) | Worker instances | DB connections | Postgres `max_connections` |
|---|---|---|---|---|---|---|---|---|
| 100 | 30 | 2 | 6.1 → 8 | 1 x 8-core | 6 (2 / 4) | 1 | 2x10 + 1x5 + 4 = 29 → **32** | 100 |
| 250 | 75 | 2 | 15.3 → 16 | 1 x 16-core | 13 (4 / 9) | 1 | 2x10 + 1x5 + 4 = 29 → **32** | 100 |
| 500 | 150 | 3 | 30.5 → 32 | 1 x 32-core | 26 (8 / 18) | 2 | 3x10 + 2x5 + 4 = 44 → **48** | 150 |
| 1000 | 300 | 4 | 61 → 64 | 2 x 32-core | 51 (16 / 35) | 4 | 4x10 + 4x5 + 4 = 64 → **72** | 200 |
| 2000 | 600 | 6 | 122 → 128 | 4 x 32-core | 102 (32 / 70) | 8 | 6x10 + 8x5 + 4 = 104 → **120** | 250 + PgBouncer |

Notes that the table cannot carry:

- **The N=1000 row reproduces HLD §6's conclusion** — two 32-core execution nodes — by a different route, which is the useful check on both.
- **125 req/s per API instance is conservative and deliberately so.** Fastify on 2 vCPU serves far more than that for trivial JSON, but 85% of this traffic is a database write under RLS, and the gate is p95 < 300 ms rather than maximum throughput. The first `steady-500` run replaces this constant with a measurement.
- **`DATABASE_POOL_MAX` at 10 per API instance** is the assumption behind the connection column. Raising it is the wrong first move when the pool saturates — see §10, lever 2.
- **At N=2000, connection pooling becomes mandatory** and brings its own constraint: in transaction pooling mode, `app.current_org` must be set with `SET LOCAL` inside the transaction, never `SET` on the connection, or RLS silently applies the wrong org to a reused connection. [`06-testing-strategy.md`](06-testing-strategy.md) §5.3 specifies the test; this is the load condition under which the bug would first appear.
- **Reporting is not in this model.** Cohort analytics run on a read replica (HLD §6). A recruiter running a cohort report during an exam window is a real concurrent workload and is modelled as a fixed 5 staff req/s background in `peak-1000` rather than sized here.
- **Object storage, mail and webhooks** are not sized; at these volumes they are not near any limit. Webhook fan-out at the end of a campus drive — 1000 `attempt.finalised` events inside a few minutes — is checked as an assertion in `peak-1000` rather than as a capacity line.

## 8. Environment requirements

[`02-HLD.md`](02-HLD.md) §10 requires staging to carry production-shaped data volumes, and gives the reason: assessment bugs only appear under concurrency. A load run against an empty database measures an empty database.

| Requirement | Value | Why |
|---|---|---|
| Topology | Same three node groups as production: app, exec (network-isolated), data | A load run against a single-box stack cannot show a network-isolation cost or a cross-node queue latency |
| Scale factor | 1:1 with production for the run being gated; a smaller staging may be used for iteration but never for a gate | Extrapolating database behaviour from half-size hardware is unsound — plans change with table statistics, not with a linear factor |
| Postgres | Same major version, same RLS policies, same indexes, `pg_stat_statements` enabled | RLS is the thing most likely to change a plan under load (R-09) |
| Data volumes | §9 | An index that looks fine on 500 rows is a sequential scan on 500,000 |
| Piston | Same runtime images, pinned to the same digests, same pre-warm configuration | Cold start dominates short programs; a differently warmed Piston is a different system |
| Network | Load generator outside the app tier, crossing the same load balancer | Generating load inside the app network skips the layer that fails first |
| Generator capacity | Sized so `dropped_iterations` stays zero at 1000 VUs with 1000 held-open SSE streams; typically 2 generator nodes | G14 |
| Observability | Full Prometheus, OTel collector and Grafana, same scrape interval as production | The run's evidence comes from here, not from k6 |
| Isolation | No other tenant activity during a gated run | A shared staging invalidates the measurement |

Production is never a load-test target. The exception is a read-only smoke before an exam window (§11), which is a handful of requests, not load.

## 9. Test-data generation

A generator script produces a staging dataset at production shape. It is committed; the dataset it produces is not.

| Entity | Volume | Shape notes |
|---|---|---|
| Organisations | 5 | One large tenant holding 80% of the data, four small — a uniform split hides the RLS selectivity problem |
| Questions | 5000 published, 8000 versions | Across all eight kinds; realistic skill-tag distribution with a long tail |
| Test cases | ~40,000 | 2 sample and 10 hidden per coding question |
| Skills | 300 in a two-level taxonomy | Deep enough that rule resolution is a real query |
| Job roles | 40 with weighted skills | — |
| Assessments | 200, half published | Mixed fixed and random-draw sections |
| Candidates | 100,000 | Synthetic names and emails, never real people |
| Attempts | 50,000 historical, terminal states | Gives `question_stats` and `exposure_count` realistic values |
| Answers | ~1,500,000 | The largest transactional table |
| Submissions and results | 150,000 / 1,500,000 | Sized so the submissions index is under real pressure |
| `session_events` | 2,000,000 across 6 monthly partitions | Partition pruning only matters when partitions exist |
| `proctor_events` | 500,000 | — |
| Audit log | 1,000,000 | Append-only growth is a real query-planning factor |

Rules: the generator is deterministic given a seed, so two runs compare like with like; it contains **no real candidate data** in any field (R-20); it produces a `dataset-manifest.json` recording the seed, the row counts, the generator commit and the timestamp, and every load-run record cites that manifest; and the scenarios read it and never create bank content, so a run cannot shift the bank it is measuring. Generation is expected to take hours, so staging is restored from a snapshot of the generated dataset rather than regenerated per run — and the restore is itself a rehearsal of the backup path.

## 10. The bottleneck, and the tuning levers in order

The execution tier is the bottleneck (HLD §6), and the specific failure is the deadline stampede (R-01). When a gate fails, the levers below are applied in this order. The order is not arbitrary: it runs from changes that add capacity without changing candidate experience, through changes that trade experience for capacity, and ends with the ones that alter what the candidate is allowed to do. Each lever is applied alone and re-measured, because two levers applied together teach you nothing about either.

| # | Lever | Expected gain | Cost | How it is verified |
|---|---|---|---|---|
| 1 | **Pre-warm runtime containers** | Removes cold-start from every invocation; largest gain for short programs, which is most of them | Idle memory on execution nodes | `exec_wall_time_seconds` distribution shifts left; `cold-cache` gate passes |
| 2 | **Pool and concurrency sizing** — worker concurrency toward `cores x 0.8`, `DATABASE_POOL_MAX` only if G12 shows genuine starvation | Recovers capacity that is present but unused | Over-raising the DB pool moves contention into Postgres, which is worse; raise worker concurrency past 0.8 and executions slow each other down | Queue time-in-queue falls without execution wall time rising |
| 3 | **Queue split enforcement** — reserved concurrency for `grading.run` so a submit backlog never blocks a candidate pressing Run | Preserves interactive latency under a submit backlog; does not add throughput | Reserved run capacity is idle when nobody is running | `exec-saturation`: run latency stays bounded while submit depth grows |
| 4 | **Per-attempt execution budget** | Stops one candidate consuming a disproportionate share of the pool | A candidate who exhausts the budget must be told clearly and early, or it reads as a failure | `exec-saturation`: no single attempt exceeds its share; the message is shown in journey 3 |
| 5 | **Stagger start times** — spread invitation `opens_at` across the cohort in bands | Flattens both the start blast and, because the deadline follows the start, the stampede. The single most effective lever on the stampede | Operationally visible to the recruiter; needs a UI affordance and a documented practice | `deadline-stampede` run with and without staggering; peak queue depth compared |
| 6 | **Rate-limit the final-minute burst** | Bounds the worst case | Applied carelessly this rejects a candidate's submission, which is unacceptable. It must shape queue admission, never reject a submit — the submit is accepted with a 202 and the grading is queued, as ADR-008 already allows | `deadline-stampede`: zero rejected submits, queue drains |
| 7 | **Add execution capacity** | Linear | Cost, and it is the lever that hides the inefficiency the first six would have found | Re-run the failing gate |

Lever 6 carries a hard constraint worth repeating on its own line: **a rate limit may delay grading; it may never reject a submission.** A candidate whose submit is refused because the system is busy has lost their attempt through our capacity planning, which is the failure HLD §9 forbids.

## 11. Run protocol

A load run is an experiment. An experiment with an unrecorded configuration is an anecdote.

**Who.** Two people: the engineering lead owns the verdict, a platform engineer owns the environment. One person running alone will fix something mid-run and lose the result.

**What is frozen before the run starts**, all recorded in the run record:

- Application image digests for api, worker and collab.
- Migration state (the latest applied migration id).
- Piston runtime image digests and pre-warm counts.
- The full environment configuration — every variable in [`.env.example`](../.env.example), with secrets redacted.
- The dataset manifest hash from §9.
- The commit of the `load/` scripts.
- Node counts and instance sizes per group.

**During.** No deploys, no migrations, no other tenants, no manual queries against the primary beyond the read-only observation dashboard. A configuration change mid-run ends the run; it does not become a data point.

**After.** Within one working day, a run record is committed under `project/load-runs/` as `NNN-<scenario>-<YYYY-MM-DD>.md`, mirroring the rehearsal notes convention in [`../project/MILESTONES.md`](../project/MILESTONES.md), and containing: the frozen configuration above; the verdict per gate from §6 with the measured value beside the threshold; Grafana panel exports for the metrics in §3; the slowest ten queries from `pg_stat_statements` before and after; every anomaly observed even where the gates passed; and the actions taken, each with a tracker id. Raw k6 output goes to `load-test-results/`, which is gitignored — the record is the committed artifact, the raw output is not.

A failed gate produces a tracker task with an owner before the run record is closed. A run whose failures are recorded but unassigned will be rediscovered by a cohort.

## 12. Gates before the first campus drive

The first campus drive is the event this whole document was written for. [`../project/STATUS.md`](../project/STATUS.md) records the drive date as TBD — owner: recruiting, decide by 2026-10-30. Whatever that date turns out to be, the following must be true before it, and the scheduling rule below constrains how early it can be.

**Gate set A — required for any drive, including MCQ-only.** Due **2026-10-30** (M1 close).

| | Requirement | Evidence |
|---|---|---|
| A1 | `mcq-50-concurrent` passes all applicable gates | Run record |
| A2 | `autosave-storm` passes G5 with a value of exactly zero | Run record |
| A3 | `start-blast` at the intended cohort size passes G3 and G6 | Run record |
| A4 | `simulate` returns feasible for every assessment in the drive | API output, attached to the drive plan |
| A5 | Observability dashboards and the alerts in HLD §8 are live and were watched during A1–A3 | [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md) |
| A6 | A runbook exists for queue backlog, autosave failure and database failover | [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md) |

**Gate set B — additionally required for a drive with coding rounds.** Due **2026-12-04** (one week after M2 closes on 2026-11-27, leaving the M2 release week for the runs).

| | Requirement | Evidence |
|---|---|---|
| B1 | `coding-100-inflight` passes G4, G7 and G8 | Run record |
| B2 | `peak-1000` passes the full gate table at the intended cohort size | Run record |
| B3 | `deadline-stampede` passes G13 with zero rejected submits, both with and without lever 6 | Two run records |
| B4 | `cold-cache` passes within 5 minutes of a cold start | Run record |
| B5 | `sse-fanout` holds the cohort's stream count with no descriptor exhaustion | Run record |
| B6 | Sandbox security suite green on the exact image digests being deployed | [`06-testing-strategy.md`](06-testing-strategy.md) §14, nightly run |
| B7 | Execution capacity provisioned per §7 for the actual cohort size, not the modelled one | Infrastructure record |

**Scheduling rule.** The gated runs happen **no fewer than 10 working days before the drive**. Anything a run finds needs time to be fixed and re-measured, and a gate that passes on the morning of the drive has not been acted on — it has only been observed. If the drive date lands inside that window, the drive is batched or moved; it is not run on unverified capacity, because the product goal G3 is zero batching *and* the cost of getting it wrong falls entirely on a thousand candidates who have no recourse.

## 13. Regression cadence

Load behaviour regresses quietly. A new index, a changed serialiser, an extra query in a hot handler — none of these fail a functional test and all of them move a percentile.

| Cadence | Scope | Duration | Fails what |
|---|---|---|---|
| **Nightly** | Smoke: `mcq-50-concurrent` at reduced scale against the dev stack | ~8 min | Reports a latency regression against the 7-day baseline; does not block |
| **Every PR touching a hot path** | The endpoint-class p95 comparison from the nightly baseline, plus `EXPLAIN` diff on the attempt and grading queries | ~4 min | Blocks on a plan change from index scan to sequential scan on a tenant table |
| **Per milestone close** | The scenarios that gate that milestone (§5) | Half a day | Blocks the milestone exit criterion |
| **Per release** | `steady-500`, `exec-saturation`, `sse-fanout`, `soak-4h` | One day, soak overnight | Blocks the release |
| **Monthly** | `peak-1000` and `deadline-stampede` against current main | Half a day | Opens a tracker task; two consecutive regressions escalate to a risk-register entry |
| **Before every exam window** | §12 gate set A or B as applicable, plus a read-only production smoke | 2 h | The window does not open |
| **After any execution-tier change** | `exec-saturation` and `coding-100-inflight` | 2 h | Blocks the change |

Baselines are stored with each run record, and a regression is defined against the **median of the last three comparable runs**, not against the best one ever recorded. Comparing against a best-ever number produces a permanent alarm that the team learns to ignore, which is worse than having no baseline at all.

## 14. Open items

1. **k6 licence boundary ratification.** TBD — owner: compliance owner, decide by **2026-10-16** (§4.1). If rejected, Gatling or Artillery, and this document is revised in the same change.
2. **First campus drive date.** TBD — owner: recruiting, decide by **2026-10-30** ([`../project/STATUS.md`](../project/STATUS.md)). The §12 scheduling rule constrains it once set.
3. **Measured execution wall-time distribution** replacing the 1.5 s / 1.0 s assumptions in §2.2. Owner: platform engineer, first `exec-saturation` run, due with M2 close **2026-11-27**.
4. **Measured API throughput per instance** replacing the 125 req/s constant in §7. Owner: platform engineer, first `steady-500` run, due **2026-11-27**.
5. **Staging scale factor and budget.** Running staging at 1:1 with production for gated runs has a cost that has not been agreed. TBD — owner: engineering lead, decide by **2026-10-23**, before gate set A is due.
6. **LiveKit media capacity** for live rounds with video is unmodelled here. Owner: M3 lead, decide by **2026-11-30** (M3 start).
7. **Dedicated queue concurrency variables** for `webhooks.deliver`, `notifications.email` and `bank.jobs`, currently sharing `QUEUE_SUBMIT_CONCURRENCY` ([`../CODE-GRAPH.md`](../CODE-GRAPH.md)). A webhook fan-out at the end of a campus drive competing with grading for worker slots is the scenario that forces the split. TBD — owner: platform engineer, decide by **2026-10-19**.
