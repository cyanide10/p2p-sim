# Project work so far — 2026-10-26

A short summary of everything done on the p2p-sim project, newest last.

## 1. Foundations (first commits)

- Initial repo and a first GUI version (commits `28f2ea6`, `ffb0c9f`, PR #2).
- The web GUI grew a live traffic view and a **Network lab** (build network
  scenarios on a canvas, edit topology, run and watch simulations).
- A **Go gateway** was added and merged from `origin/main` (PR #2 area):
  HTTP API in front of the nodes, run tracking with stale-fallback, cluster
  snapshot with a who-sees-whom matrix, and report pages in the GUI backed by
  the gateway instead of the mock API.

## 2. Documentation phase

- `docs/assumptions.md`, `gui-stage1-2-task-plan.md` — scope and GUI staging.
- `docs/gateway-api.md`, `node-api-observed.md`, `node-api-gaps.md` — API
  contracts, observed node behavior, and gaps to fill.

## 3. PDES feature (the current chapter)

- **Design:** `docs/superpowers/specs/2026-10-25-pdes-network-design.md` —
  split one packet-level simulation into partitions across the 3-node cluster
  with a conservative lock-step window protocol; merged results must be
  byte-for-byte identical to a single-process run of the same seed.
  *(Committed: `8d27a45`.)*
- **Implementation** (uncommitted, ~1,700 lines across 29 files):
  - `sim/netsim.py` — per-entity RNG streams, `partition_plan`,
    `PartitionWorker` JSON-line protocol, `merge_partition_states`,
    `--plan / --partition / --merge` modes, raised limits for partitioned runs.
  - `node/internal/pdes/` — Go coordinator (open → window loop → finish),
    worker subprocess host with slot accounting and 503-when-busy, HTTP
    routes, failure abort naming the failed node.
  - `gateway` — `kind: "pdes"` runs, `POST /api/pdes/plan`, 4 MiB cap,
    report storage.
  - `web/src` — grid generator, partition preview, live compute-vs-wait bars,
    rerun-on-survivors, report speedup/identical badges.
- **Testing** — per `docs/pdes-testing.md`: all suites green (55 Python,
  19 Go packages, 43 web tests, build), Docker cluster rebuilt and exercised
  end to end: **1.84× speedup** at k=3, identical results across k=1/2/3,
  node-kill → clean `failed` → survivor rerun matched.

## 4. Session reports (today)

- `docs/2026-10-26-pdes-test-report.md` — what was tested, measured, and the
  issues found (including the disconnected-hosts scenario trap).
- `docs/2026-10-26-pdes-implementation.md` — how the PDES implementation works,
  component by component.

## 5. Environment notes

- Docker (3 nodes + gateway via Compose) installed and used for E2E runs.
- Go 1.27.3 installed locally (`~/.local/go`) for the Go test suites.
- Python venv at `.venv` for the sim test suite.

## Current state

Working tree has the uncommitted PDES implementation plus the three docs
above; the last commit is `8d27a45` (PDES design). The Docker cluster was
left running for GUI inspection.
