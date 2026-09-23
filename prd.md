# Product Requirements Document
## Distributed Network Simulation on a Peer-to-Peer Node Pool (Go + SimPy, Dockerized)

- **Document owner:** Project author
- **Intended reader:** implementation agent / project reviewers
- **Status:** v3.0 — **implemented** (symmetric P2P nodes, SimPy simulation core), 2026-09-14
- **Previous version:** v2.0 (static coordinator + peers). The v2.0 implementation is archived in `.archive/`.

### Change log

| Version | Change |
|---|---|
| v2.0 | Initial design: one Go coordinator service plus stateless Go peer services, static peer list, SimPy subprocess per task. |
| v3.0 | **Symmetric P2P architecture.** Coordinator and peer are merged into one `node` binary; any node can coordinate a batch. |
| v3.0 | New node-to-node endpoint `POST /task`. Busy nodes answer `503` without using up a retry. The serial baseline runs on the coordinating node. |
| v3.0 | Security hardening: non-root containers, capability drop, read-only root filesystem, loopback-only ports, concurrency limits, minimal subprocess environment, Go 1.27. |
| v3.0 | Verification results recorded (§15). Proposed next phase — GUI and cyber-attack scenarios — added as a draft (§16). |

---

## 1. Summary

Build a system that runs statistically valid network-queueing simulations. It spreads independent, individually seeded simulation replications across a static pool of **identical nodes**.

- **Every node runs the same Go binary** and has two roles:
  - **Worker:** it executes simulation tasks it receives from other nodes.
  - **Coordinator:** when it receives `POST /run`, it splits the batch into tasks, dispatches them to every node (including itself), aggregates the results, and validates them against closed-form M/M/1 formulas.
- **There is no permanent coordinator.**
- **The simulation logic is Python/SimPy.** Each task invokes `simulate.py` as a subprocess and parses a one-line JSON result.
- **Membership is a static peer list** shared by all nodes. There is no discovery.

This is **not** a partitioned/synchronized simulation (no PDES). Each task is one complete, independent replication. A seed fully determines its result. As a consequence, duplicate execution is harmless and lost work can always be reproduced. That property is what makes a leaderless design simple.

---

## 2. Problem Statement & Motivation

**Why many replications:** a trustworthy mean and confidence interval need many independent replications. Running them serially on one machine is slow, and renting cloud compute costs money. Idle lab machines, or containers standing in for them, are often available.

**Goal:** distribute replications across a small pool of peer nodes, so that results are obtained faster using only existing compute. There is no cluster manager, no cloud billing, and no single machine that must stay up for the pool to accept work.

**Primary users:** students and researchers running on lab machines or local Docker containers.

---

## 3. Why Go for the services, Python/SimPy for the simulation

- **Go** handles orchestration: the HTTP server and client, per-request timeouts, retries, goroutine worker pools, and JSON. It produces a small static binary.
- **SimPy** is a mature discrete-event simulation library. Its `simpy.Resource`, `env.timeout` and `env.process` primitives fit queueing models directly. Rewriting a DES engine in Go is out of scope.
- **The bridge:** a subprocess boundary plus a JSON contract. The Go code knows only the CLI's input/output schema. Each side is tested independently.

---

## 4. Goals

1. **SimPy simulation:** a single-queue simulation — M/M/1 baseline, M/D/1 available, pluggable arrival and service generators — as a standalone CLI (§7).
2. **One Go `node` service** on every machine, exposing:
   - **Worker endpoint:** `POST /task` runs one replication via the subprocess. It returns `400` with the captured stderr on failure, and `503` when the node is at its concurrency limit.
   - **Coordinator endpoints:** `POST /run`, `GET /status`, `GET /report` for batches this node coordinates.
   - **Utility endpoints:** `GET /peers` (pool health) and `GET /health`.
3. **Any node can coordinate a batch.** The coordinating node:
   - generates individually seeded tasks,
   - dispatches them concurrently to all nodes (itself in-process),
   - retries failures with backoff,
   - aggregates mean, stddev and 95% CI,
   - compares against M/M/1 theory with a pass/fail tolerance,
   - optionally measures a serial baseline and the resulting speedup.
