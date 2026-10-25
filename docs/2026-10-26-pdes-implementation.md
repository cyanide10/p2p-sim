# PDES implementation guide — 2026-10-26

How the partitioned (PDES) network simulation is implemented, as shipped.
Companion documents: the approved design
([`superpowers/specs/2026-10-25-pdes-network-design.md`](superpowers/specs/2026-10-25-pdes-network-design.md))
and the verification record
([`2026-10-26-pdes-test-report.md`](2026-10-26-pdes-test-report.md)).

The one-sentence version: **one** packet-level simulation is split into
deterministic partitions, each driven by its own SimPy worker subprocess on a
pool node; a conservative lock-step window protocol on the coordinating node
exchanges only *cross-partition arrival records* so no partition ever looks
into another one's past; and the merged results are provably (tested)
byte-for-byte identical to a single-process run of the same seed.

---

## 1. What runs where

```
                GUI (web/, React)                        gateway (Go)
   POST /api/pdes/plan ───────────────────────▶ passes through to a
   POST /api/runs {kind:"pdes"}               healthy node, stores the run
   ──────────────────────────────────────────┐ in SQLite, tracks batch state
                                             ▼
                              coordinator node (e.g. node-1)
                              node/internal/pdes (Go):
                                plan → open → step loop → finish → merge
                                (its own partition runs in-process)
                                   │          │            │
                        HTTP step  │ HTTP step│ HTTP step  │ per window
                                   ▼          ▼            ▼
                            partition workers (python3 sim/netsim.py --partition)
                            one subprocess per partition, one per node
```

* Every node runs the same binary and can coordinate any PDES batch;
  partition 0 always lands on the coordinator itself (in-process, no HTTP for
  its own steps).
* Each worker is a long-lived Python subprocess fed JSON lines on stdin
  (`open` / `step` / `finish`) and answering one JSON line per request.
* The coordinator, not the workers, advances time: each window waits for all
  partitions (conservative, no optimism, no node-to-node packet traffic).

## 2. Determinism — why identical results are possible

Two properties make byte-for-byte equality attainable:

1. **Stream-per-entity RNG** (`sim/netsim.py::_entity_rng`):
   `("router", rid)` seeds that router's service times, `("flow", fid)` seeds
   that flow's arrivals/on-off/thinning. A stream's future depends only on
   `(seed, kind, id)` — never on global event order — so splitting entities
   across partitions cannot change the drawn numbers, only the synchronization
   of *when* they are consumed, which the window protocol pins down by
   construction (no partition processes an arrival from its past).
2. **Total ordering of cross-partition arrivals:** inbound records are sorted
   by `(arrive, link, flow, seq)` both by their producer (sorted `outbound`)
   and by the worker on injection, so ties (measure-zero for packet times,
   defined anyway) resolve identically everywhere. Failure events applied at
   equal timestamps precede packet events.

Plugin facts relied upon: all windows advance partitions to the same `until`;
a record produced in `[T0, T0+L)` has `arrive ≥ T0+L` (link traversal takes
`1/bandwidth + delay`, and the **lookahead is exactly the minimum over cut
links of that value** — §1.4 of the design), so in-flight arrivals are never
in the receiver's past. A past arrival is a protocol error, never a silently
rescheduled event.

**Ownership** (§1.3) makes merging exact rather than approximate: a router,
its queue and its service belong to its partition; a link direction
`a→b`'s transmit queue belongs to `a`'s partition; a host belongs to its
router's partition. Each metric is therefore either owned by exactly one
partition or a per-partition sum, and `merge_partition_states` only adds raw
counters before the single `metrics()` rounding pass. The Go coordinator
compares the merged JSON canonically (`results_identical`) against the
one-process baseline computed on node-1 (the same worker, `plan parts=1`).
`encoding/json` sorts map keys on marshal, so the comparison is
serialization-stable; a mismatch reports the first differing JSON path.

## 3. Simulation layer — `sim/netsim.py`

