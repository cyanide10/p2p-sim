# p2p-sim — end-to-end architecture (briefing for an AI agent)

This document describes the system **as implemented** (as of commit `1b46ed4`,
2026-10-26). Read it before changing code. It tells you what each layer does,
the contracts between layers, the invariants you must not break, and where to
make common changes. File paths are relative to the repo root.

---

## 1. What the system is

A distributed discrete-event simulation platform built from four layers:

```
 Browser (React GUI, web/)
        │  HTTP JSON + SSE, same origin
        ▼
 Gateway (Go, gateway/)  ── SQLite run history, serves the built GUI
        │  HTTP to any node (static peer list)
        ▼
 Node pool (Go, node/) — N identical nodes, no permanent coordinator
        │  subprocess, JSON over stdin/stdout
        ▼
 Simulators (Python + SimPy, sim/)  simulate.py (M/M/1)  netsim.py (packet network)  attacksim.py (threat campaigns)
```

**Core principles**

- **Symmetric peers.** Every node runs the same binary and reads the same
  `config/peers.yaml` (static membership, no discovery or gossip). Whichever
  node receives a run request *coordinates* that run. It sends work to all
  peers, itself included (in-process, not over HTTP).
- **Go orchestrates, Python simulates.** They share only a JSON-on-stdio
  contract: stdout carries only JSON, diagnostics go to stderr, exit 0 means
  success and exit 1 means invalid input or failure.
- **Seeds determine everything.** Results are reproducible bit-for-bit from
  `base_seed`. That is how failover works: if a coordinator dies, resubmitting
  the same seed elsewhere reproduces the run.
- **Run state lives only on the coordinator.** The gateway polls it and
  persists snapshots. If the coordinator dies, the gateway marks the run
  `coordinator_lost`.

---

## 2. Run kinds

| Kind | Node entry point | What it does | Simulator mode |
|---|---|---|---|
| `mm1` (default) | `POST /run` | N independent M/M/1 replications spread over the pool, checked against queueing theory; optional serial baseline for speedup | `simulate.py --seed …` |
| `network` | `POST /netrun` | N independent replications of one packet-network scenario spread over the pool, aggregated with 95% CIs | `netsim.py --seed N` |
| `pdes` | `POST /pdesrun` | **One** network simulation split into k partitions across nodes, synchronized conservatively in lock-step windows; optional k=1 baseline to check identical results and measure speedup | `netsim.py --plan`, `--partition`, `--merge` |
| `attack` | `POST /attackrun` | **One** threat campaign split into k topology-token partitions across nodes in lock-step windows; `parts=1` is a single worker, and the merged samples match the browser model exactly | `attacksim.py --plan`, `--partition`, `--merge` |
| live M/M/1 | `GET /stream` (SSE) | One replication paced to wall clock, streamed to the browser | `simulate.py --stream` |
| live network | `POST /netstream` (SSE) | One network replication paced to wall clock, can start mid-run | `netsim.py --stream` |

**One coordinated batch per node:** `dispatch.CoordinatorSlot` is shared by
the M/M/1 and network managers, so a node coordinates at most one of those at
a time (it returns 409 otherwise). The PDES manager has its own
one-run-at-a-time check (`ErrCoordinatorBusy`).

---

## 3. Simulation layer — `sim/`

### 3.1 `sim/simulate.py` — M/M/1
- CLI: `--seed --lam --mu --sim-time --warmup-time`, prints one JSON line
  with `mean_wait_time`, `mean_queue_length`, `utilization`, `packets_served`
  (measured over `[warmup, sim_time]`).
- `--stream --speed S` prints a JSON event per line: `meta`, then
  `arrival`/`start`/`depart`, then `stats`, then `done`.