4. **One Docker image** (Go binary plus Python/SimPy), orchestrated with Docker Compose. Adding a node is a Compose service plus a peer-list entry.
5. **A final report:** aggregated delay and queue length with CIs, theory comparison, tasks per node, and distributed vs serial wall-clock time.

## 5. Non-Goals

- **PDES / partitioned single-run simulation.**
- **Dynamic membership:** no discovery, gossip, DHT, NAT traversal, or join/leave protocols. The peer list is static.
- **Leader election and automatic failover of an in-flight batch.**
  - A batch's state lives on its coordinating node. If that node dies, the client resubmits the same `base_seed` to another node, which reproduces the batch exactly.
  - Election with state replication is a stretch goal (§13).
- **Authentication, TLS, and defense against malicious nodes.** A trusted pool is assumed; hardening in §11 limits the blast radius.
- **Non-Poisson traffic (Pareto, MMPP).** The generators are pluggable, but only Poisson arrivals and exponential/deterministic service are implemented.
- **A GUI.** Still out of scope for v3.0; proposed in §16.
- **Rewriting the simulation engine in Go.**

---

## 6. System Architecture

```
            client ── POST /run (to ANY node) ──┐
                                                ▼
  ┌─────────────┐   POST /task   ┌───────────────────────┐   POST /task   ┌─────────────┐
  │ node-1      │◀───────────────│ node-2                │───────────────▶│ node-3      │
  │ worker      │────result─────▶│ coordinates this batch│◀────result─────│ worker      │
  │ simulate.py │                │ + executes own share  │                │ simulate.py │
  └─────────────┘                │   in-process          │                └─────────────┘
                                 └───────────────────────┘
  Every node: same image, same peers.yaml, same node.yaml; unique NODE_ID.
```

- **Communication:** coordinator-initiated request/response over HTTP. Workers never initiate messages.
- **Symmetry:** every node is simultaneously a worker for others and a potential coordinator. Several nodes may coordinate their own batches at the same time.
- **Node internals** (Go packages):

| Package | Role |
|---|---|
| `worker` | Concurrency-limited executor, shared by local and remote tasks |
| `sim` | Subprocess runner |
| `dispatch` | Worker pool, task state machine, retry, backoff, and `RoutingClient` (self → in-process, others → HTTP) |
| `batch` | Batch lifecycle and report |
| `stats` | Mean/CI and M/M/1 theory |
| `api` | HTTP routes |
| `peers`, `config` | Static membership and settings |

---

## 7. Core Simulation Model (Python + SimPy)

### 7.1 Model

- **Arrivals:** Poisson, rate λ. **Service:** exponential, rate μ (`--service det` gives M/D/1).
- **Queue:** FIFO, single server, infinite buffer.
- **Run length:** `sim_time`. Statistics before `warmup_time` are discarded.
- **Generators:** arrival and service generators are registered factories, so new traffic models plug in without changing the simulation loop.

### 7.2 CLI contract (the Go↔Python interface)

```bash
python3 simulate.py --seed 42007 --lam 0.8 --mu 1.0 --sim-time 10000 --warmup-time 1000
```

stdout — exactly one JSON line:

```json
{"seed":42007,"mean_wait_time":4.87,"mean_queue_length":3.91,"utilization":0.79,"packets_served":7213,"runtime_seconds":0.42}
```

- **Diagnostics:** all go to stderr.
- **Exit codes:** `0` on success; `1` on invalid parameters (e.g. ρ ≥ 1) or an internal error.
- **Metric definitions** (measured after warm-up):

| Field | Meaning |
|---|---|
| `mean_wait_time` | Mean **time in system** |
| `mean_queue_length` | Time-averaged **number in system** |
| `utilization` | Time-averaged busy fraction of the server |

### 7.3 Implementation shape

- **`run_replication(...)`:** a pure, deterministic function per seed that raises `ValueError` on invalid input.
- **CLI wrapper:** a thin `argparse` layer around it.
- **Tests:** unit-tested with pytest against the closed forms.

### 7.4 Validation target

For ρ = λ/μ < 1: `L = ρ/(1−ρ)`, `W = 1/(μ−λ)`.

