# Execution tier — Piston

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [../README.md](../README.md), [../../docs/02-HLD.md](../../docs/02-HLD.md), [../../docs/04-ADRs.md](../../docs/04-ADRs.md), [../../docs/05-licensing-and-compliance.md](../../docs/05-licensing-and-compliance.md)

---

Piston (MIT) is the sandbox that runs candidate code. ADR-002 chose it over Judge0, which is GPL-3.0 and would have blocked commercialisation. Everything in this directory concerns that one container: which runtimes it carries, how it is kept warm, how often it is thrown away, and what the resource limits mean.

Nothing here is built yet. The container runs from M0 so it is not a new variable during M2; the adapter that calls it lands in M2 (2026-11-02 → 2026-11-27).

## Files

| File | Purpose |
|---|---|
| `packages.json` | The language matrix. Targets, roles, pre-warm set. Read by the install script and by `packages/exec-adapter` for language validation. |
| `install-runtimes.sh` | Installs the matrix into a Piston instance and writes the resolved patch versions to `resolved-runtimes.json`. |
| `resolved-runtimes.json` | Generated, not written by hand. The exact versions a build actually installed. |

## The isolation rules, restated

These are not configuration. They are the reason the design tolerates a sandbox escape at all, and every one of them is asserted somewhere in `docker-compose.prod.yml`.

1. **The exec node holds no credential.** No database URL, no object-store key, no session secret, no token pepper, no OIDC client secret, no cloud IAM role. The `piston` service in both compose files declares no `secrets:` and references no `*_FILE` variable. If a change adds one, the change is wrong.
2. **The exec node has no route to anything that matters.** In production the `exec` network is `internal: true`: no egress, and no path to Postgres, Valkey, SeaweedFS, the API or the collab service. In development the network has egress so runtimes can be installed; the property that still holds in development is the one that matters most — Piston is not attached to `edge`, so it cannot reach the database.
3. **Test-case expectations never enter the sandbox.** The adapter's signature is `execute(language, version, files, stdin, limits)`. There is no question ID in it. Comparison happens in the grading worker. A candidate who escapes learns nothing about hidden cases.
4. **Nodes are ephemeral.** See recycling, below.

## Pre-warming

Cold start dominates for short programs, which is nearly all of them. A Python solution to a two-minute question runs in 40ms and waits 600ms for a container. The candidate experiences the 640ms.

Piston keeps a per-language pool of prepared execution environments. The `prewarm` list in `packages.json` names the languages worth holding: Python, Node, Java, C++ and SQLite. They are chosen by expected share of executions, not by cold-start cost alone — Swift has a worse cold start than Python and is not on the list, because warming a runtime nobody selects spends memory on every exec node for nothing.

Sizing, per `docs/02-HLD.md` section 6:

- Pool size per language starts at `cores × 0.8 / len(prewarm)`, rounded down, minimum 1.
- Warm slots are refilled in the background after an execution completes, never on the request path.
- JVM languages (Java, Kotlin) hold a warmed JVM. This is the largest single memory line on an exec node and the reason the node profile reserves 2 GB.

The number to watch is not mean latency, it is the p95 of *queue wait plus cold start* during the last five minutes of an exam window. The mean is flattered by the quiet 85 minutes.

TBD — owner: platform engineer, decide by 2026-11-27 (M2 exit): whether the pre-warm pool is sized statically or driven by the run queue's depth. Static first; measure before adding a control loop that can itself oscillate.

## Recycling cadence

`docs/02-HLD.md` section 7: "Nodes are ephemeral and recycled regularly." Concretely:

| Level | Trigger | Why |
|---|---|---|
| Execution environment | After every single execution | The overlay a job ran in is discarded. This is Piston's own behaviour and is not optional. |
| Container | Every 6 hours, or 5,000 executions, whichever comes first | Bounds the damage from a persistence technique that survives the per-job overlay but not a process restart. |
| Node | Every 24 hours, rolling | Bounds anything that survives a container restart. Kernel-level persistence is the case this covers. |

