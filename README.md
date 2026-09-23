# p2p-sim: distributed queueing simulation on a peer-to-peer node pool

This project runs statistically valid M/M/1 queueing simulations faster. It
spreads **independent, individually seeded replications** across a pool of
identical nodes, then checks the combined result against closed-form queueing
theory.

**All nodes are equal. There is no permanent coordinator.** Every node runs the
same binary and does two jobs:

- **Worker:** runs simulation tasks that other nodes send it (`POST /task`).
- **Coordinator:** whichever node receives `POST /run` coordinates that batch.
  It hands tasks to every node in the static peer list, including itself
  (in-process, without HTTP), then aggregates the results.

Each task runs a **SimPy** simulation (`sim/simulate.py`) as a subprocess. The
Go and Python sides share only a one-line JSON contract.

```
             client ── POST /run (to ANY node) ──┐
                                                 ▼
   ┌──────────────┐  POST /task   ┌──────────────────────┐  POST /task   ┌──────────────┐
   │ node-1       │◀──────────────│ node-2               │──────────────▶│ node-3       │
   │ worker       │───result─────▶│ coordinates batch    │◀───result─────│ worker       │
   │ simulate.py  │               │ + runs its own share │               │ simulate.py  │
   └──────────────┘               └──────────────────────┘               └──────────────┘
      (any of these nodes could have been the coordinator)
```

> **Membership is static.** Every node reads the same `config/peers.yaml`, and
> there is no discovery or gossip. "Peer-to-peer" here means symmetric roles
> with no single permanent coordinator.

## Quick start (Docker)

```bash
docker compose up --build            # node-1..3 on localhost:8081..8083

# Start a batch on any node; that node coordinates it.
curl -X POST http://localhost:8082/run \
  -H "Content-Type: application/json" \
  -d '{"replications": 100, "lambda": 0.8, "mu": 1.0, "sim_time": 10000, "warmup_time": 1000}'
curl http://localhost:8082/status
curl http://localhost:8082/report
curl http://localhost:8082/peers     # health of every node, as seen from node-2
```

- **Demo script:** `scripts/demo.sh` starts a batch, polls it and prints the
  report. `NODE=http://localhost:8083 scripts/demo.sh` makes node-3 coordinate.
- **Docker without `sudo`:** `sudo usermod -aG docker $USER`, then log in again.

### Failure tests

```bash
scripts/kill-node-test.sh node-2 100        # a worker dies mid-batch → its task is reassigned
scripts/kill-coordinator-test.sh 100        # the coordinator dies → resubmit the same base_seed elsewhere
```

If the **coordinating** node dies, its batch is lost, because batch state lives
only there. Seeds fully determine results, so resubmitting the same `base_seed`
to any surviving node reproduces the batch bit-for-bit.

### Scaling test: add a 4th node (no code changes)

```bash
docker compose -f docker-compose.yml -f docker-compose.node4.yml up --build
```

This adds `node-4` and gives **every** node `config/peers.4.yaml`. Membership is
symmetric, so all nodes must share the same list.

## Running without Docker

```bash
python3 -m venv .venv && .venv/bin/pip install -r sim/requirements-dev.txt
(cd node && go build -o ../bin/node ./cmd/node)

# One process per node, all sharing one peer list that includes themselves:
NODE_ID=node-1 LISTEN_ADDR=:8001 PEERS_CONFIG=my-peers.yaml NODE_CONFIG=config/node.yaml \
  PYTHON_BIN=.venv/bin/python SIM_SCRIPT=sim/simulate.py bin/node &
```

On real machines, give every machine the same `peers.yaml` with LAN addresses,
and a unique `NODE_ID` that matches its entry.

## Tests

```bash
cd sim && ../.venv/bin/python -m pytest -q     # SimPy model vs M/M/1 and M/D/1 theory, CLI contract
cd node && go test -race ./...                 # stats, config, dispatch/retry/busy, routing, worker, API
```

None of the Go tests need Docker, a network, or Python.

## API (every node, port 8000)

| Method | Path      | Description |
|--------|-----------|-------------|
| POST   | `/run`    | Start a batch coordinated by this node. Body fields (all optional; defaults from `config/node.yaml`): `replications`, `lambda`, `mu`, `sim_time`, `warmup_time`, `tolerance_pct`, `base_seed`, `serial_baseline`. Returns `202 {"batch_id","status":"started","coordinator","replications","base_seed","peers"}`. Returns `400` for invalid input and `409` if this node is already coordinating a batch. |
| GET    | `/status` | Task counts for a batch this node coordinates (`?batch_id=`, default latest). |
| GET    | `/report` | Mean, stddev and 95% CI per metric vs M/M/1 theory; verdict; tasks per node; distributed vs serial wall clock and speedup. |
| GET    | `/peers`  | Health of every node in the peer list (`self` marks this node). |
| GET    | `/health` | `{"status":"ok","node_id","peers"}` |
| POST   | `/task`   | Node-to-node: run one replication. Returns `200` Result, `400 {"task_id","error"}` if the simulation failed, or `503` if the node is at `max_concurrent_tasks`. |

**Simulation CLI contract:**

```bash
python3 sim/simulate.py --seed 42007 --lam 0.8 --mu 1.0 --sim-time 10000 --warmup-time 1000
```