The coordinating node reports:
- relative error,
- whether the theoretical value lies inside the 95% CI,
- PASS/FAIL against `tolerance_pct` (applied to W and L).

---

## 8. Distribution Protocol

### 8.1 Wire types (package `task`, shared by all roles)

```go
type SimParams struct { Lambda, Mu, SimTime, WarmupTime float64 }        // json: lambda, mu, sim_time, warmup_time
type Task      struct { TaskID string; Seed int64; Params SimParams }    // json: task_id, seed, params
type Result    struct { TaskID, PeerID string; Seed int64; MeanWaitTime, MeanQueueLength,
                        Utilization float64; PacketsServed int64; RuntimeSeconds float64 }
var ErrBusy // node at its concurrent-task limit (HTTP 503) — task not attempted
```

### 8.2 Coordinating node responsibilities (the node that received `POST /run`)

1. **Membership.** Load the static peer list at startup. Its own `NODE_ID` must be in the list, or the node refuses to start.
2. **Accept a run request.** `{"replications", "lambda", "mu", "sim_time", "warmup_time", "tolerance_pct", "base_seed", "serial_baseline"}`. All fields are optional (defaults come from `node.yaml`), unknown fields are rejected, and validation errors return `400`. One batch runs per coordinating node at a time (`409` otherwise).
3. **Generate N tasks.**
   - Seeds: `seed = base_seed + task_index`. `base_seed` defaults to current Unix ms, and is returned, logged and reported.
   - IDs: batch and task IDs embed the coordinator's node id, so they are unique across the pool.
4. **Track task state** in a mutex-guarded in-memory table: `pending → assigned → complete | failed`.
5. **Dispatch with a worker pool.**
   - One goroutine per node in the list, all pulling from a shared queue.
   - A `RoutingClient` sends the node's own tasks to its local executor (in-process) and others via `POST /task`.
   - Every HTTP call has an explicit context timeout (`request_timeout`, default 30s).
6. **Retries and backoff.**
   - A timeout, connection error, or non-2xx response (other than 503) is a failed attempt: the task is requeued for any node.
   - After `max_attempts` (3) the task is permanently `failed` and listed in the report.
   - After any failure, that node's worker backs off exponentially (`backoff_initial`…`backoff_max`) and takes no work until `GET /health` succeeds. This stops a crashed node from draining the queue and burning every task's retry budget.
7. **Busy handling.** A `503` / `ErrBusy` means nothing was executed. The task is released back to `pending` and requeued **without** charging an attempt, and the node's worker backs off.
8. **Aggregation.** Mean, sample stddev, and 95% CI (normal approximation, valid for n ≥ 30) of `mean_wait_time`, `mean_queue_length` and `utilization`. These are compared against W, L and ρ.
9. **Serial baseline** (optional, default on).
   - Re-runs the same seeds one at a time on the coordinating node alone, and reports both wall-clock times and the speedup.
   - Because seeds match, it also checks `serial_results_match_distributed`.
10. **Endpoints.**
    - `/status`: counts per state, including failed attempts and phase.
    - `/report`: full aggregation, verdict, tasks per node, failed tasks, timing, and `coordinator`.
    - Only this node holds that batch's state; the last 10 batches are retained.

### 8.3 Executing responsibilities (every node)