Recycling drains rather than cuts: `stop_grace_period: 60s` on the `piston` service lets an execution in flight finish. This is the same principle as the worker's drain, and for the same reason — an infrastructure event must never turn into a candidate's zero.

Recycling is suspended during a declared exam window and resumes after it closes. A rolling restart is cheap insurance on an ordinary Tuesday and an unnecessary risk during a certification exam.

TBD — owner: platform engineer, decide by 2027-01-22 (M4 exit): whether an exec node is also recycled immediately after any certification-mode execution, on the grounds that the blast radius of a high-stakes exam is different. Cost is throughput during exactly the window where throughput matters.

## Resource limits and the EXEC_* variables

Every limit is enforced by the kernel through cgroups, not by the application. An application-level timeout is a suggestion that a tight loop in C ignores.

| Variable | Default | Enforced as | What it protects against |
|---|---|---|---|
| `EXEC_CPU_TIME_MS` | 5000 | cgroup CPU accounting, per execution | A tight loop consuming a core for the full wall clock. CPU time is the honest measure: a program blocked on nothing consumes none of it. |
| `EXEC_WALL_TIME_MS` | 10000 | hard kill | Sleeping, blocking on stdin, or waiting on a DNS lookup that will never resolve. Deliberately above the CPU limit, because compiled languages spend real time compiling. |
| `EXEC_MEMORY_MB` | 256 | cgroup memory limit | Allocating until the node swaps. The container gets OOM-killed, and the killed process is reported as a failed test case, not as a platform error. |
| `EXEC_MAX_PROCESSES` | 64 | `RLIMIT_NPROC` | Fork bombs. 64 is generous for legitimate concurrency questions and far below what a fork bomb needs to hurt. |
| `EXEC_MAX_OUTPUT_BYTES` | 65536 | stream truncation, per stream | A program printing in an infinite loop, filling the disk and then the database column. Truncation happens at the sandbox boundary; `submission_results.actual_stdout` is truncated again before storage. |

Three things about these numbers:

**They are ceilings, not the values used.** Each question version carries its own limits in `coding_specs`, and the worker passes them per call. The values above are what Piston refuses to exceed regardless of what it is asked for. A question that wants 30 seconds does not get them.

**The wall-time limit is above the CPU limit on purpose.** A Rust submission can spend eight seconds compiling and 20ms running. Enforcing a single combined limit would either fail every Rust submission or give every Python submission eight seconds of CPU.

**A limit breach is a result, not an error.** A timeout produces a failed test case with the reason attached and visible to the candidate, exactly as a wrong answer does. It does not retry, and it does not move the attempt to `under_review`. Only an infrastructure failure — Piston unreachable, a malformed response — does that (`docs/02-HLD.md` section 9).

`EXEC_MEMORY_MB` is expressed in megabytes because that is what a human writes in a question spec. Piston's own `PISTON_RUN_MEMORY_LIMIT` is in bytes, so the compose files pass `EXEC_MEMORY_MB_BYTES` alongside it. Keep the two in step; a mismatch is silent and shows up as an inexplicable OOM on a 200 MB allocation.

## Installing the matrix

Development:

```sh
docker compose up -d piston
docker compose exec piston sh /piston/install-runtimes.sh
```

The first run takes a long time — it is downloading every runtime in `packages.json`, and the C# and Swift packages are large. It is a one-time cost per volume; `piston_runtimes` persists across `docker compose down` and is only lost on `down -v`.

Production: the install runs at image build time. An exec node has no egress and cannot fetch a runtime at boot, which is the point.

## Changing a version

A runtime version change changes what candidate code runs on, so it changes results. Treat it as a schema change:

1. Bump one runtime in `packages.json`, in a pull request of its own.
2. Re-run the M2 golden submission set. Record before and after in the PR body.
3. Never merge during an open exam window, and never while an attempt is in `under_review` on that language — a re-grade must reproduce the original score.

`resolved-runtimes.json` is the artefact that makes a past result explicable. It is attached to every release alongside the SBOM.
