# Minimal gateway and result screens: design

Status: approved in conversation on 2026-10-23, pending written review.
Builds on [`docs/gateway-api.md`](../../gateway-api.md) and [`docs/node-api-observed.md`](../../node-api-observed.md). Where this document is narrower, it wins for this release.

## Goal

A browser connected to a real node pool. The user launches a batch from the Launch screen, watches it progress, and sees the processed report in the same browser. The URL carries the run id, so reloading or opening the link in another tab shows the same run.

## Scope

In scope:

- New Go module `gateway/` implementing the `gateway-api.md` routes with in-memory history.
- Live and Report screens in `web/`, plus a mock run so both screens work without a gateway.
- Gateway on `127.0.0.1:8090`; Vite gateway-mode proxy retargeted to it.
- Nodes run with the existing `docker compose up --build` on host ports 8081–8083.

Out of scope for this release: SQLite history, peers-file hot reload, bearer-token auth, embedding the SPA in the gateway binary, a gateway Dockerfile or Compose service, the History screen, the task grid, and any change under `node/` or `sim/`.

## Data flow

1. Launch calls `POST /api/runs` with `coordinator` and the run fields. The gateway validates, resolves omitted fields from `config/node.yaml` defaults, and forwards to that node's `POST /run`.
2. On node `202` the gateway stores a run record in state `running`, starts one tracker for it, and returns `202` with the node body plus `run_id`.
3. `run_id` is unpadded base64url of the UTF-8 JSON array `[coordinator, batch_id]`.
4. The browser navigates to `#/live/{run_id}` and polls `GET /api/runs/{run_id}/status` every 500 ms.
5. When the status state is `complete`, the Live screen navigates to `#/report/{run_id}`, which loads `GET /api/runs/{run_id}/report`.

## Gateway

Module `github.com/p2p-sim/gateway`, Go language level 1.22, built with the installed Go 1.27 toolchain. Dependencies: standard library and `gopkg.in/yaml.v3 v3.0.1`. No imports from `node/`.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_LISTEN` | `127.0.0.1:8090` | Bind address |
| `PEERS_CONFIG` | `config/peers.gateway.yaml` | Node ids and host-reachable URLs, read once at startup |
| `NODE_CONFIG` | `config/node.yaml` | Source of run defaults; only the `defaults` block is read |
| `NODE_REQUEST_TIMEOUT` | `5s` | Per node call |
| `LOG_LEVEL` | `info` | slog level |

Relative paths resolve against the working directory. `config/peers.gateway.yaml` lists `node-1..3` at `http://127.0.0.1:8081..8083`; ids must equal the nodes' `NODE_ID`s. Peers validation matches the node: non-empty unique ids, absolute http(s) URLs, unique URLs, trailing slash trimmed. If `NODE_CONFIG` is missing or lacks a field, built-in defaults equal to the node's `config/node.yaml` values apply: replications 100, lambda 0.8, mu 1.0, sim_time 10000, warmup_time 1000, tolerance_pct 10, serial_baseline true.

### Packages

