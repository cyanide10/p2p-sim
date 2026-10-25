# Partitioned network simulation (PDES) — design

Date: 2026-10-25. Status: approved in conversation; awaiting review of this document.

## Goal

Run **one** packet-network simulation split across the node pool, instead of
independent copies, and show two things in the GUI:

1. **Correctness:** the partitioned run produces metrics byte-for-byte identical
   to a one-process run with the same seed.
2. **Speedup:** wall-clock time of the partitioned run against the one-process
   baseline, with a breakdown of where the time went (compute, waiting at
   window barriers, messaging), measured on one multi-core Docker host.

Existing modes (M/M/1 batches, network replication batches, live streams) stay.

### Decisions already taken

| Topic | Decision |
|---|---|
| Model | The existing Network lab model, `sim/netsim.py` |
| Synchronization | Conservative, lock-step windows driven by the coordinating node |
| Scenarios | Any drawn network can run partitioned, plus a generator for large networks |
| Partitioning | Automatic and deterministic; the GUI previews it |
| Node failure | Abort with a clear error; offer a one-click rerun on surviving nodes |
| Measurement | k partitions (default: all healthy nodes, user may pick fewer), optional one-process baseline; report speedup, identical-results check and time breakdown |

### Non-goals

Optimistic synchronization (Time Warp), checkpoints, automatic restart,
direct node-to-node packet exchange, manual partition editing, a scaling sweep.

## 1. Simulation layer (`sim/netsim.py`)

### 1.1 Deterministic random streams

Today one `random.Random(seed)` feeds every router's service times and seeds
each flow source, so results depend on global event order. Replace it with one
stream per entity and purpose:

```
stream(seed, kind, id) = random.Random(int.from_bytes(sha256(f"{seed}:{kind}:{id}").digest()[:8], "big"))
```

* `("router", rid)` — that router's service times.
* `("flow", fid)` — that flow's inter-arrival times, on/off periods and thinning.

All modes (replication, live stream, partitioned) use the new streams, so the
numbers a given seed produces in the existing network modes change once.

Packet identity in the partition protocol is `(flow id, per-flow sequence
number)`. Live-stream events keep their numeric `pkt` (a per-process counter
used only for display), so the GUI's animation code is unchanged.

### 1.2 One code path for link traversal

When a packet **starts transmission** on link direction `a→b` at time `s`, it
becomes an *arrival record*:

```
{flow, seq, born, link, from, to, start: s, arrive: s + 1/bandwidth + delay}
```

The arrival is handled by `to`'s owner. If `to` is in the same partition the
record is scheduled directly; otherwise it is placed in the outbound list. The
same function handles both, so a one-partition run exercises the same logic.

On arrival the receiver drops the packet as `link_down` if the failure
schedule has a `down` event for `link` in `(start, arrive]`, or the link is
down at `arrive`. This reproduces today's checks (an epoch change during
transmission or propagation, or the link being down after propagation)
without messages. The check before transmission (link failed while the packet
was queued) stays on the sending side.

Failure events are known in advance. Every partition holds the full scenario,
applies the same events at the same times and recomputes routes with
`compute_routes`, so routing tables agree everywhere without communication.

Tie rule: at equal timestamps, failure events are applied before packet
events, and injected arrivals are ordered by `(arrive, link, flow, seq)`.
Packet timestamps are continuous random values, so ties between packets are
measure-zero; the rule exists so behaviour is defined, not because it is
expected to matter.

### 1.3 Ownership and exact merging

* A router, and both its queue and service, belong to its partition.
* A link direction `a→b` (its transmit queue) belongs to `a`'s partition.
* A host belongs to the partition of the router it is attached to; flows are
  generated at the source host's partition and delays are recorded at the
  destination host's partition.

Every metric is then either owned by exactly one partition (per-link,
per-router and per-flow figures, including per-flow p95 delay) or a sum of
per-partition parts (totals, time-series bins). Merging is exact; the merged
JSON is serialized with sorted keys and the same rounding as `metrics()` so it
can be compared byte for byte with the baseline.

### 1.4 Partitioner — `netsim.py --plan --parts k`

Input: scenario on stdin. Output: one JSON line

```
{"ok": true, "parts": k, "assignment": {node_id: part}, "cut_links": [...],
 "lookahead": L, "windows": ceil(duration / L), "load": [routers_per_part]}
```

Algorithm (deterministic, no randomness):

1. Collapse each host into its attached router (a host with several links goes
   with its lowest-latency neighbour).
2. Grow k regions breadth-first from k seed routers chosen as far apart as
   possible (repeated farthest-point by hop count, ties by id). Expand the
   smallest region next; among frontier candidates take the one reached over
   the lowest-latency link, so high-latency links tend to be cut.
3. `lookahead L = min over cut links of (1/bandwidth + delay)`.