1. `GET /health` → `{"status":"ok","node_id","peers"}`.
2. `POST /task` with a `Task` body:
   - **Capacity:** if `max_concurrent_tasks` simulations are already running (the node's own batch included), return `503` immediately.
   - **Execution:** otherwise run `simulate.py` via `os/exec` (no shell) with a `sim_timeout` context, which must be less than `request_timeout`.
   - **Captured output:** stdout and stderr are captured with size caps; the child gets a minimal environment.
   - **Success:** parse the JSON line, verify the echoed seed, stamp `peer_id`, and return `200`.
   - **Failure:** return `400 {"task_id","error"}` with the stderr or parse error.
3. Workers are stateless between tasks.

### 8.4 Coordinator loss

- **What is lost:** batch state is not replicated, so the batch disappears with its coordinating node. Its tasks already running on other nodes finish and are discarded.
- **Recovery:** the client resubmits the same request (same `base_seed`) to any surviving node. Determinism guarantees identical results. `scripts/kill-coordinator-test.sh` demonstrates this.

### 8.5 Why this protocol

- **No causal coordination is needed:** replications are independent. PDES would add synchronization cost for no benefit unless a single run cannot fit on one machine.
- **Failures are cheap:** a dead worker costs one reassigned task. A dead coordinator costs one resubmission.
- **Go fits the pattern:** goroutines plus channels are the standard worker-pool shape.
- **Why no election:** determinism by seed makes duplicate or repeated execution harmless. A leaderless "whoever receives the request coordinates" design avoids election and split-brain entirely.

---

## 9. Docker & Deployment

### 9.1 Layout

- **`node/`:** the Go module and a multi-stage Dockerfile.
  - Stage 1 (`golang:1.27`) builds a static binary.
  - Stage 2 (`python:3.11-slim`) installs `simpy`, copies `simulate.py` and the binary, and runs as uid 10001.
- **`sim/`:** `simulate.py`, tests, and requirements.
- **`config/`:**
  - `peers.yaml`: static membership, shared by all nodes.
  - `peers.4.yaml`: the scaling variant.
  - `node.yaml`: shared settings and run defaults.

### 9.2 Static peer list

```yaml
peers:
  - id: node-1
    url: http://node-1:8000
  - id: node-2
    url: http://node-2:8000
  - id: node-3
    url: http://node-3:8000
```

Hostnames match Compose service names. Every node mounts the same file and identifies itself with `NODE_ID`.

### 9.3 Compose

- **Services:** `node-1..3`, all built from one image.
- **Host ports:** published on `${NODE_BIND:-127.0.0.1}` as 8081–8083 (overridable).
- **Config:** mounted read-only.
- **Hardening:** `read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp`, `pids_limit`, `mem_limit`.

### 9.4 Running

```bash
docker compose up --build
curl -X POST http://localhost:8082/run -H "Content-Type: application/json" \
  -d '{"replications": 100, "lambda": 0.8, "mu": 1.0, "sim_time": 10000, "warmup_time": 1000}'
curl http://localhost:8082/status
curl http://localhost:8082/report
```

### 9.5 Scaling to 4 nodes

`docker compose -f docker-compose.yml -f docker-compose.node4.yml up --build` adds `node-4` and switches **all** nodes to `peers.4.yaml`. No code changes are needed.

### 9.6 Real machines

- **Install:** run the same image on each machine with a unique `NODE_ID`, a shared `peers.yaml` containing LAN or VPN addresses, and the port published.
- **Network:** firewall port 8000 to pool members only.
- **Multi-core machines:** run several node processes and list each one.

---

## 10. API Specification (identical on every node)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/run` | `{"replications","lambda","mu","sim_time","warmup_time","tolerance_pct","base_seed","serial_baseline"}` (all optional) | `202 {"batch_id","status":"started","coordinator","replications","base_seed","peers"}`; `400` invalid; `409` busy |
| GET | `/status` | — (`?batch_id=`) | `{"batch_id","coordinator","state","phase","replications","pending","assigned","complete","failed","failed_attempts","elapsed_seconds","serial_baseline"}`; `404` if not coordinated here |
| GET | `/report` | — (`?batch_id=`) | Aggregation per metric (`n, mean, stddev, ci95_low/high, theoretical, rel_error_pct, within_tolerance, theoretical_in_ci`), `verdict`, `tasks_per_peer`, `failed_tasks`, `timing` |
| GET | `/peers` | — | `{"node_id","peers":[{"id","url","self","healthy","error"}]}` |
| GET | `/health` | — | `{"status":"ok","node_id","peers"}` |
| POST | `/task` | `Task` | `200 Result`; `400 {"task_id","error"}`; `503` busy |

---

## 11. Non-Functional Requirements

- **Languages:**
  - Go ≥ 1.22 language level, built with a supported toolchain (1.27), standard-library `net/http`.
  - Python 3.11+ with `simpy`.
- **Concurrency:**
  - The worker pool is sized to the peer list.
  - Per-node execution is bounded by `max_concurrent_tasks`.
  - There is no unbounded goroutine or subprocess spawning.
- **Logging:** structured JSON logs (`log/slog`) that include `node_id`, `batch_id`, `task_id`, `peer_id`, and timings. Python logs only to stderr.
- **Reproducibility:** identical seeds and parameters give identical per-task results, regardless of coordinator or node count.
- **Timeouts:**
  - Every node→node HTTP call has a context timeout, and every subprocess has `sim_timeout`.
  - `sim_timeout` must be less than `request_timeout`; this is enforced at startup.
  - The HTTP servers set read, write and idle timeouts.
- **Security hardening:**
  - Loopback-only published ports by default; non-root containers with dropped capabilities and a read-only root filesystem.
  - Supported Go toolchain; size-capped request bodies and subprocess output.
  - Minimal subprocess environment; redirects never followed; bounded batch history.
- **Testability:**
  - pytest for the model.
  - Go unit tests with fake command runners, fake peer clients and fake executors — no Docker, network or Python needed.
- **Config-driven:** membership, timeouts, limits and run defaults come from `config/` or environment variables. There are no hardcoded node counts or URLs.

---

## 12. Repository Structure

```
.
├── node/
│   ├── cmd/node/main.go
│   ├── internal/
│   │   ├── api/        # HTTP routes: /run /status /report /peers /health /task
│   │   ├── batch/      # batch lifecycle, serial baseline, report
│   │   ├── config/     # node.yaml + env overrides, validation
│   │   ├── dispatch/   # worker pool, task state machine, retry/backoff/busy, HTTP + local + routing clients
│   │   ├── peers/      # static peer list loading/validation
│   │   ├── sim/        # simulate.py subprocess runner (mockable CommandRunner)
│   │   ├── stats/      # mean/stddev/CI, M/M/1 theory comparison
│   │   ├── task/       # shared wire types, ErrBusy
│   │   └── worker/     # concurrency-limited executor
│   ├── go.mod, go.sum
│   └── Dockerfile
├── sim/                # simulate.py, test_simulate.py, requirements*.txt
├── config/             # peers.yaml, peers.4.yaml, node.yaml
├── scripts/            # demo.sh, kill-node-test.sh, kill-coordinator-test.sh
├── docker-compose.yml, docker-compose.node4.yml
└── README.md
```

---

## 13. Stretch Goals

- **Coordinator failover:**
  - Leader election (e.g. lowest healthy `NODE_ID`) with periodic replication of completed results, so a new coordinator resumes only the missing seeds.
  - Determinism makes duplicate execution during a network partition harmless.
- **Persistence:** task state stored in SQLite/BoltDB so a coordinating node can resume after a restart.
- **Finite buffer:** an M/M/1/K variant with blocking-probability reporting.
- **More traffic models:** Pareto, self-similar and MMPP generators.
- **Authentication:** a shared-secret header or mTLS between nodes.
- **Small-n CIs:** Student-t confidence intervals.
- **Per-node parallelism:** run several local worker slots on the coordinating node itself.
- **Supply-chain pinning:** hash-pinned Python dependencies and digest-pinned base images.
- **GUI and cyber-attack scenarios** — see §16.

---

## 14. Acceptance Criteria (v3.0)

| # | Criterion | Status |
|---|---|---|
| 1 | `docker compose up --build` brings up 3 identical nodes with no manual steps. | Implemented; Compose config validated. **Image build not yet run** (the dev machine lacks Docker group access). |
| 2 | `POST /run` with 100 replications (ρ < 1) on **any** node produces a `/report` whose W and L are within tolerance (10%), with theory inside the 95% CI. | **Verified** (§15) |
| 3 | Stopping a non-coordinating node mid-batch: its in-flight task is reassigned and the batch completes. | **Verified** |
| 4 | Stopping the coordinating node mid-batch: resubmitting the same `base_seed` to another node completes and reproduces identical statistics. | **Verified** |
| 5 | Adding a 4th node needs only a Compose service and peer-list entry, with no code changes. | **Verified** (config-only restart) |
| 6 | The distributed wall clock is measurably below the serial single-node baseline, and both are reported. | **Verified** |
| 7 | `run_replication()` has passing pytest tests against M/M/1. | **Verified** (16 tests) |
| 8 | Go stats, dispatch/retry/busy, routing, executor, runner and API have passing unit tests without Docker, network or Python. | **Verified** (`go test -race ./...`) |
| 9 | Two nodes can coordinate batches concurrently; busy nodes do not cause permanently failed tasks. | **Verified**: node-1 and node-3 each coordinated 100 reps concurrently; both PASS, 0 failed |

## 15. Verification Results (local run, 16-core host, native processes)

| Scenario | Result |
|---|---|
| 100 reps via node-3, λ=0.8, μ=1, base_seed 42000 | PASS; W mean 5.0623 (1.25% error), L mean 4.0590 (1.47%); theory inside CI; tasks 33/33/34 |
| Serial baseline on coordinating node | 8.94s vs 3.21s distributed → **2.78× speedup**; `serial_results_match_distributed: true` |
| Kill worker node-2 mid-batch (coordinator node-1) | 100/100 complete, 0 failed, 1 failed attempt reassigned; PASS |
| Kill coordinator node-1 mid-batch, resubmit base_seed 777 to node-2 | 100/100 complete, 0 failed, PASS. Same batch via node-3 gave an identical W mean (5.028339980183226) |
| v2.0 architecture, same seeds | Identical statistics to v3.0: the refactor did not change results |
| 4 nodes (v2.0 run) | 3.67× speedup; 25 tasks per node |

---

## 16. Proposed Next Phase (draft — not implemented): GUI and cyber-security attack scenarios

**Requested capability:** a GUI in which a user selects a simulated network attack, runs it on the P2P pool, and sees how estimated network performance degrades compared with the no-attack baseline.

### 16.1 Proposed approach

- **Scenario catalog.** Attacks are modeled as perturbations of the queueing model in `simulate.py`, using the existing pluggable generators. Each attack has an attack window `[t_start, t_end]`.

| Attack | Queueing model | Key parameters | Metrics impacted |
|---|---|---|---|
| Volumetric DDoS / flood | Extra Poisson attack stream λₐ added to legitimate λ | λₐ, window | Delay, queue length, utilization; ρ ≥ 1 during the attack means an unbounded queue |
| SYN flood / connection exhaustion | Finite buffer M/M/1/K; attack arrivals occupy slots | K, λₐ, hold time | **Drop/blocking probability** of legitimate traffic |
| Slowloris / low-and-slow | Attack jobs with very long service times holding the server (M/G/1, heavy tail) | Attack rate, service-time distribution | Legitimate delay, head-of-line blocking |
| Pulsing (on-off) DDoS | MMPP / on-off arrival stream | On/off durations, burst rate | Delay variance, recovery time |
| Link or server degradation | Reduced service rate μ′ during the window | μ′, window | Throughput, delay |
| Mitigation (optional) | Rate limiter or filter dropping a fraction of attack traffic | Filter efficiency, false-positive rate | Residual degradation vs mitigation cost |

- **Metrics per scenario:**
  - Legitimate-traffic mean delay, queue length, drop rate and throughput.
  - Peak and time-to-recover after the attack window.
  - Each with 95% CI across replications, reported relative to the baseline (same seeds, no attack).
- **Sanity check:** where closed forms exist (Poisson flood gives M/M/1 with λ+λₐ; M/M/1/K blocking probability), the report validates against theory as today.
- **Protocol impact:** a `scenario` object is added to `SimParams` / `POST /run`. The distribution layer is unchanged, since tasks are still independent seeded replications.
- **GUI.** A single-page web dashboard served by every node (`GET /ui`, static assets embedded in the Go binary). It provides:
  - scenario picker and parameter form,
  - live progress per node (polling `/status`),
  - charts of baseline vs attack with CI bands, and time-series of queue length across the attack window,
  - node health and the tasks-per-node split,
  - a history of runs.

  No separate frontend service is needed, so any node's port serves the UI.

### 16.2 Open questions (need owner decisions)

1. Which attacks are in scope for the first release? (Suggested: flood, SYN flood / finite buffer, slowloris.)
2. Should mitigations or defenses be modeled, or only the attacks?
3. GUI form: a web dashboard served by the nodes (suggested), or a desktop application?
4. Are time-series outputs (queue length over time) needed? This changes the one-line JSON contract to include sampled series.
5. Should results be exportable (CSV/PDF) for reports?