### 3.2 `sim/netsim.py` — packet network (~1,100 lines)
**Model.** Hosts send and receive flows and never forward. Routers are
single-server FIFO queues (`service_rate`, finite `buffer`). Links are
bidirectional; each direction transmits one packet in `1/bandwidth` from a
finite buffer, then the packet propagates for `delay`. Routing is shortest
path by latency (`delay + 1/bandwidth`), recomputed by `compute_routes` on
every failure and recovery. Flow patterns are constant Poisson, rate schedule
(step or linear, via thinning) and on/off bursts. Events take links or
routers down and up at fixed times.

**Modes** (scenario JSON on stdin):

| Flag | Output |
|---|---|
| `--validate` | `{"ok":true,…summary}` or exit 1 |
| `--seed N` | one line: `seed`, `runtime_seconds`, `metrics` |
| `--stream --seed N --speed S [--start T]` | paced events: `hop`, `send`, `deliver`, `drop`, `failure`, `stats`, `seek` |
| `--plan --parts K` | partition plan (see 3.4) |
| `--partition` | long-lived JSON-lines worker (see 3.5) |
| `--merge` | merges partition states into canonical metrics |

**Limits.** Normal modes allow 60 nodes, 120 links, 40 flows, 60 events,
duration ≤ 3600 and 150,000 offered packets. Partitioned validation
(`validate(..., partitioned=True)`) allows 2,000 nodes, 6,000 links, 400 flows
and 200 events. The GUI mirrors the *normal* limits in
`web/src/lib/network.ts` (`LIMITS`).

**Key classes and functions**
- `_entity_rng(seed, kind, id)` gives one random stream per entity, seeded
  from `sha256("{seed}:{kind}:{id}")`, with kinds `router` and `flow`.
  Results therefore don't depend on global event order. **Do not go back to a
  shared RNG**, or partitioned runs stop matching.
- `Network`: SimPy model. `Station` holds queue and server statistics, plus
  an `epoch` that is bumped on failure so in-flight packets see the change.
  Packet life is `packet` → `_route_packet` → (`_traverse_link` →
  `_receive_arrival`)*.
- `ArrivalRecord(flow, seq, born, link, from, to, start, arrive)` is created
  when a packet *starts transmission*. If `to` belongs to another partition,
  the record goes into `self.outbound` and the sender stops tracking the
  packet.
- `Network.metrics()` produces the canonical metrics JSON: `flows`, `links`,
  `routers`, `totals`, `series` (40 bins), with values rounded to 6 decimals.
- `Network.partition_state()` returns the raw unrounded counters that the
  merge step sums.

### 3.3 Ownership rules (needed for exact merging)
- A router (queue and service) belongs to its partition.
- Link direction `a→b` (its transmit queue) belongs to `a`'s partition.
- A host belongs to the partition of its attached router. A flow is generated
  in the source host's partition, and its delays are recorded in the
  destination host's partition.
- Every partition holds the **full** scenario and applies **every** failure
  event, so routing tables stay identical everywhere without any messages.
- The receiver drops an arriving record as `link_down` if a `down` event for
  that link falls in `(start, arrive]`, or the link is down at `arrive`
  (`_link_failed_during`).

### 3.4 Partition planner — `partition_plan(sc, k)`
Deterministic, with no randomness:
1. Fold each host into its attached router.
2. Pick k seed routers by repeated farthest-point selection (hop count, ties
   broken by id).
3. Grow regions breadth-first. The smallest region expands next and takes the
   frontier router reached over the lowest-latency link, so high-latency links
   tend to become the cuts.
4. `lookahead = min over cut links of (1/bandwidth + delay)`. If there are no
   cuts, it is the full duration. `windows = ceil(duration / lookahead)`.
   Plans needing more than 200,000 windows are rejected.

Output: `{ok, parts, assignment{node→part}, cut_links[], lookahead, windows, load[]}`.

### 3.5 Partition worker — `PartitionWorker` / `_partition_protocol`
JSON lines on stdin/stdout:

