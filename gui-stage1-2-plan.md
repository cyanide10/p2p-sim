# p2p-sim GUI: Stage 1 and 2 implementation plan

Audience: an AI coding agent working in the `p2p-sim` repo.
Scope: **Stage 1** (frontend against a mock API) and **Stage 2** (Go gateway, tested natively).
Out of scope: Dockerfiles, Compose changes, the failure-lab sidecar, and any change to `node/` or `sim/`.

---

## 0. Context

p2p-sim runs M/M/1 queueing simulations as independent, seeded replications across a static pool of identical nodes. Any node can coordinate a batch (`POST /run`); batch state lives only in that node's memory. Read `README.md` first; it is the source of truth for the node API.

We are adding a web GUI made of two new pieces:

- `web/`: a single-page app (Vite + TypeScript).
- `gateway/`: a small Go service that serves the SPA, proxies and aggregates node APIs, and stores batch history.

The gateway is **not** a coordinator. If it dies, the cluster keeps working.

### Environment constraints

- Windows, **native** (PowerShell). No Docker, no WSL, no bash.
- Tools available: Git, Go 1.27, Node.js LTS. Python is optional and not needed here.
- Use `curl.exe`, not `curl`, in PowerShell examples.
- Everything must build and test without Docker, a network, or Python.

### Ground rules

1. **Inspect before assuming.** Before writing types, read `node/internal/api`, `node/internal/batch`, `node/internal/peers`, `node/internal/config` and `config/*.yaml`. The README does not specify the JSON for `/status`, `/report` or `/peers`. Derive the real shapes from the Go code and record them in `docs/node-api-observed.md`. If something can't be determined, mark it `UNVERIFIED` in that file and isolate the guess in one place.
2. **Do not modify `node/` or `sim/`.** If the GUI needs something the node API lacks, record it in `docs/node-api-gaps.md` and design around it (feature-flag the UI).
3. **Keep the gateway contract in one place.** Write `docs/gateway-api.md` first (section 2). Frontend and gateway both implement against it.
4. **No new auth surface by accident.** Bind to `127.0.0.1` by default. Reject unknown JSON fields. Cap request bodies at 1 MiB. Never follow redirects when calling nodes.
5. **Small, reviewable commits** following the milestone order in section 5. Stop and report at each milestone gate.
6. Mark anything you assumed in a final `docs/assumptions.md`.

---

## 1. Repository layout to create

```
docs/
  node-api-observed.md     # real node JSON shapes, from reading the code
  node-api-gaps.md         # things the GUI wants but nodes don't offer
  gateway-api.md           # the contract (section 2)
  assumptions.md
web/
  package.json, vite.config.ts, tsconfig.json, index.html
  src/
    api/
      types.ts             # TS types mirroring gateway-api.md
      client.ts            # ApiClient interface + real fetch implementation
      mock/                # mock implementation + scenarios
    components/ pages/ hooks/ lib/
gateway/
  go.mod
  cmd/gateway/main.go
  internal/
    config/                # gateway settings + peers.yaml reader
    nodeclient/            # HTTP client for node endpoints
    aggregate/             # cluster view, who-sees-whom matrix
    store/                 # SQLite history
    runs/                  # run tracking + background poller
    server/                # HTTP routes, middleware, SPA serving
  web_embed.go             # go:embed of web/dist (with placeholder fallback)
```

Reuse nothing from `node/internal` by import unless it is already a clean, exported package. Duplicating a small peers.yaml parser is acceptable. Do not create a cross-module dependency that couples releases.

---

## 2. Gateway API contract (write this first)