Rejections (exit 1, message on stderr, same contract as `--validate`):
`k` exceeds the router count; `windows > 200 000` ("increase link delays on
links between regions or shorten the run").

### 1.5 Partition worker — `netsim.py --partition`

A long-lived process speaking JSON lines on stdin/stdout:

| Request | Response |
|---|---|
| `{"op":"open","scenario":…,"plan":…,"part":p,"seed":s}` | `{"ok":true}` |
| `{"op":"step","until":T,"inbound":[records]}` | `{"outbound":[records],"compute_s":x,"events":n}` |
| `{"op":"finish"}` | `{"metrics":{…partition part…}}` and exit 0 |

`step` injects inbound records, then runs the SimPy environment to `T`.
A record produced during window `[T0, T0 + L)` has `arrive >= T0 + L`, which is
the start of the next window, so inbound records are never in the receiver's
past. A record that is (a protocol violation) is an error, not a silent fix.

The one-process baseline is the same worker with `k = 1` and a single `step`
to `duration`.

### 1.6 Limits for partitioned runs

Separate from the replication limits (which bound one task's time budget):
up to 2 000 nodes, 6 000 links, 400 flows, 200 failure events, and about
2 000 000 offered packets per run. The packet limit is checked against the
768 MB container memory limit during implementation and lowered if needed.

## 2. Node layer (`node/internal/pdes`)

### 2.1 Partition host (every node)

Node-to-node routes, behind the same 503-when-busy rule as `/task`:

* `POST /pdes/{run}/open` — start a worker process and send `open`. Holds one
  simulation slot until finish or abort.
* `POST /pdes/{run}/step` — forward `step`, return its reply.
* `POST /pdes/{run}/finish` — forward `finish`, return partition metrics,
  release the slot.
* `DELETE /pdes/{run}` — kill the worker, release the slot.

An idle worker with no request for 60 s is killed (the coordinator vanished).
Bodies on these routes are capped at 8 MiB.

### 2.2 Coordinator (the node receiving the run)

* `POST /pdes/plan {scenario, parts}` — runs `--plan`, returns the plan (GUI
  preview).
* `POST /pdesrun {scenario, parts?, base_seed?, baseline?}` — 202 with a
  `batch_id`, or 400 (invalid scenario or plan) or 409 (already coordinating).
  `parts` defaults to the number of healthy peers.

Run loop:

1. Plan; assign partition `i` to the i-th healthy peer in peer-list order,
   with partition 0 on the coordinator itself (called in-process).
2. `open` on all partitions in parallel.
3. For each window `[T, T+L)`: `step` all partitions in parallel with their
   inbound records; collect outbound; sort by `(arrive, link, flow, seq)` and
   route to the owner of `to`. Record per partition: compute seconds, wait
   (time between its reply and the slowest reply), message counts, bytes.
4. `finish` all; merge metrics.
5. If `baseline`: run `k = 1` locally, merge, compare canonical JSON →
   `results_identical`. Speedup = baseline wall clock / partitioned wall clock.

Failure: a failed, timed-out (per-step timeout from `config/node.yaml`,
default 30 s) or protocol-violating step aborts the run, sends `DELETE` to the
other partitions and marks the batch `failed` with `failed_node` and the
error.

`GET /status?batch_id=` and `GET /report?batch_id=` serve partitioned batches
the same way `netbatch` does today (a handler in front of the M/M/1 routes).
Status carries `phase` (`planning`, `running`, `baseline`, `complete`,
`failed`), simulated time, windows done/total and per-partition timing. The
report carries the merged metrics, the plan, the time breakdown, speedup,
`results_identical` and, when they differ, the first differing JSON path.

## 3. Gateway

* Run kind `"pdes"` next to `"network"`: `POST /api/runs {kind:"pdes",
  coordinator, scenario, parts?, base_seed?, baseline?}`; stored in the same
  SQLite table; tracked by the existing loop, so a dead coordinator still
  becomes `coordinator_lost`. A node-reported `failed` state is stored as the
  run's final state.
* `POST /api/pdes/plan` passes through to a healthy node.
* Scenario size cap for `pdes` runs: 4 MiB.

## 4. GUI (`web/`)

* **Network lab → Generate:** grid or torus of R×C routers, hosts per router,
  number of flows (random host pairs, fixed by a generator seed), flow rate,
  link bandwidth and delay, router service rate and buffer. Produces normal
  scenario JSON with grid coordinates so the canvas lays it out without manual
  placement. Defaults are chosen so windows hold enough work to show speedup.
* **Network lab → Run partitioned:** third run action. Partition count (1..N
  healthy nodes, default N), baseline toggle (default on). A preview colours
  each node by partition and shows lookahead, window count and cut links.
* **Live page (pdes):** simulated time progress, windows done/total, a
  per-partition compute-vs-wait bar. On `failed`: the failing node and error,
  and "Rerun on surviving nodes" (same scenario and seed, parts = healthy
  count).
* **Report (pdes):** the existing network report views for the merged
  metrics, plus speedup, identical-results badge (a mismatch is a loud error
  showing the first differing path), time breakdown and the partition map.

## 5. Testing

* **Python:** for small scenarios covering every traffic pattern and link and
  router failures, partitioned runs with k = 2, 3, 4 equal the k = 1 run
  exactly; the partitioner is deterministic, balanced within one router of
  even for grids, and its lookahead equals the minimum cut latency; the
  protocol rejects past arrivals; `--seed` and `--stream` modes still work.
* **Go node:** the coordinator loop against a fake worker (routing of records,
  sort order, timing accounting, abort on failure/timeout, 503 when busy, idle
  kill); status/report routing.
* **Gateway:** `pdes` kind validation, pass-through, size cap, failed state.
* **Web:** generator output (valid, deterministic, laid out), plan preview
  colouring, pure helpers for the time breakdown.
* **End to end:** three Docker nodes, a generated network, partitioned run
  with baseline → `results_identical: true` and a reported speedup; stopping a
  partition node mid-run → `failed` naming it; rerun on survivors → identical
  metrics.

## 6. Expectation

Speedup is not guaranteed. Each window costs roughly 1–2 ms of HTTP and JSON
round trip through the coordinator; it pays off only when each partition has
hundreds or more events per window. The generator defaults target that, and
the report always shows the breakdown, so a slowdown is visible and explained.