| Request | Reply |
|---|---|
| `{"op":"open","scenario","plan","part","seed"}` | `{"ok":true}` |
| `{"op":"step","until":T,"inbound":[records]}` | `{"outbound":[records],"compute_s","events"}` |
| `{"op":"finish"}` | `{"metrics":{…},"state":{…}}`, then the worker exits |
| any error | `{"error":"…"}` |

`step` validates each inbound record (known flow, endpoints match the link,
`arrive ≥ start + 1/bw + delay`, addressed to this partition, not in the
past), sorts records by `(arrive, link, flow, seq)`, schedules them with
`inject_arrival`, then runs `env.run(until=T)`. The safety argument: a record
produced in window `[T0, T0+L)` has `arrive ≥ T0+L`, so it is never in the
receiver's past.

`merge_partition_states(scenario, states)` sums the raw counters, puts the
per-bin delay values in canonical order, and calls `metrics()` on a fresh
`Network`. The result is comparable byte-for-byte with a k=1 run.

### 3.6 `sim/attacksim.py` — threat campaigns
The attack model is analytic and shares the same CLI, planner and worker
protocol as `netsim.py`. It turns a campaign scenario (`kind`, `duration`,
`step`, `seed`, `scale`, `intensity`, `capacity`, `defense`, `phases`, `nodes`)
into a fixed sample grid plus one `load`/`compromise` pair per topology token.
The browser implements the same equations in `web/src/lib/attack.ts`, so a
node result rebuilds the local presentation model exactly.

Partitioning splits the topology tokens, not the campaign clock. Every worker
advances the same windows in lock-step and records telemetry only for the
tokens it owns; the campaign state is global, so `outbound` is always empty.
`merge_partition_states` concatenates the per-token maps and emits the same
metrics as a single worker, and `parts=1` is the ordinary single-worker path.

---

## 4. Node layer — `node/` (Go)

Entry point: `node/cmd/node/main.go`. It wires everything together and builds
the HTTP handler chain:

```
GET /stream                 → api.StreamHandler (live M/M/1)
everything else             → pdes.NewHandler
                               └─ falls through to api.NetworkHandler
                                   └─ falls through to api.NewHandler (M/M/1 + /task, /health, /peers)
```

`GET /status` and `GET /report` are routed by `batch_id`. Each handler serves
its own kind and passes other IDs to the next handler (`statusOrNext` /
`reportOrNext`).

### 4.1 Packages

| Package | Responsibility |
|---|---|
| `config` | Loads `config/node.yaml`; any key can be overridden by the same name in upper case as an env var (e.g. `REQUEST_TIMEOUT`). |
| `peers` | Loads `peers.yaml` (`[{id,url}]`). The node refuses to start if `NODE_ID` is not listed. |
| `task` | Task/Result types, `ErrBusy`. |
| `sim` | Subprocess wrappers. `SimRunner` (one replication for `simulate.py` or `netsim.py --seed`), `Streamer` (M/M/1 SSE), `Network` (`Validate`, `Plan`, `Merge`, `Stream` for netsim). The subprocess gets a minimal env and capped output buffers. |
| `worker` | `Executor`: a semaphore of `max_concurrent_tasks` slots (default 2). `Execute` and `Acquire` return `ErrBusy` immediately when full; the HTTP layer turns that into **503**. Batch tasks, live streams and PDES partitions share these slots. |
| `dispatch` | Coordinator side of replication batches. `GenerateTasks` sets **seed = base_seed + task_index**. `Dispatcher.Run` runs one goroutine per peer, all pulling from a shared queue. A failure requeues the task and charges an attempt (up to `max_attempts`, default 3). A 503 requeues **without** charging an attempt. A failing peer backs off exponentially and must pass `GET /health` before taking more work. `RoutingClient` sends tasks for self through `LocalClient` (in-process) and tasks for others through `HTTPClient` (`POST /task`). `Tracker` holds per-task state. `CoordinatorSlot` means one batch per node. |
| `batch` | M/M/1 batch manager. Phases: distributed run, then optional `serial_baseline` (same seeds, run serially on the coordinator). The report has mean, stddev and 95% CI against theory (W = 1/(μ−λ), L = ρ/(1−ρ)), a verdict within `tolerance_pct`, tasks per node and speedup. |
| `netbatch` | Network replication batch manager: same dispatcher, report aggregates per-flow, per-link and per-router metrics with CIs. |
| `api` | HTTP handlers: `/run`, `/task`, `/status`, `/report`, `/peers`, `/health` (`api.go`); `/netrun`, `/netstream`, network `/status`/`/report` (`network.go`); `/stream` SSE (`stream.go`). |
| `pdes` | Partitioned simulation (section 5). |