All paths are under the gateway's origin. JSON only. Errors use `{"error": "message"}` with a suitable status.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Defaults for the launch form and peer list: run defaults (from the nodes' `node.yaml`, or hardcoded fallbacks), `peers: [{id,url}]`, `gateway_version`. |
| GET | `/api/cluster` | Per node: `id`, `url`, `healthy`, `self` (which node answered), `latency_ms`, `peers_seen: {peerId: healthy}` (from that node's own `/peers`), `error?`. Fans out in parallel with a short timeout. Always returns 200, with per-node errors inside. |
| POST | `/api/runs` | Body: `coordinator` (node id) plus the `/run` fields (`replications`, `lambda`, `mu`, `sim_time`, `warmup_time`, `tolerance_pct`, `base_seed`, `serial_baseline`). Forwards `POST /run` to that node. Stores a history record. Returns `202` with the node's response plus `coordinator`. Passes `400` and `409` through unchanged. |
| GET | `/api/runs` | History, newest first. Query: `limit`, `offset`. |
| GET | `/api/runs/{batchId}` | One history record plus the latest known status. |
| GET | `/api/runs/{batchId}/status` | Live: proxied to the recorded coordinator's `/status?batch_id=`. If the coordinator is unreachable, return the last stored snapshot with `"stale": true`. |
| GET | `/api/runs/{batchId}/report` | Live proxy of `/report`; falls back to the stored final report with `"stale": true`. |
| GET | `/healthz` | Gateway liveness. |

A history record contains: `batch_id`, `coordinator`, `created_at`, request params (including the effective `base_seed`), `state` (`running | complete | failed | coordinator_lost | unknown`), the last status snapshot, and the final report if captured.

State meanings: `coordinator_lost` means the coordinator became unreachable (or no longer knows the batch) before the batch finished. The UI offers "resubmit with same `base_seed` on another node" for these.

Batch IDs are unique only per coordinator, so the gateway keys records on `(coordinator, batch_id)` and the URL `batchId` is exposed as the composite `"{coordinator}:{batch_id}"`. Document the exact encoding in `gateway-api.md`.

---

## 3. Stage 1: frontend with a mock API

Goal: a fully navigable GUI that runs entirely on mock data with `npm run dev`. No gateway, no nodes.

### 3.1 Stack

- Vite, TypeScript (strict), Preact or React (pick one, stay consistent).
- Routing: a tiny router (hash routing is fine, since it keeps SPA serving trivial in the gateway).
- Charts: uPlot or Chart.js. Prefer whichever gives a clean dot-and-whisker (point plus error bar) chart with the least code.
- Styling: plain CSS with CSS variables, with light and dark themes via `prefers-color-scheme`. No UI framework needed.
- Tests: Vitest for pure logic (validation, formatting, mock scenarios). Component tests are optional.

### 3.2 API layer

- Define `interface ApiClient` in `api/client.ts` with one method per gateway endpoint in section 2.
- Provide two implementations: `HttpApiClient` (fetch against `/api`) and `MockApiClient`.
- Select via `VITE_USE_MOCK=true` (default `true` during Stage 1). No component imports mock code directly.
- Vite dev server proxies `/api` to `http://127.0.0.1:8080` when mock is off, so Stage 2 plugs in without frontend changes.

### 3.3 Mock behavior

The mock must be good enough to build every screen and exercise every state. Implement it as a small simulation driven by timers, with selectable **scenarios** (a dropdown that appears in dev builds only):

1. **Happy path:** 3 nodes healthy; a 100-replication batch progresses over about 10 s; report with n ≥ 30 and a passing verdict; serial baseline present and `serial_results_match_distributed: true`.
2. **Worker dies mid-batch:** one node turns unhealthy partway through, its task is retried on another node, and the batch still completes.
3. **Coordinator dies:** status calls start failing and the record goes to `coordinator_lost`.
4. **Busy / 409:** `POST /api/runs` returns `409` for a coordinator already running a batch.
5. **Validation error:** `400` with an error message.
6. **Small n:** replications < 30, so the CI warning shows.
7. **Serial mismatch:** `serial_results_match_distributed: false`, shown prominently.
8. **Node 4 appears:** the cluster endpoint returns 4 nodes, to prove nothing is hardcoded to 3.

Mock numbers should be plausible M/M/1 values: for λ=0.8, μ=1.0, W = 1/(μ−λ) = 5 and L = ρ/(1−ρ) = 4. Generate per-replication noise around those and compute mean, standard deviation and 95% CI (`mean ± 1.96·s/√n`) in a shared `lib/stats.ts`.

If the real `/report` shape (from `docs/node-api-observed.md`) differs from what the mock invents, the **real shape wins**. Align `types.ts` and the mock to it.

### 3.4 Screens and acceptance criteria

**A. Cluster**
- One card per node: id, URL, health badge, latency, `self` marker.
- A who-sees-whom matrix (rows = observer node, columns = observed node). It is the visible form of `peers_seen`. Disagreement between rows is highlighted as a possible partition.
- Auto-refreshes every 3 s; shows the last-updated time; handles per-node `error` states without breaking the page.
- Works for any number of nodes.

**B. Launch run**
- Form fields match `/run`: coordinator (dropdown of nodes), replications, λ, μ, sim_time, warmup_time, tolerance_pct, base_seed (with a "random" button), serial_baseline toggle. Pre-filled from `/api/config`.
- Client-side validation (block submit on errors, show warnings but allow submit):
  - **Error:** any numeric field missing or non-positive (warmup_time may be 0), warmup_time ≥ sim_time.
  - **Warning:** ρ = λ/μ ≥ 1 (unstable queue, so theory doesn't apply). Show the computed ρ live, plus the theoretical W and L when ρ < 1.
  - **Warning:** replications < 30 (CI only valid for n ≥ 30).
- On `409`: show a clear message and a "try another node" action that re-selects the next healthy node.
- On `202`: navigate to the Live batch screen.

**C. Live batch**
- Progress bar and counts from `/status` (poll every 500 ms; stop when the batch is terminal; back off if requests fail).
- Show coordinator, base_seed, elapsed time, and the state badge.
- Task grid (**feature-flagged**, `FEATURES.taskGrid`): one cell per replication, colored by state and executing node, retries marked. Real nodes cannot supply per-task detail today (see `docs/node-api-gaps.md`), so build the component against a typed optional `tasks?:` field and render a "needs node API support" placeholder when it is absent. Do not fabricate task data in non-mock mode.
- When the state becomes `coordinator_lost`: show a banner explaining that the batch state is gone, and a "Resubmit on another node with the same base_seed" button that prefilled-navigates to Launch.
- On completion: auto-link to the Report.

**D. Report**
- Table plus dot-and-whisker chart: each metric's mean with 95% CI against the theoretical value. Make the theoretical marker obvious and show whether it falls inside the CI.
- Verdict displayed prominently, using the report's own verdict field.
- Tasks per node (bar or table).
- Distributed vs serial wall clock and speedup; a clear badge for `serial_results_match_distributed` (green when true, a loud red when false).
- Warning banner if n < 30.
- A stale indicator when the data came from the stored snapshot.
- "Copy as JSON" button.

**E. History**
- Table: time, coordinator, replications, λ/μ, base_seed, state, verdict. Row click opens Live or Report depending on state.
- Empty state, and basic pagination.
- A "Re-run with same parameters" action.
- "Compare" is optional: select two runs and show whether their per-metric means are bit-identical (useful when they share a base_seed).

**General UI requirements**
- Responsive down to a 360px width; keyboard-navigable; semantic HTML; visible focus states.
- Color is never the only signal (use icons or text with badges).
- Every async view has loading, empty and error states.
- No hardcoded node count, ports or hostnames anywhere.

### 3.5 Stage 1 milestone gates

- **M1.1** Scaffold, router, theme, `ApiClient` interface, types from observed shapes, mock skeleton. `npm run dev`, `npm run build` and `npm run typecheck` pass.
- **M1.2** Cluster and Launch screens, with validation unit tests.
- **M1.3** Live batch and Report screens, with all mock scenarios working.
- **M1.4** History screen, polish, accessibility pass, `npm test` green.

At each gate, summarize what works and list anything unresolved.

---

## 4. Stage 2: Go gateway

Goal: a gateway binary that implements the section 2 contract, tested natively with fake nodes, and that can serve the built SPA.

### 4.1 Module and dependencies

- Own module: `gateway/go.mod`. Go 1.27.
- Prefer the standard library: `net/http` (with `ServeMux` pattern routing), `encoding/json`, `log/slog`, `embed`, `context`.
- YAML: a maintained library such as `gopkg.in/yaml.v3`, or whatever `node/` already uses (check its `go.mod` and stay consistent).
- SQLite: **`modernc.org/sqlite`** (pure Go, no CGO), because the Windows environment likely has no C compiler. Do not use `mattn/go-sqlite3`.
- Pin dependency versions in `go.mod`. No other third-party dependencies without a clear reason, recorded in `docs/assumptions.md`.

### 4.2 Configuration

Environment variables (with sane defaults):

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_LISTEN` | `127.0.0.1:8080` | Bind address |
| `PEERS_CONFIG` | `config/peers.yaml` | Same peers file the nodes use; re-read on change (check mtime per request or every few seconds) |
| `GATEWAY_DB` | `./data/gateway.db` | SQLite path (directory is created if missing) |
| `GATEWAY_TOKEN` | empty | If set, all `/api/*` requests require `Authorization: Bearer <token>`; compare in constant time |
| `NODE_REQUEST_TIMEOUT` | `5s` | Per-node call timeout |
| `HISTORY_LIMIT` | `500` | Max stored runs (prune oldest) |
| `LOG_LEVEL` | `info` | |

When the peers file changes, the gateway adopts the new membership without a restart. Invalid edits are rejected and the previous list is kept, with a logged error.

### 4.3 Components

**`config`**: peers reader (id, url; validate unique ids, parseable URLs, http/https only) and settings loader.

**`nodeclient`**: typed methods for `GET /health`, `GET /peers`, `GET /status`, `GET /report`, `POST /run`.
- One shared `http.Client` with timeouts; `CheckRedirect` returns an error (never follow redirects).
- Context-aware; limit response body size (for example 4 MiB) with `io.LimitReader`.
- Distinguish error kinds: network or timeout, non-2xx with a body (surface status and message), and decode failure. The server layer maps these to 502/504 or passes through 400/409.

**`aggregate`**: builds `/api/cluster` by calling every node's `/health` and `/peers` in parallel (with bounded concurrency and per-call timeouts), measures latency, and assembles the who-sees-whom matrix. A node failing must never fail the whole response.

**`store`**: SQLite persistence with a tiny migration mechanism (a `schema_version` table). Store the run record, status snapshot JSON and report JSON. Use parameterized queries only. Single writer connection (or `SetMaxOpenConns(1)`) to avoid `SQLITE_BUSY`. Enable WAL.

**`runs`**: orchestrates `POST /api/runs`.
- Validate input server-side (mirror the frontend rules: positive numbers, warmup < sim_time, known coordinator id). Unstable ρ and small n are allowed; the node decides what it accepts.
- Forward to the coordinator; on `202`, persist the record and start a **background tracker goroutine** for that run: poll the coordinator's `/status` every 1 s, update the stored snapshot, and on completion fetch and store the final `/report`.
- Tracker rules: stop on terminal state; mark `coordinator_lost` after N consecutive failures (for example 5) or when the node no longer recognises the batch; stop on gateway shutdown (context cancellation); at startup, resume tracking for records still in `running` state.
- No unbounded goroutines: at most one tracker per run, and a global cap.

**`server`**: routes from section 2, plus:
- Middleware: panic recovery, request logging (`slog`), body size cap (1 MiB), optional bearer-token auth for `/api/*` (not for `/healthz` or static assets), and security headers (`X-Content-Type-Options: nosniff`, a restrictive `Content-Security-Policy` suited to a self-hosted SPA, `Referrer-Policy: no-referrer`).
- JSON decoding with `DisallowUnknownFields`.
- Server timeouts: read-header, read, write and idle.
- Graceful shutdown on interrupt.
- SPA serving: serve embedded `web/dist` for non-API paths, with `index.html` fallback. If `web/dist` is absent, `go:embed` must not break the build. Use a committed placeholder file in the embed directory so `go build` always works, and note how the real build is copied in.
- Map downstream failures consistently: node unreachable → 502, node timeout → 504, node `400/409` → passed through with the node's message, unknown run → 404.

### 4.4 Testing (no network, no Docker, no Python)

Use `httptest.NewServer` to create **fake nodes** with scriptable behavior (healthy, slow, down, returns 409, batch lifecycle that progresses on each `/status` call, node disappearing mid-batch). Place this in an internal `testnode` helper package so tests across packages can reuse it.

Required test coverage:
- peers file: valid, duplicate ids, bad URL, reload on change, bad edit keeps the previous list.
- `nodeclient`: timeout, redirect refusal, oversized body, non-2xx pass-through.
- `aggregate`: one node down, all down, matrix disagreement (node A sees B healthy while C sees B down), 4 nodes.
- `store`: migrations, CRUD, pruning past `HISTORY_LIMIT`, concurrent writes.
- `runs`: success to completion with the report stored; coordinator dies mid-batch → `coordinator_lost`; `409` passthrough; tracker resumes after a simulated gateway restart; no goroutine leaks after cancellation (check by counting or by using a test helper).
- `server`: every route including auth on and off, body cap, unknown JSON fields, stale fallback when the coordinator is down, SPA fallback, path traversal attempts against static serving.

Run `go vet ./...` and `go test ./...`. Note that **`-race` needs CGO and a C compiler**, which may be missing on this Windows machine. Run `go test -race ./...` only if it works; otherwise run without it and record that in `docs/assumptions.md`. Keep the code race-safe regardless (clear ownership, mutexes or channels, no shared maps without locks).

### 4.5 Manual smoke test (optional, only if time allows)

Provide `docs/smoke-windows.md` with PowerShell steps to run `gateway.exe` against fake or real nodes, and to open the SPA served by the gateway. If real nodes are started natively, note the Windows subprocess-environment caveat: the node launches Python with a stripped environment (`PATH`, `LANG`), and Windows Python may need `SystemRoot`. Do not fix this in `node/`; just document it.

### 4.6 Stage 2 milestone gates

- **M2.1** Module skeleton, config and peers reader, `nodeclient`, `testnode` helper, tests green.
- **M2.2** `aggregate` and `/api/cluster`, `/api/config`, `/healthz`. The frontend, with mock off and the Vite proxy pointed at the gateway, shows the Cluster screen using fake nodes.
- **M2.3** `store`, `runs` with the tracker, and all `/api/runs*` routes. The Launch, Live and Report screens work end to end against fake nodes.
- **M2.4** Middleware, auth, embedded SPA serving, graceful shutdown, hardening tests, `docs/` complete.

---

## 5. Overall order of work

1. Read the repo. Write `docs/node-api-observed.md` and `docs/node-api-gaps.md`.
2. Write `docs/gateway-api.md` and share it for review before building on it.
3. Stage 1 (M1.1 to M1.4).
4. Stage 2 (M2.1 to M2.4).
5. Integration check: frontend with mock off against the gateway and fake nodes. Fix contract drift on whichever side is wrong, and update `gateway-api.md`.

Stage 1 and the first two Stage 2 milestones can proceed in parallel once the contract is agreed.

---

## 6. Definition of done

- `npm run typecheck`, `npm test` and `npm run build` pass in `web/`.
- `go vet ./...` and `go test ./...` pass in `gateway/`, with no network, Docker or Python required.
- Every screen in section 3.4 works in mock mode, and the Cluster, Launch, Live and Report screens work against the gateway with fake nodes.
- Adding a fourth node to the peers file appears in the GUI with no code changes.
- No file under `node/` or `sim/` was modified.
- Docs present: `gateway-api.md`, `node-api-observed.md`, `node-api-gaps.md`, `assumptions.md`.

## 7. Explicit non-goals

- Dockerfile and Compose changes (Stage 4).
- The failure lab and anything touching `docker.sock`.
- Changes to the node API (list needs in `node-api-gaps.md` instead).
- Server-sent events or WebSockets; use polling.
- User accounts. The optional bearer token is the only access control.

## 8. Report back with

- Any place where the real node JSON differed from the README or from assumptions.
- The list of node API gaps and which UI features are blocked by them.
- Whether `-race` could run on this machine.
- Any dependency added beyond the section 4.1 list, and why.