- **Output:** exactly one JSON line on stdout; diagnostics go to stderr.
- **Exit codes:** 0 on success, 1 on failure.
- **What the metrics mean:** `mean_wait_time` is time in system (compared
  against W = 1/(μ−λ)). `mean_queue_length` is the time-averaged number in
  system (compared against L = ρ/(1−ρ)).

## Design notes

### Why Go for the services and Python/SimPy for the simulation

- **Go** runs the orchestration layer: HTTP, timeouts, retries, and fan-out with
  goroutines. It compiles to a small static binary.
- **SimPy** is a mature discrete-event simulation engine with exactly the
  primitives a queueing model needs.
- **The bridge:** a subprocess plus a JSON contract. Each side can be tested
  without the other.

### Why independent replications, not PDES

- **Why it works:** replications are embarrassingly parallel, so nodes never need
  causality-preserving synchronization or rollback.
- **What a failure costs:** a dead node costs one reassigned task.
- **Why duplicates are safe:** a seed fully determines its result, so running a
  task twice is harmless. That is why no leader election is needed. Any node can
  coordinate, and a lost batch is simply resubmitted.

### Dispatch

- **Worker pool:** the coordinating node runs one worker goroutine per node in
  the peer list.
- **Routing:** a `RoutingClient` sends this node's own tasks to its local
  executor and all others over HTTP.
- **Failures:** a failed attempt (timeout, connection error, 4xx/5xx) is requeued
  for any node. After `max_attempts` (3) the task is marked failed.
- **Backoff:** after a failure, that node's worker backs off exponentially and
  takes no work until `GET /health` passes.
- **Busy is not failure:** a `503` means the node was at its concurrency limit and
  ran nothing. The task is requeued **without** using up a retry.
- **Shared limit:** a node's own batch and tasks from other coordinators share one
  `max_concurrent_tasks` limit. This lets several nodes coordinate batches at the
  same time without overloading anyone.

### Reproducibility

- **Seed scheme:** `seed = base_seed + task_index`.
- **Same seed, same results:** identical seeds give identical results on any
  coordinator and with any number of nodes. The serial baseline re-runs the seeds
  on the coordinating node alone, and the report checks
  `serial_results_match_distributed`.

### Confidence intervals

- **Method:** normal approximation, `mean ± 1.96·s/√n`.
- **Limit:** valid for n ≥ 30.

## Configuration

| File / variable | Purpose |
|-----------------|---------|
| `config/peers.yaml` (`PEERS_CONFIG`) | Static membership list: `id`, `url`. It is the same file on every node and must include the node itself. |
| `config/node.yaml` (`NODE_CONFIG`) | Settings shared by all nodes. Coordination: `request_timeout`, `health_timeout`, `max_attempts`, backoff, `phase_timeout`. Execution: `sim_timeout` (must be < `request_timeout`), `max_concurrent_tasks`, `python_bin`, `sim_script`. Run defaults. |
| `NODE_ID` | This node's id, which must appear in the peer list (default: hostname). |
| Upper-case setting names (`REQUEST_TIMEOUT`, `SIM_TIMEOUT`, `MAX_CONCURRENT_TASKS`, …), `LOG_LEVEL` | Per-node overrides. |

## Security

There is **no authentication and no TLS**, because the design assumes a trusted
set of nodes. These defaults limit exposure:

- **Network:** Compose publishes node ports on `127.0.0.1` only. Set `NODE_BIND=0.0.0.0`
  only on a trusted LAN or VPN. Because every node exposes both `/run` and `/task`,
  every node is an entry point.
- **Containers:** non-root user (uid 10001), `cap_drop: ALL`, `no-new-privileges`,
  read-only root filesystem, `pids_limit`, `mem_limit`, and the config mounted read-only.
- **Toolchain:** Go 1.27, a supported release, since `net/http` is compiled into
  the binary.
- **Execution limits:** `max_concurrent_tasks` (extra requests get 503),
  `sim_timeout`, size-capped subprocess output, and 1 MiB request bodies. The
  subprocess runs without a shell, gets only numeric arguments, and sees a
  stripped-down environment (`PATH`, `LANG`), so secrets are not inherited.
- **HTTP:** read/write/idle server timeouts. Unknown JSON fields are rejected.
  Only the last 10 batches are kept per node. Redirects are never followed.

**Deploying across real machines:**
- Use a private network or VPN.
- Firewall port 8000 so only other pool members can reach it.
- Every node trusts every other node's results.

## Known limitations

- **Coordinator loss:** batch state lives only in the coordinating node's memory.
  If that node dies, resubmit elsewhere; there is no automatic failover (that
  would need leader election; see the PRD stretch goals).
- **Batches per node:** one batch at a time per coordinating node. Several nodes
  can coordinate at once, but then their timing figures affect each other.
- **Tasks per node:** each node's own batch runs one local task at a time. A
  multi-core machine should run several node processes.
- **Supply chain:** dependencies are pinned by version or tag, not by hash or digest.

## Repository layout

```
node/        cmd/node, internal/{api,batch,config,dispatch,peers,sim,stats,task,worker}, Dockerfile
sim/         simulate.py, test_simulate.py, requirements*.txt
config/      peers.yaml, peers.4.yaml, node.yaml
scripts/     demo.sh, kill-node-test.sh, kill-coordinator-test.sh
docker-compose.yml, docker-compose.node4.yml, prd.md
.archive/    pre-P2P coordinator/peer implementation (tarball, git-ignored)
```