### 4.2 Node HTTP API (port 8000)

| Method | Path | Notes |
|---|---|---|
| POST | `/run` | M/M/1 batch. 202 `{batch_id, base_seed, peers…}`, 400 invalid, 409 busy |
| POST | `/netrun` | `{scenario, replications, base_seed}` |
| POST | `/pdesrun` | `{scenario, parts?, base_seed?, baseline?}` (`parts` defaults to the number of healthy nodes) |
| POST | `/pdes/plan` | `{scenario, parts}` → plan preview |
| POST | `/attackrun` | `{scenario, parts?, base_seed?, baseline?}` threat campaign (`parts=1` is one worker) |
| POST | `/attack/plan` | `{scenario, parts}` → topology-token plan preview |
| GET | `/status?batch_id=` / `/report?batch_id=` | any kind; defaults to the latest |
| GET | `/pdes/status`, `/pdes/report` | PDES-specific |
| GET | `/attack/status`, `/attack/report` | threat-campaign-specific |
| POST | `/task` | node to node: one replication; 200, 400 sim error, 503 busy |
| POST/DELETE | `/pdes/{run}/open|step|finish`, `DELETE /pdes/{run}` | node to node: partition host; bodies capped at 8 MiB |
| POST/DELETE | `/attack/{run}/open|step|finish`, `DELETE /attack/{run}` | node to node: threat-campaign partition host |
| GET | `/stream` | SSE live M/M/1 (ρ ≤ 1.5, λ×speed ≤ 200/s) |
| POST | `/netstream` | SSE live network (≤ 150 packets/s) |
| GET | `/health`, `/peers` | liveness; health of the peer list as seen from this node |

### 4.3 Timeouts (config/node.yaml)
`request_timeout 30s` must exceed `sim_timeout 25s`, so the executing node
fails first. Other settings: `health_timeout 2s`, `backoff 500ms → 10s`,
`phase_timeout 1h`, `pdes_step_timeout 30s`. The server's `WriteTimeout` is
the largest of these plus a margin.

---

## 5. PDES — `node/internal/pdes/`

| File | Role |
|---|---|
| `types.go` | `ArrivalRecord`, `StepRequest/Response`, `OpenRequest`, `FinishResponse`, `Plan` (= `sim.PartitionPlan`), and `Options` (kind, run-ID prefix, peer prefix, start path). |
| `worker.go` | `ProcessWorker`: one `--partition` subprocess per partition (`netsim.py` or `attacksim.py`), one JSON line request and reply per exchange, honours context cancellation. Message cap 8 MiB, reply cap 64 MiB. |
| `host.go` | `Host`: every node's partition sessions keyed by run id. `Open` acquires an Executor slot (so it can return 503) and starts the worker. `Step` and `Finish` forward to it. `Delete` kills it. A reaper kills sessions idle for 60 s, in case the coordinator vanished. |
| `http.go` | Routes for host and coordinator (4.2) and the `PeerClient` used to call remote hosts. |
| `coordinator.go` | `Manager` and `Run`: the coordination loop and status/report. |

**Coordinator loop (`Manager.execute`)**
1. `Start`: check which peers are healthy, set k (default: all healthy), plan
   with the configured simulator's `--plan`, choose participants (partition 0
   is **always the coordinator itself**, called in-process; the rest are
   healthy peers in peer-list order), then return 202.