| Piece | Role |
|---|---|
| `ArrivalRecord` | the *only* thing that crosses a partition boundary: `{flow, seq, born, link, from, to, start, arrive}` with `order_key() == (arrive, link, flow, seq)` |
| `_entity_rng(seed, kind, id)` | per-entity SHA-256 streams; replaces the single shared `random.Random` (a deliberate behavioral change of pre-PDES modes, occurring once, per §1.1) |
| `partition_plan(sc, parts)` | deterministic partitioner: hosts collapse into routers, k regions grow breadth-first from farthest-point seeds, expanding smallest-region-first over lowest-latency links (cuts delay-heavy links); `lookahead = min(1/bw + delay)` over cut links; rejects `parts > #routers` and `windows > 200,000` |
| `PartitionWorker` | one open stateful partition; `step(until, inbound)` validates every inbound record (fields, topology, `arrive ≥ start + tx + delay − 1e-12`, addressed to *this* partition, never in the past), injects, runs the SimPy env to `until`, replies with sorted `outbound` + own `compute_s` + event count; `finish()` returns `metrics` + raw `partition_state` and refuses to finish before duration |
| `merge_partition_states(sc, states)` | adds raw counters (flow, bins, link/router station busy-area, delay lists per bin re-sorted canonically) then applies the ordinary `metrics()` rounding — the merged object is exactly what `run_replication` would produce |
| limits (partitioned) | 2,000 nodes, 6,000 links, 400 flows, 200 events, 2,000,000 offered packets (`validate(..., partitioned=True)`; the replication path keeps its stricter 150k cap) |
| `--merge` CLI | the Go side pipes `{"scenario", "states"}` into a dedicated merge run |

Unchanged-but-shared code paths: the ordinary `--seed` replication and
`--stream` live modes use the same `_entity_rng` streams; `inject_arrival`
(§ record handling, `_link_failed_during` reproducing "failed while
transmitting/propagating") is the same traversal logic a one-partition run
exercises.

## 4. Node layer — `node/internal/pdes`

Wired in `cmd/node/main.go` in front of the existing mux
(`routes.Handle("/", pdes.NewHandler(...))`), sharing the *netrun's*
Python interpreter and `netsim.py`.

### 4.1 Host (role: any worker node)

`Host` owns one subprocess per open run and enforces the pool's
`max_concurrent_tasks` rule by taking the **same simulation slot** the M/M/1
and netrun paths use (`slots.Acquire()`); a busy node answers **503** on
`open` (`ErrBusy`), and the coordinator treats 503-with-slot-exhaustion like a
normal failure. Idle workers (no request for **60 s**, i.e. a vanished
coordinator) are reaped by a background goroutine.

| Route | Behavior |
|---|---|
| `POST /pdes/{run}/open` | starts the worker, sends `open`; 400 on double-open / bad plan, **503** when the node's slots are exhausted; holds the slot until finish/abort |
| `POST /pdes/{run}/step` | forwards `step` (≤ 8 MiB body, replies capped at 64 MiB), returns `outbound/compute_s/events`; on error the worker is stopped (the coordinator will `DELETE`) |
| `POST /pdes/{run}/finish` | forwards `finish`, returns the partition's `metrics` + `state`, releases the slot |
| `DELETE /pdes/{run}` | kills the worker, releases the slot, 404 if unknown |

### 4.2 Coordinator (role: the node that accepted the batch)

`Manager` (in `coordinator.go`) drives the phase machine with a per-run
`Run` holding state, phase, simulated time, windows, and per-partition
timings copied under a mutex by `Status()`/`Report()` snapshots.

```
planning ── open (parallel) ──▶ running (window loop) ──▶ complete
   │            │                      │                     └─▶ baseline (optional k=1)
   └────────────┴────────── any open/step/finish/merge failure ─▶ failed
```

* **Plan:** `POST /pdes/plan` is also used standalone by the GUI for its
  preview (§4.3).
* **Participants:** partition `i` → the *i-th healthy peer in peer-list
  order*; partition 0 forced onto the coordinator. `parts` defaults to the
  count of healthy peers and must not exceed it (`POST /pdesrun` → `202` or
  `400`/`409 ErrCoordinatorBusy`).
* **Window loop:** for each window, `step` all partitions in parallel with
  their inbound records; collect `outbound`; bucket them by
  `plan.assignment[record.to]`; sort by `(arrive, link, flow, seq)`; repeat.
  Records accounting is kept per partition: `compute_s` (from the worker),
  barrier **wait** (`slowest_step_elapsed − mine`), `messages`, `bytes`.
* **Abort:** any failed/timed-out step (per-step timeout
  `pdes_step_timeout`, default 30 s; phase timeout `phase_timeout`) or
  protocol violation wipes *all* opened partitions (`DELETE`) and lands the
  batch in `failed` with `failed_node` + error text. The failure test in the
  companion report shows exactly this in production (`docker kill node-2`
  mid-run → `failed_node: "node-2"`).
* **Baseline:** after `complete`, `runBaseline` executes the same worker with
  `plan parts=1` in-process and fills `baseline_metrics`,
  `baseline_wall_seconds`, `results_identical`, `first_difference`,
  `speedup = baseline_wall / partitioned_wall`.

### 4.3 Node HTTP surface seen by the gateway

In addition to the four `pdes/{run}` routes above (all nodes), the
coordinator-only ones behind the same handler:

| Route | Purpose |
|---|---|
| `POST /pdes/plan` | runs `--plan`, returns `{ok, parts, assignment, cut_links, lookahead, windows, load}` or 400 |
| `POST /pdesrun` | starts a batch asynchronously (`202`, `batch_id`), `409` when this node is already coordinating a PDES batch, `400` on scenario/plan validation |
| `GET /pdes/status`, `GET /pdes/report` | same payloads as `/status` and `/report`, distinguishable by `kind: "pdes"` |
| `GET /status`, `GET /report` | pdes handler answers first for its own batch IDs; anything else falls through to the M/M/1/netrun handler |

## 5. Gateway — `gateway`

* `POST /api/runs {kind: "pdes", coordinator, scenario, parts?, base_seed?,
  baseline?}` passes through to the chosen coordinator's `pdesrun`, stores the
  run in the ordinary SQLite table with `Kind: "pdes"`, and is thereafter
  tracked by the *existing* polling loop — a dead coordinator still degrades
  to `coordinator_lost` after the usual 5 consecutive poll failures, and a
  node-reported `failed` becomes the run's final state.
* `BaseSeed` is echoed back from the node's `202` (generated on the node if
  omitted, so the GUI shows the actual seed), no `replications` resolution —
  `parts` plays that role in `params`.
