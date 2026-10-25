# PDES test report — 2026-10-26

Verification of the partitioned network simulation (PDES) feature described in
[`superpowers/specs/2026-10-25-pdes-network-design.md`](superpowers/specs/2026-10-25-pdes-network-design.md),
following the procedure in [`pdes-testing.md`](pdes-testing.md). This document
records what was executed, what passed, what was measured, and the issues and
pitfalls found along the way.

**Verdict: the implementation works.** All automated suites pass; an
end-to-end three-node Docker run produced a real **1.84× speedup** over the
one-process baseline with **byte-for-byte identical metrics** to that baseline;
seeds are reproducible across partition counts (k=2 and k=3 merged results are
byte-for-byte equal); partition-node failure aborts cleanly with the failing
node named and the survivor rerun is exact.

---

## 1. Environment setup

| Item | Action taken |
|---|---|
| Python | `python3 -m venv .venv` + `pip install -r sim/requirements-dev.txt` (SimPy 4.1.1 on Python 3.14, verified working) |
| Go | None on the system (CachyOS). Installed **Go 1.27.3** into `~/.local/go`, no sudo. `gateway/go.mod` pins `go 1.27`, so an older toolchain would not build it. |
| Node/npm | Already present (Node 26, npm 12) |
| Docker | Installed the day before (`docker` 29.9.2, `docker-compose` 5.6.1). The agent's shells access the socket via `SHELL=/bin/bash newgrp docker` because the OpenCode process pre-dates the `usermod -aG docker` change. |

> **Prerequisite gap in `pdes-testing.md`:** the prerequisites list
> "Go version required by the modules" without naming it. On this machine `go`
> resolved to nothing and the first `go test` failed outright. Suggest adding:
> "Go **1.27** is required (gateway `go.mod`); install `go1.27.x` or newer."

## 2. Automated test suites

| Suite | Command | Result |
|---|---|---|
| SimPy models (`sim/test_netsim.py`) | `cd sim && ../.venv/bin/python -m pytest -q` | **55 passed** in 8.6 s |
| Go node (incl. new `internal/pdes`) | `go test -race ./...` | all 11 packages **ok** |
| Go gateway | `go test -race ./...` | all 8 packages **ok** |
| Web typecheck | `npm run typecheck` | ok |
| Web tests | `npm test` | **43 passed** (6 files) |
| Web build | `VITE_USE_MOCK=false npx vite build` | ok (~363 kB JS) |

## 3. Cluster rebuild

The containers had been running ~2 h on pre-PDES images, so the stack was
rebuilt with the new code:

```bash
docker compose -f docker-compose.yml -f docker-compose.web.yml up -d --build
```

All four containers (node-1..3, gateway) came back **healthy**; `GET /health`
on 8081–8083 and `/healthz` on 8090 returned `ok`; `GET /api/cluster` showed
three healthy nodes with unanimous peer views.

## 4. Test scenario

