# PDES Testing Procedure

This guide covers automated tests and a real multi-node PDES run. Run commands
from the repository root unless a command first changes directories.

## Prerequisites

- Python 3 and `pip`
- Go version required by the modules
- Node.js and npm
- Docker Engine and the Docker Compose plugin for the multi-node test
- `curl` for the optional API checks

## 1. Run the automated test suites

Set up the Python test environment once:

```bash
python3 -m venv .venv
.venv/bin/pip install -r sim/requirements-dev.txt
```

Run each suite:

```bash
cd sim
../.venv/bin/python -m pytest -q

cd ../node
go test -race ./...

cd ../gateway
go test -race ./...

cd ../web
npm ci
npm run typecheck
npm test
npm run build
```

Expected: every command exits successfully. Python tests cover the simulator,
partition planning, worker protocol, and merged metrics. The Go tests cover the
node and gateway behavior using local fake workers/nodes; they do not need a
Docker cluster. The web tests cover client-side network generation and
partition-time helpers.

## 2. Start a real three-node cluster and gateway

From the repository root:

```bash
docker compose -f docker-compose.yml -f docker-compose.web.yml up --build
```

Wait for the images to build and the services to start. In another terminal,
check the gateway and node health endpoints:

```bash
curl --fail http://localhost:8090/healthz
curl --fail http://localhost:8081/health
curl --fail http://localhost:8082/health
curl --fail http://localhost:8083/health
```

Open [http://localhost:8090](http://localhost:8090).

## 3. Generate a network and inspect the partition plan

In the GUI:

1. Open **Network lab**.
2. Under **Generate a grid and run PDES**, keep the defaults or choose a
   supported grid/torus configuration.
3. Click **Generate grid**. The generator seed controls the generated flow
   pairs; keeping the seed and settings reproduces the scenario.
4. Choose a coordinator and a partition count that does not exceed either the
   healthy-node count or router count.
5. Click **Preview plan**.

Check that the plan displays partition ownership colors, cut links, lookahead,
window count, and partition loads. The topology view should color nodes by
partition and mark cut links. If planning fails, read the displayed error; for
example, the scenario may exceed simulator limits or request too many
partitions.

## 4. Run PDES and inspect progress and results

1. Leave **Run serial baseline** enabled to compare against the single-process
   simulator.
2. Click **Run partitioned**.
3. In the live view, check that simulated time and completed/total windows
   advance. Per-partition timing rows should show compute and barrier-wait
   time.
4. When the run completes, click **View report**.
5. Check the partition map, timing breakdown, and merged flow/link/router
   metrics. With the baseline enabled, inspect the results-identical indicator
   and speedup.

Speedup is not guaranteed. Small runs can be slower because every PDES window
requires coordination and network communication.

## 5. Optional direct plan API check

Export the generated scenario as JSON from the Network lab, for example to
`/tmp/network.json`. Then submit that JSON to the gateway's plan endpoint:

```bash
jq -n --slurpfile scenario /tmp/network.json \
  '{coordinator:"node-1", parts:3, scenario:$scenario[0]}' |
  curl --fail-with-body -sS \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    http://localhost:8090/api/pdes/plan
```

The response should be a plan object with `ok`, `parts`, `assignment`,
`cut_links`, `lookahead`, `windows`, and `load`. If `jq` is unavailable, the
same request can be sent from the GUI.

## 6. Optional direct run API check

Start a run through the gateway using the exported scenario:

```bash
jq -n --slurpfile scenario /tmp/network.json \
  '{coordinator:"node-1", kind:"pdes", parts:3, base_seed:12345,
    baseline:true, scenario:$scenario[0]}' |
  curl --fail-with-body -sS \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    http://localhost:8090/api/runs
```

Save the returned `run_id` and `batch_id`. The gateway associates the run
record with the coordinator and tracks the node status/report; the GUI does
this automatically. To inspect the node's current status and report directly:

```bash
curl --fail-with-body -sS \
  'http://localhost:8081/status?batch_id=PASTE_BATCH_ID'
curl --fail-with-body -sS \
  'http://localhost:8081/report?batch_id=PASTE_BATCH_ID'
```

The returned status should have `kind: "pdes"` and a `state` that progresses
from `running` to `complete` (or `failed` if a worker fails). The report should
include the plan, partition timings, and merged metrics when available.

## 7. Stop the cluster

In the terminal running Compose, press `Ctrl+C`, then remove the containers:

```bash
docker compose -f docker-compose.yml -f docker-compose.web.yml down
```

The gateway history volume is retained by default. To preserve it, do not add
`--volumes`/`-v` to the `down` command.
