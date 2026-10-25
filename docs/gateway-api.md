# Gateway API Contract (Draft)

Status: implemented in `gateway/` (2026-10-04); behavior beyond this draft is recorded in [`assumptions.md`](assumptions.md). The gateway is a same-origin HTTP API for the SPA; it is not a batch coordinator. JSON field names and downstream behavior below are based on [`node-api-observed.md`](node-api-observed.md).

## Common Rules

- All API paths are under `/api`; `/healthz` is the liveness endpoint. Responses use JSON and errors use `{"error":"message"}` unless otherwise specified.
- Reject unknown JSON fields. Cap request bodies at 1 MiB.
- The gateway binds to `127.0.0.1` by default. No CORS is needed for the same-origin SPA.
- Optional bearer-token auth applies to `/api/*`, not `/healthz` or static assets. Do not embed the token in frontend JavaScript. A deployment that needs browser auth must supply it through a deliberate runtime mechanism.
- A gateway run ID is the unpadded base64url encoding of the UTF-8 JSON array `[coordinator, batch_id]`. This is reversible, URL-path-safe, and unambiguous. The response still includes `coordinator` and the node's original `batch_id` as separate fields.
- Request defaults are loaded by the gateway from its configured shared node config (default path `config/node.yaml`) or gateway built-in fallback values matching the node defaults. The gateway resolves omitted fields before forwarding and stores the resolved values. The configured defaults must match the nodes' effective defaults; the node API has no endpoint to verify them. Prefer the launch UI to submit every field explicitly.
- Frontend and gateway validation must agree: replications integer 2..100,000; positive finite lambda, mu, sim_time, and tolerance; `lambda < mu`; finite warmup time `>= 0` and `< sim_time`; base seed `>= 0` and leaves room for all task seeds. Since JSON numbers consumed by JavaScript must remain exact, browser-submitted seeds are restricted to safe integers (`<= Number.MAX_SAFE_INTEGER - replications`).
- `complete` means the node's `/status.state` is `complete`. A report verdict of `FAIL` is a statistical result, not gateway execution state. Current node behavior does not provide a separate failed batch state; do not infer one from the verdict.

## Endpoints

### `GET /api/config`

Returns form defaults and configured gateway membership:

```json
{
  "defaults": {
    "replications": 100,
    "lambda": 0.8,
    "mu": 1.0,
    "sim_time": 10000,
    "warmup_time": 1000,
    "tolerance_pct": 10,
    "base_seed": 0,
    "serial_baseline": true
  },
  "peers": [{"id":"node-1","url":"http://127.0.0.1:8081"}],
  "gateway_version": "dev",
  "features": {"task_grid": false}
}
```

`base_seed` is a UI placeholder; the launch form offers an explicit random-seed action. The peer list is the gateway's configured view and does not prove that nodes have adopted the same membership.

### `GET /api/cluster`

Always returns `200`; individual node failures are represented in rows:

```json
{
  "nodes": [{
    "id":"node-1",
    "url":"http://127.0.0.1:8081",
    "healthy":true,
    "observer_id":"node-1",
    "latency_ms":3,
    "peers_seen":{"node-1":true,"node-2":false}
  }],
  "updated_at":"2026-10-02T12:00:00Z"
}
```

`observer_id` is the node that supplied the row's `/peers` view. `peers_seen` is based on that observer's own peer response; an absent key means unknown/not reported, while `false` means explicitly unhealthy. Include `error` on a row when its probe failed. Probe node endpoints concurrently with bounded concurrency and per-node timeouts. Measure `latency_ms` for the gateway's probe of that node.

### `POST /api/runs`

Body: `coordinator` (configured peer ID), plus optional node `/run` fields `replications`, `lambda`, `mu`, `sim_time`, `warmup_time`, `tolerance_pct`, `base_seed`, and `serial_baseline`. The gateway resolves omitted fields and forwards the complete resolved request to the selected node.

On node `202`, return `202` with the node start response plus `run_id`:

```json
{
  "run_id":"WyJub2RlLTEiLCJiYXRjaC1ub2RlLTEtLi4uIl0",
  "batch_id":"batch-node-1-20261002T120000-abcdef",
  "status":"started",
  "coordinator":"node-1",
  "replications":100,
  "base_seed":42,
  "peers":3
}
```