Generated with a small script (mirroring the GUI generator's wire format):
5×5 router grid, 1 host per router (25 hosts), 30 constant-rate flows between
random host pairs (fixed generator seed), duration 60 s:

- routers: service_rate 1200 pkt/s, buffer 200
- links: bandwidth 1000 pkt/s, delay 0.02 s, buffer 100
- flows: 300 pkt/s each → **9,000 pkt/s offered, 540,000 offered packets** total
- fits the partitioned limits (≤ 2M offered) but exceeds the 150k
  replication cap, which is correct: the scenario is only meaningful for PDES
- plan: `parts 3`, `lookahead 0.021 s`, **2,858 windows**, 16 cut links,
  load 9/8/8 (balanced within one router, per §1.4)

## 5. End-to-end results

All runs were submitted through the gateway (`POST /api/runs`,
`kind: "pdes"`, coordinator node-1) and completed healthy.

| # | Seed | Parts | Baseline | Node state | `results_identical` | Speedup | PDES wall | Baseline wall |
|---|------|-------|----------|------------|---------------------|---------|-----------|---------------|
| 1 | 888  | 3 | yes | complete | **true** | **1.84×** | 22.71 s | 41.83 s |
| 2 | 888  | 2 | yes | complete | **true** | **1.40×** | 29.61 s | 41.57 s |
| 3 | 888  | 3 | — (metric compare vs run 2) | complete | — | — | — | — |
| 4 | 777  | 3 | no | **failed** (`failed_node: node-2`) | — | — | — | — |
| 5 | 888  | 2 | yes (survivors, node-2 down) | complete | **true** | 1.40× | 29.61 s | 41.56 s |

Key cross-checks:

- **Correctness (§ Goal 1):** run 1's merged metrics equal its own k=1 baseline
  (`results_identical: true`, no first-difference) and the k=2 run 2's merged
  metrics are **byte-for-byte identical to k=3's** for the same seed —
  seed determinism holds across partition counts, not only within one.
- **Speedup (§ Goal 2):** 1.84× at k=3 and 1.40× at k=2 on a hotspot-heavy
  grid, with the compute/wait breakdown fully visible in the report.
- **Failure handling (§ Goal 3):** `docker kill node-2` at window 124/2858
  aborted the batch with a precise error
  (`step at 3.066000: … connect: connection refused`) and `failed_node: node-2`.
  The survivors rerun (`parts: 2`) completed and again matched its baseline.

## 6. Metrics consistency audit

Inspection of the merged report (`metrics` vs `baseline_metrics`):

- `totals.sent` == Σ per-flow `sent` (541,541)
- `totals.delivered` == Σ per-flow `delivered` (219,663)
- `totals.dropped` == Σ per-flow `dropped` (318,654)
- `Σ link drops (7,006) + Σ router drops (311,648) == Σ flow drops (318,654)`
- packets in flight at `t = duration` (sent − delivered − dropped): **3,224**, identical to baseline — no packets invented or lost
- `series.delivered_rate` mean (3,661 pkt/s) matches `totals.throughput`
- `mean_delay` 0.488159 vs the mean of the series values 0.4879 — consistent
- per-partition timing now fully populated: compute 11.3/15.5/17.4 s (k=3),
  messages ≈ 200k–312k, bytes ≈ 28–44 MB per partition (§2.2 counters work)

## 7. Timing analysis / why the speedup looks the way it does

An independent probe driving three real `netsim.py --partition` subprocesses
locally (coordinator-equivalent loop, same seed/scenario) reproduced the same
merged totals and measured:

- one-process baseline (single `step`): **38.6 s** pure compute, 3,025,891 events
- k=3 local: 45.95 s wall, compute 9.97/13.76/15.75 s per partition
- the same run on the Docker cluster: **22.7 s** — the three node containers
  genuinely run in parallel on the multi-core host

Interpretation:

- Partitioning redistributes work but does not eliminate it: Σ compute ≈ 44.2 s
  vs baseline 41.8 s (**+6%** coordination/serialization overhead).
- The wall-clock floor is the busiest partition (17.4 s at k=3), so the
  ceiling is `baseline / busiest ≈ 2.4×`; the additional ~5.3 s is the
  coordinator's per-window routing overhead, exactly as §6 anticipated.
- The grid's loaded center concentrates events in one partition; **speedup
  therefore depends on traffic distribution, not only on `parts`**. The report
  breakdown makes this visible ("a slowdown is visible and explained").
- Wait accounting agrees with the imbalance: node-1 waited 8.35 s for the
  slowest partitions in k=3, node-2 0.02 s in k=2.

## 8. Issues found

### 8.1 Test-scenario generator bug (mine, not the implementation)

The first generated scenario had **no host↔router links** (25 disconnected
hosts). Every packet died with `no_route` at its source, producing
`delivered: 0, dropped == sent` — and because *both* the partitioned run and
its baseline were validated against the same broken scenario,
`results_identical: true` still returned, looking like success.

- Root cause: the generator script never added the host links.
- Why nothing caught it: `--validate` checks structure/rates, not routing
  reachability; a "0 delivered" run is a *statistically legal* result.
- Mitigation during testing: verified connectivity by importing `netsim.py`
  directly and running `network.flow_paths()` (`compute_routes`) before any
  cluster run; also ran a tiny "traffic actually delivers" probe
  (`delivered > 0`) end-to-end.

> **Suggestion:** `netsim.py --validate` could cheaply check that every flow's
> `path_of()` is non-empty (`host is disconnected from its destination`) and
> that **at least one** test scenario per suite asserts `delivered > 0` before
> comparing partitioned vs baseline equality — byte-equality of two
> all-dropped runs is a weak signal. A test like
> `assert m["totals"]["delivered"] > 10` ahead of the equality check in
> `test_partitioned_metrics_match_single_process_with_failures` would have
> surfaced it while iterating on test scenarios. (Not required — the
> shipped `DIAMOND` test scenario does deliver — but worth a note in
> `pdes-testing.md` for anyone driving custom scenarios through the API.)

### 8.2 Observations worth revisiting (non-blocking)

- **`flow.drops` reasons not in the report.** Rows in `metrics.flows` lack the
  `drops` breakdown (`router_buffer` etc.) even though per-link and per-router
  drop counts are present. Not a blocker — the plan view and totals carry the
  aggregate — but if the Report page is later asked "why did packets drop?",
  either re-add per-flow drop reasons or intentionally drop the field.
- **Prerequisite version gap** in `pdes-testing.md` (Go 1.27) — see §1.
- **Agent-side Docker group membership:** a process started before
  `usermod -aG docker` cannot touch the socket without `newgrp docker`; worth
  remembering when running the doc's Docker steps from an agent session.

## 9. Artifacts

All exploration artifacts are in `/tmp/opencode/` (ephemeral):

| File | Purpose |
|---|---|
| `make_network.py`, `make_network_small.py` | scenario generators (full-rate 540k for PDES, rate-60 for replication-cap validation) |
| `network.json` | the 540k offered-packet test scenario used by every cluster run |
| `pdes_full_test.sh` | k=3 and k=2 runs + byte-for-byte metric comparison |
| `failtest.sh` | mid-run `docker kill node-2` + `failed_node` verification |
| `survivors.sh` | survivor rerun (`parts=2`) + cross-k metric compare |
| `mini_probe.py`, `probe.py`, `deliv.py`, `trace1.py` | connectivity/routing diagnostics that isolated §8.1 |
| `perf_probe.py`, `pdes_timing_probe.py` | local wall/compute probes (§7) |
| `report*.json`, `metrics_k*.json`, `plan.json`, `run*.json` | stored gateway reports and API payloads |

Gateway batch IDs observed (all `complete` unless noted):

- `pdes-node-1-20261025T170151.054654010` (k=3, seed 888, baseline, ✅)
- `pdes-node-1-20261025T170256.279482077` (k=2, seed 888, baseline, ✅)
- `pdes-node-1-20261025T165232.350901194` (k=3, seed 777, **failed** with
  `failed_node: node-2`)
- `pdes-node-1-20261025T164733.867646280` (k=3, seed 12345, earlier
  disconnected-host iteration, ✅ but 0 delivered — see §8.1)
- `pdes-node-1-20261025T164821.693278680` / `...164904.375218687` /
  `...232.350901194` iterations noted in the report and §8

The cluster was left **running** after the tests (doc §7 says to stop it only
when the operator chooses), so the above can be inspected live at
<http://localhost:8090> until the next `docker compose ... down`.