2. `openWorkers`: open all partitions in parallel.
3. For each window `w`: `until = min(L·(w+1), duration)`. `stepWorkers` steps
   all partitions in parallel, each with its own `pdes_step_timeout`. Outbound
   records are routed by `plan.assignment[record.to]`; a record addressed to
   its own partition or to an unknown owner is a protocol error. Each inbound
   list is sorted by `(arrive, link, flow, seq)`. Per-partition accounting:
   `compute_s` (reported by the worker), `wait_s` (slowest reply minus this
   partition's reply), and messages and bytes (counted at sender and receiver).
4. `finishWorkers`, then `planner.Merge` (the simulator's `--merge`) produces
   the merged metrics.
5. If baseline is on: plan k=1, then open, step once to the full duration and
   finish it locally. `compareJSON` checks the canonical JSON and gives
   `results_identical` plus `first_difference` (a JSON path).
   `speedup = baseline_wall / partitioned_wall`.

**Failure handling:** any open, step or finish error (or timeout) calls
`fail()`, which sends `DELETE` to every partition that opened, then sets state
and phase to `failed`, with `failed_node` taken from `nodeFailure`. There is
no checkpointing and no automatic restart. The GUI offers "Rerun on surviving
nodes" (same scenario and seed, k = number of survivors).

**Status phases:** `planning → running → (baseline) → complete | failed`.

---

## 6. Gateway — `gateway/` (Go)

Single binary. It serves the embedded GUI (`gateway/webui/embed.go`, built
into `webui/dist/` at Docker build time) and `/api/*` on one port (8080 in the
container, published as `127.0.0.1:8090`).

| Package | Responsibility |
|---|---|
| `config` | Env: `GATEWAY_LISTEN`, `PEERS_CONFIG`, `NODE_CONFIG` (for M/M/1 defaults), `GATEWAY_DB`, `GATEWAY_TOKEN` (optional bearer auth on `/api/*`; the GUI cannot send one yet). |
| `nodeclient` | Typed HTTP client for every node endpoint (`Run`, `NetRun`, `PDESRun`, `PDESPlan`, `Status`, `Report`, `Health`, `Peers`, streams). |
| `aggregate` | Cluster snapshot: probes every node and gathers its view of its peers. |
| `store` | SQLite (pure-Go `modernc.org/sqlite`, no CGO). Table of `Run{run_id, batch_id, coordinator, created_at, params, state, status, report}`. States: `running`, `complete`, `failed`, `coordinator_lost`, `unknown`. |
| `runs` | `Manager.Create`: validates by kind (`resolveNetwork`, `resolvePDES`; PDES scenarios capped at 4 MiB, `parts` 1..2000), submits to the chosen coordinator, stores the run and starts a tracking goroutine. **run_id = base64url(["coordinator","batch_id"])** (`EncodeRunID`). Tracking: poll status every `PollInterval`. A terminal `complete` or `failed` fetches the report (3 tries) and stores it. A 404 from the node, or `LostAfter` consecutive poll failures (about 5 s), marks the run `coordinator_lost`. Tracking of still-running runs resumes after a gateway restart. |
| `server` | Routes (below), static files with SPA fallback, request logging, panic recovery, security headers. |
| `testnode` | Fake node used by the gateway tests. |

**Gateway API**

| Method | Path |
|---|---|
| GET | `/healthz`, `/api/config`, `/api/cluster` |
| POST | `/api/runs` `{kind: mm1|network|pdes|attack, coordinator, …}` |
| GET | `/api/runs`, `/api/runs/{id}`, `/api/runs/{id}/status`, `/api/runs/{id}/report` |
| POST | `/api/pdes/plan`, `/api/attack/plan` (pass through to a healthy node) |
| GET | `/api/stream` (SSE proxy to a node's `/stream`) |
| POST | `/api/netstream` (SSE proxy to `/netstream`) |

Full detail: `docs/gateway-api.md`.

---

## 7. GUI — `web/` (React + TypeScript + Vite)

- **Routing:** hash-based, in `web/src/App.tsx`: `#/cluster`, `#/network`,
  `#/attack`, `#/traffic`, `#/launch` (`?resubmit=<run>`), `#/live/<run_id>`,
  `#/report/<run_id>`.
- **API:** `web/src/api/client.ts` defines the `ApiClient` interface, with a
  real HTTP implementation and `api/mock/MockApiClient.ts` (scripted scenarios
  for development without nodes). The `VITE_USE_MOCK` env var selects one.
  Types are in `api/types.ts`.
- **Pages:**
  - `NetworkPage`: draw a topology (`components/TopologyCanvas.tsx`) or
    generate a grid or torus (`lib/network.ts` `generateGridScenario`). Add
    flows and failure events. Then watch live (`/api/netstream`), run on all
    nodes (`kind:"network"`) or run partitioned (`kind:"pdes"`, with a
    colour-coded partition preview from `/api/pdes/plan`).
  - `AttackPage`: the Threat lab. Four deterministic campaigns (`lib/attack.ts`)
    with an animated map (`components/AttackMap.tsx`), phase timeline, event log
    and charts. Runs in the browser (offline), on one node worker, or as a PDES
    campaign partitioned across healthy nodes via `/api/attack/plan` and
    `kind:"attack"`; remote failures fall back to the local model.
  - `TrafficPage`: live single M/M/1 queue.
  - `LaunchPage`: M/M/1 batch form, coordinator picker, retry on 409.
  - `LivePage`: polls a run. It branches on `params.kind`: M/M/1 progress, the
    network player (`components/NetworkPlayer.tsx`), PDES windows and a
    compute-vs-wait bar (`lib/pdes.ts` `partitionBreakdown`), or the same
    window/timing view for an attack campaign. On `coordinator_lost` or
    `failed` it offers a resubmit (`lib/resubmit.ts`).
  - `ReportPage`: branches on `report.kind`: M/M/1 report, `NetworkReport`,
    `PDESReport` (speedup, identical-results badge, time breakdown, partition
    map), or `AttackReport` (campaign summary, partition placement and a peak
    snapshot on the attack map).
- **Helpers:** `lib/poll.ts`, `lib/stats.ts`, `lib/validation.ts`,
  `lib/chart.ts`, `lib/format.ts`, `lib/traffic.ts`, `lib/attack.ts`.

---

## 8. Deployment

- `docker-compose.yml`: `node-1..3` from `node/Dockerfile` (Go binary on
  `python:3.11-slim` with SimPy). Containers are hardened: read-only root,
  `cap_drop ALL`, `no-new-privileges`, 768 MB memory, 128 process limit.
  `./config` is mounted read-only. Host ports are `127.0.0.1:8081..8083`.
- `docker-compose.web.yml`: the `gateway` service (multi-stage: the npm build
  runs typecheck and tests, the Go build embeds `dist`, the runtime image is
  distroless and non-root). SQLite lives in the `gateway-data` volume. It also
  has an optional `web` service under the `mock` profile.
- `docker-compose.node4.yml` + `config/peers.4.yaml`: a 4th node with no code
  changes. **Every** node and the gateway must use the same peer file
  (`GATEWAY_PEERS=peers.4.yaml`).
- Full stack: `docker compose -f docker-compose.yml -f docker-compose.web.yml up --build`,
  then open http://localhost:8090.

---

## 9. Tests

```bash
cd sim && python -m pytest -q          # 55 tests: models, routing, failures, partition == k=1, planner, protocol
cd node && go test -race ./...         # dispatch/retry/busy, batch, netbatch, pdes coordinator & host (fake workers), api
cd gateway && go test -race ./...      # validation, tracking, coordinator_lost, store, HTTP (testnode fake)
cd web && npm run typecheck && npm test
```
The Go tests need no Docker, network or Python. The repo's `.venv` currently
fails to import pytest; create a fresh venv from `sim/requirements-dev.txt`.
End-to-end and failure scripts: `scripts/demo.sh`, `scripts/kill-node-test.sh`,
`scripts/kill-coordinator-test.sh`, `docs/pdes-testing.md`.

---

## 10. Invariants — do not break these

1. **The Python stdout contract:** only JSON on stdout, one line per message
   or event; everything else goes to stderr; exit codes 0 and 1.
2. **Determinism:** per-entity RNG streams, `seed = base_seed + index` for
   replications, deterministic planner, canonical record order
   `(arrive, link, flow, seq)`, failure events applied before packet events at
   equal times.
3. **PDES lookahead safety:** any cross-partition record must take at least
   `lookahead` simulated time. If you change link timing, update both the
   planner's lookahead and the worker's `arrive` validation.
4. **One code path for k=1 and k>1:** the baseline uses the same worker. A
   change made only on the cross-partition path will show up as
   `results_identical: false`.
5. **503 means busy, not failure:** busy refusals must never charge a retry
   attempt.
6. **The node's peer list includes the node itself,** and all nodes plus the
   gateway share one peer file.
7. **New status/report kinds** must use the "serve my IDs, pass the rest on"
   handler chain, and set a `kind` field the GUI can branch on.

---

## 11. Where to make common changes

| Change | Touch |
|---|---|
| New network model feature | `sim/netsim.py` (`Network`, `validate`, `metrics`, `partition_state`, `merge_partition_states`) + `sim/test_netsim.py` + `web/src/api/types.ts` / `lib/network.ts` |
| Threat campaign feature | `sim/attacksim.py` + `sim/test_attacksim.py`, then mirror the equations in `web/src/lib/attack.ts` and update `web/src/pages/AttackPage.tsx` |
| New node endpoint | `node/internal/api/` or `pdes/http.go`, wired in `node/cmd/node/main.go` |
| New run kind | node manager + handler, `gateway/internal/runs` (resolve and Create), `nodeclient`, `store.Params`, GUI `client.ts`, Live/Report branches |
| Limits | `netsim.py` constants (normal and `partitioned=True`), `web/src/lib/network.ts` `LIMITS`, gateway size caps in `runs.go` |
| Timeouts and retries | `config/node.yaml` (or upper-case env overrides) |

---

## 12. Known issues (found 2026-11-01, not yet fixed)

1. **Hop limit resets at partition boundaries.** `_route_packet` drops a
   packet after 64 hops, but `inject_arrival` restarts the count when a packet
   enters a new partition (`ArrivalRecord` has no hop field). On paths longer
   than 64 hops, partitioned runs differ from k=1. Verified: on an 80-router
   line, k=1 delivered 0 packets and k=3 delivered 85. Fix: carry `hops` in
   `ArrivalRecord` (Python and Go `types.go`) and continue the count.
2. **The GUI generator is capped at 60 nodes** (shared `LIMITS.nodes`), but
   partitioned runs allow 2,000. A PDES-specific limit is needed to generate
   networks large enough to show a speedup.
3. **The status briefly reads `complete` before the baseline starts.**
   `execute` sets `state="complete"` after the merge, then switches back to
   `running` for the baseline. If the gateway polls in that gap, it stores the
   run without `results_identical` or `speedup`. Fix: don't set `complete`
   until after the baseline when `Baseline` is true.
4. **Speedup timing is asymmetric:** the partitioned wall time includes
   starting the workers; the baseline wall time excludes its own start. This
   slightly understates the speedup.
5. The single-queue Live traffic page (`#/traffic`) overlaps with the Network
   lab's live view. It is kept for now; removing it is a product decision.

## 13. Further reading
`docs/superpowers/specs/2026-10-25-pdes-network-design.md` (PDES design),
`docs/2026-10-26-pdes-implementation.md`, `docs/2026-10-26-pdes-test-report.md`,
`docs/gateway-api.md`, `docs/node-api-observed.md`, `docs/assumptions.md`,
`prd.md`.