Pass node `400` and `409` status and error JSON through unchanged. Other downstream failures map to `502` (unreachable or invalid response) or `504` (timeout). If the node accepted a run but the gateway cannot persist its history record, return a gateway error with `accepted: true`, `run_id`, `coordinator`, and `batch_id` when known; do not imply the node rejected the run.

Network runs: send `kind: "network"` with `scenario` (and optional `replications`, `base_seed`); the gateway forwards to the node's `POST /netrun`. The stored `params` carry `kind` and `scenario`, and status, report and history work the same way. `GET /api/runs/{id}/report` then returns the network report shape (see `node-api-observed.md`).

### `POST /api/netstream`

Body `{node, scenario, speed, seed?}`. Relays the named node's `POST /netstream` (only `{scenario, speed, seed}` is forwarded). Same error mapping as `/api/stream`.

### `GET /api/runs?limit=&offset=`

Returns newest-first history:

```json
{"runs":[{"run_id":"...","batch_id":"...","coordinator":"node-1","created_at":"2026-10-02T12:00:00Z","params":{},"state":"running","status":{},"report":null}],"limit":50,"offset":0,"total":1}
```

Clamp limit to a documented server maximum and reject negative offsets. `report` and `status` may be null if not yet captured.

### `GET /api/runs/{run_id}`

Returns one history record with its most recent status snapshot and any captured final report. Unknown ID returns `404`.

### `GET /api/runs/{run_id}/status`

Proxy live `GET /status?batch_id=...` to the recorded coordinator. Return the node status body plus `stale: false`. When the coordinator is unavailable, return the last stored status body plus `stale: true`; if no snapshot exists, return `502`/`504` with a JSON error. Node `404` means it no longer knows the batch and contributes to `coordinator_lost`.

### `GET /api/runs/{run_id}/report`

Proxy live `GET /report?batch_id=...` and return its real node report shape plus `stale: false`. If unavailable, return a previously captured final report plus `stale: true`. If no final report was captured, return `502`/`504` with a JSON error. Unknown run returns `404`.

### `GET /api/stream?node=&lambda=&mu=&duration=&speed=&seed=`

Relays a live traffic stream from the named configured node (`GET /stream` on that node) to the browser as `text/event-stream`. Only the five simulation parameters are forwarded. Unknown node: `400`. Node `400`/`503` are passed through. Closing the browser connection closes the node stream, which stops the simulation.

### `GET /healthz`

Returns `200` JSON when the gateway process is alive. It does not assert that nodes or SQLite are healthy.

## History and Tracking

Each stored run contains `run_id`, `batch_id`, `coordinator`, `created_at`, fully resolved request parameters including `base_seed`, `state`, latest status snapshot, and final report when captured. Initial state is `running`.

- On node status `complete`, set gateway state to `complete` and fetch/store the final report. Keep report verdict separate from run state.
- On repeated connection/timeout failures, mark `coordinator_lost` only after the configured threshold. A node `404` indicates it no longer recognizes the batch. If the coordinator later returns the batch, refresh the record and state.
- Use `unknown` only when a persisted record cannot be interpreted or reconciled; do not use it as a synonym for report verdict `FAIL`.
- Track running records at startup. Use at most one tracker per run and a global concurrency cap. Stop trackers on gateway shutdown.
- Store snapshots so status/report can be served as stale data when the coordinator is unavailable. Node state is not durable and the node retains only a bounded number of batches.

## Review Decisions

This draft intentionally makes several details explicit that were underspecified in the initial plan: unstable queues are rejected to match node behavior; history state is distinct from statistical verdict; browser seed range preserves JavaScript integer precision; peer hot reload affects only gateway configuration; and the gateway's peers file must use URLs reachable from where the gateway process runs. For native Windows, use host-reachable URLs, not Compose-only service names. Container addressing is deferred to a later Docker/WSL integration phase.

Go and npm dependencies may require network access on first installation. The offline requirement applies to build/test runs after dependencies have been installed or cached; a clean machine cannot bootstrap dependencies offline unless they are vendored.