- `config`: settings from the environment, peers file, run defaults.
- `nodeclient`: `Health`, `Peers`, `Run`, `Status`, `Report`. One `http.Client` that never follows redirects; every call uses `NODE_REQUEST_TIMEOUT`; response bodies capped at 4 MiB. Errors are one type `*Error` with `Kind` of `Unreachable`, `Timeout`, `HTTP` (with `StatusCode` and the node's `error` message) or `Decode`.
- `cluster`: concurrent `/health` and `/peers` probes per configured node. Produces the `ClusterSnapshot` shape in `web/src/api/types.ts`. `latency_ms` is the gateway's `/health` round trip. `observer_id` is the node id when its `/peers` call succeeded, else null. `peers_seen` maps every configured id to that observer's `healthy` value, or null when not reported. Always returns 200.
- `runs`: in-memory store and trackers.
  - Records hold `run_id`, `batch_id`, `coordinator`, `created_at`, resolved `params`, `state`, last `status`, final `report`.
  - Capacity 200 records. When full, the oldest record that is not `running` is evicted. If every record is running, `POST /api/runs` returns `503 {"error":"run history is full of running batches"}` without contacting a node.
  - One tracker goroutine per running record. Poll interval 1 s. Each successful status is stored. On `state == "complete"` it fetches the report, stores it, sets record state `complete`, and stops. If the report fetch fails it retries on the next tick, up to 5 consecutive failures, then sets `complete` without a stored report.
  - A node `404` sets `coordinator_lost` immediately. Five consecutive unreachable, timeout, decode or non-404 HTTP failures set `coordinator_lost`. Any success resets the counter.
  - Trackers stop when the gateway context is cancelled. History is lost on restart.
  - The report `verdict` never affects the run `state`.
- `server`: HTTP routes and middleware.
- `cmd/gateway`: wiring, signal handling, graceful shutdown within 5 s.

### Routes

| Route | Behavior |
|---|---|
| `GET /healthz` | `200 {"status":"ok"}` |
| `GET /api/config` | `{"defaults", "peers", "gateway_version":"dev", "features":{"task_grid":false}}`; `defaults` has no `base_seed` |
| `GET /api/cluster` | Cluster snapshot |
| `POST /api/runs` | Validate, forward, record, track (see below) |
| `GET /api/runs?limit=&offset=` | Newest first; default limit 50, maximum 200; negative or non-integer values return 400 |
| `GET /api/runs/{run_id}` | The record; 404 if unknown or undecodable |
| `GET /api/runs/{run_id}/status` | Live node status plus `stale:false`; on node failure, stored status plus `stale:true`; with no stored status, 502 or 504 |
| `GET /api/runs/{run_id}/report` | Live node report plus `stale:false`; on node failure, stored report plus `stale:true`; with none stored, 502 or 504 |

A successful live status or report also updates the stored copy. A live `404` from the node on these two routes falls back to the stored copy with `stale:true`; with no stored copy it returns `404 {"error":"coordinator no longer holds this batch"}`.

`POST /api/runs` body: `coordinator` (required, a configured id) and optional `replications`, `lambda`, `mu`, `sim_time`, `warmup_time`, `tolerance_pct`, `base_seed`, `serial_baseline`. Unknown fields and bodies over 1 MiB return 400. After resolving defaults it validates: replications integer 2..100000; lambda, mu, sim_time, tolerance_pct finite and > 0; lambda < mu; warmup_time finite and ≥ 0 and < sim_time; base_seed ≥ 0 and ≤ 2^53−1 − replications. A missing `base_seed` is left out of the forwarded request so the node picks one; the stored params take the node's returned `base_seed`. Errors:

- validation or unknown coordinator: `400 {"error"}` without contacting a node
- node `400` or `409`: same status and node body passed through
- node unreachable or decode failure: 502; node timeout: 504

Every error body is `{"error":"message"}` except the passthroughs. Server timeouts: read-header 5 s, read 10 s, write 30 s, idle 60 s.

### Testing

Package `internal/testnode` provides an `httptest` fake node with scriptable `/health`, `/peers`, `/run`, `/status`, `/report`: healthy, down, slow, `409`, a batch that moves to `complete` after a set number of `/status` calls, and disappearing mid-batch. Tests need no network, Docker or Python.

Required cases: peers validation; node client timeout, redirect refusal, oversized body, HTTP error message; cluster with one node down, a disagreement matrix, and four nodes; run lifecycle to `complete` with report stored; `409` passthrough; coordinator loss by `404` and by five failures; stale status and report fallback; unknown and malformed run ids; unknown JSON field; body cap; tracker shutdown leaves no goroutines; eviction and the full-of-running case. Run `go vet ./...` and `go test -race ./...`.

## Frontend

- Proxy: gateway mode targets `http://127.0.0.1:8090` for `/api` and `/healthz`.
- Routing: `#/live/{run_id}` and `#/report/{run_id}`, both driven only by the run id in the URL. The placeholder accepted-run panel is removed.
- Live screen: progress bar of complete plus failed over replications; counts; phase; coordinator, base seed and elapsed seconds from the record and status; stale marker. Poll every 500 ms; after a failed request wait 1, 2, 4 then 5 s maximum; reset on success. Stop polling on `complete` or `coordinator_lost`. On `complete`, replace the hash with the report route. On `coordinator_lost`, show a banner that the batch state is gone and a link to Launch with the base seed shown for resubmission.
- Report screen: verdict and detail first; a table for W, L and ρ with mean, 95% CI, theoretical, relative error, within tolerance, theory in CI; a horizontal bar per metric showing the CI span with the theoretical marker; tasks per node; failed tasks when present; distributed and serial wall clock and speedup; serial-match badge (text plus color); warning when n < 30; stale marker; "Copy JSON" button. While the verdict is `PENDING`, poll every 2 s.
- Mock client: `createRun` registers a mock run whose status advances from 0 to complete over about 10 s, then reports the plausible λ=0.8, μ=1.0 report with PASS. `getRun`, `getStatus`, `getReport` serve it. Other scenarios keep their current behavior.
- Run `npm run typecheck`, `npm test`, `npm run build`.

## Running it

From the repository root, because the default config paths are relative to it:

```bash
docker compose up --build
(cd gateway && go build -o ../bin/gateway ./cmd/gateway) && bin/gateway
(cd web && npm run dev:gateway)
```

`gateway/README.md` documents these commands and the environment variables.

## Acceptance

- A 100-replication batch launched from the browser against the Compose pool reaches the Report screen with real node values and a PASS verdict.
- Reloading `#/report/{run_id}` shows the same report.
- Stopping the coordinator container during a run shows `coordinator_lost` on the Live screen.
- No file under `node/` or `sim/` changes.