* Scenario cap for `kind: "pdes"` and for `POST /api/pdes/plan`: **4 MiB**;
  `parts` must be 1..2000.
* `POST /api/pdes/plan` is a straight pass-through to a healthy node; the GUI
  uses it to paint the partition preview before anyone submits anything.
* Registry of (`PDESRunRequest`) client call lives in
  `nodeclient.go`, with the node's contract mirrored in
  `testnode.go` for the server-side tests.

## 6. Web GUI — `web/src`

* **Network lab → "Generate a grid and run PDES"** panel
  (`pages/NetworkPage.tsx`): grid or torus of R×C routers, hosts per router,
  N flows (generator-seeded host pairs; same seed reproduces the traffic
  matrix), flow rate, link bandwidth/delay, router service rate/buffer,
  duration. The generator (`lib/network.ts::generateGridScenario`) emits an
  ordinary scenario with grid coordinates so the canvas needs no layout.
  Validation mirrors `netsim.py`'s limits with human-readable RangeErrors.
* **Preview plan:** renders the returned plan — node colors by partition on
  the topology canvas, cut-link markers, lookahead, window count and
  per-partition load — *before* any run is submitted.
* **Run partitioned:** parts = 1..healthy count (default: all), baseline
  toggle (default on). Live page (`pages/LivePage.tsx`) shows simulated-time
  progress, windows done/total and a **compute-vs-wait bar per partition**
  (`lib/pdes::partitionBreakdown`); on `failed` it names the failing node and
  offers "Rerun on surviving nodes" (parts = healthy count, same scenario and
  seed), and warns when it can only show the last stored snapshot
  (coordinator gone).
* **Report (pdes):** the regular network report views (per-flow, per-link,
  per-router, series) plus a partition map, the speedup,
  the identical-results badge (a mismatch is a loud error showing the first
  differing path), the compute/wait breakdown and the wall-clock terms.

## 7. Configuration knobs

| Setting | Default | Meaning |
|---|---|---|
| `config/node.yaml::pdes_step_timeout` | 30 s | per-window per-partition request budget (the coordinator must not outlive the workers); node and gateway write-timeouts grow accordingly |
| `pdes_step_timeout` env override | — | per-node override, same `.yaml`-upper-case convention as the other node settings |
| scenario caps (partitioned path) | 2000 nodes / 6000 links / 400 flows / 200 events / 2M offered packets | enforced inside `netsim.py` (`validate(..., partitioned=True)`) |
| window cap | `windows ≤ 200,000` | rejection with the "increase link delays or shorten the run" message from the planner |
| `mode: baseline` (GUI toggle) | on | also runs the k=1 reference; without it `speedup`/`results_identical` stay absent from the report |
| coordinator selection | any node | the node that receives `POST /api/runs`' `coordinator` field |

## 8. Observed production behavior (from the test report)

On the 12-core host with the standard 3-node Compose stack, the reference
540k-packet congested grid (5×5 routers, 30 flows at 300 pkt/s, 60 s,
2,858 windows, lookahead 0.021 s):

* k=3: **1.84× speedup**, 22.71 s vs baseline 41.83 s, merged metrics
  byte-for-byte equal to the baseline, k=2 vs k=3 byte-for-byte equal for the
  same seed.
* Per-partition booking is populated and imbalanced in the expected direction
  (the event-dense grid center dominates one partition; the report's
  compute-vs-wait bars expose it).
* Overhead of the partitioning itself is ≈ +6 % total CPU (Σ compute 44.2 s vs
  baseline 41.8 s), so the practical ceiling is
  `baseline / busiest_partition ≈ 2.4×` — realized speedup depends on **how
  evenly the traffic spreads across partitions**, not merely on `parts`.
* Failure semantics verified in production: killing node-2 mid-run yields
  `phase: failed, failed_node: node-2` within one window, other partitions are
  deleted, and the survivor rerun (k=2) again matches the baseline.

## 9. Where the pieces live

```
sim/netsim.py                 streams, partition_plan, PartitionWorker,
                              merge_partition_states, --plan/--partition/--merge CLI
sim/test_netsim.py            protocol, equality k=2..4 vs 1, plan properties, worker reject
node/internal/pdes/types.go   ArrivalRecord/Step/Open/Finish DTOs (Plan = sim.PartitionPlan)
node/internal/pdes/worker.go  subprocess transport (JSON lines, 8 MiB / 64 MiB caps, 60 s idle kill)
node/internal/pdes/host.go    per-run worker registry, slot accounting, 503 when busy, reaper
node/internal/pdes/coordinator.go  Manager/Run phase machine, window loop,
                              baseline & canonical compare, first-difference path
node/internal/pdes/http.go    /pdes/{run}/{open,step,finish}, DELETE /pdes/{run},
                              coordinator endpoints, /status //report fall-through
node/internal/pdes/*_test.go  coordinator against fake workers, host 503/idle, status routing
gateway/…/nodeclient.go       PDESRunRequest / plan pass-through client calls
gateway/…/runs.go             kind "pdes" resolution, 4 MiB cap, Create dispatch
gateway/…/server.go           POST /api/pdes/plan, maxPDESBody
gateway/…/store.go            Params.Parts persisted in the runs table
web/src/lib/network.ts        generateGridScenario (grid/torus), checkScenario, toWire
web/src/lib/pdes.ts           partitionBreakdown (compute vs wait formatting)
web/src/pages/NetworkPage.tsx generator + Preview plan + Run partitioned UI
web/src/pages/LivePage.tsx    pdes progress + per-partition bars + rerun-on-survivors
web/src/pages/ReportPage.tsx  speedup / identical badge / partition map rendering
```

## 10. Non-goals consciously out of scope

Optimistic synchronization (Time Warp), checkpoints, automatic restart
(only the manual "Rerun on surviving nodes"), direct node-to-node packet
exchange, manual partition editing, and scaling sweeps — as recorded in the
design's decision table. Additions beyond those were deliberately avoided;
the PDES tracker rides the existing netrun status/report plumbing rather than
inventing its own run-tracking state.
