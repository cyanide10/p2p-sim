# Minimal gateway and result screens: implementation plan

> For agentic workers: execute task by task; each task ends with its tests green and a commit. Steps use checkboxes.

**Goal:** a browser launches a batch on the Compose node pool and sees its live progress and final report.

**Architecture:** a new `gateway/` Go module on `127.0.0.1:8090` proxies the node HTTP API, keeps run records in memory and tracks each run in one goroutine. The web app gains Live and Report screens driven only by the run id in the URL.

**Tech stack:** Go 1.22 language level (Go 1.27 toolchain), `gopkg.in/yaml.v3 v3.0.1`; React 19, Vite 8, Vitest 5.

**Spec:** [`docs/superpowers/specs/2026-10-23-minimal-gateway-design.md`](../specs/2026-10-23-minimal-gateway-design.md)

## Global constraints

- No file under `node/` or `sim/` changes.
- Gateway imports nothing from `node/`; third-party dependency is only `gopkg.in/yaml.v3 v3.0.1`.
- Gateway tests need no network, Docker or Python: fake nodes are `httptest` servers.
- Error bodies are `{"error":"message"}` except node `400`/`409` passthrough.
- Run id: unpadded base64url of JSON `[coordinator, batch_id]`.
- Frontend never presents mock data in gateway mode.

## Review focus

1. Coordinator container stopped mid-run: Live shows `coordinator_lost`, not an endless spinner. Owned by Task 4 (tracker) and Task 6 (Live screen).
2. Reload of `#/report/{id}` after the node evicted the batch: stored report with stale marker. Task 5.
3. Node answers `409` because it is busy: the Launch screen's existing alternate-node action still works. Task 5 passthrough test.
4. Gateway shutdown with running trackers: process exits within 5 s with no leaked goroutines. Task 4.
5. Report requested while verdict is `PENDING`: provisional values shown and polling continues; not stored as final. Task 5 and Task 7.

## File map

```
gateway/go.mod, go.sum, README.md
gateway/cmd/gateway/main.go               wiring, signals, shutdown
gateway/internal/config/config.go         Settings, Peer, Defaults loaders
gateway/internal/nodeclient/client.go     node HTTP client, typed *Error
gateway/internal/testnode/testnode.go     scriptable fake node
gateway/internal/cluster/cluster.go       /api/cluster snapshot
gateway/internal/runs/ids.go              EncodeID / DecodeID
gateway/internal/runs/request.go          CreateRequest, Params, Resolve
gateway/internal/runs/store.go            in-memory Store
gateway/internal/runs/tracker.go          one goroutine per run
gateway/internal/server/server.go         routes, JSON helpers
config/peers.gateway.yaml                 host URLs for node-1..3
web/vite.config.ts                        proxy → 8090
web/src/App.tsx                           live/report routes
web/src/pages/LivePage.tsx, ReportPage.tsx
web/src/lib/report.ts (+ test)            pure helpers for the Report screen
web/src/api/mock/MockApiClient.ts         timer-driven mock run
web/src/style.css                         styles for the new screens
```

## Task 1: module, config, peers file

- Produces: `config.LoadSettings(getenv func(string) string) (Settings, error)`; `config.LoadPeers(path) ([]Peer, error)`, `config.ParsePeers([]byte)`; `config.LoadDefaults(path) (Defaults, error)` where a missing file returns `BuiltinDefaults()`.
- `Settings{Listen, PeersPath, NodeConfigPath string; RequestTimeout time.Duration; LogLevel string}`.
- Tests: valid peers; empty list; duplicate id; duplicate URL; bad scheme; trailing slash trimmed; defaults overlay keeps unspecified built-ins; missing defaults file; env overrides and bad duration.
- [ ] write tests → fail → implement → `go test ./...` → commit.

## Task 2: node client and fake node

- Produces: `nodeclient.New(timeout) *Client` with `Health(ctx, base) error`, `Peers(ctx, base) (PeersResponse, error)`, `Run(ctx, base, body []byte) (RunResponse, error)`, `Status(ctx, base, batchID) (json.RawMessage, error)`, `Report(ctx, base, batchID) (json.RawMessage, error)`; `*Error{Kind, StatusCode, Message, Body}` with kinds `Unreachable, Timeout, HTTP, Decode`; `IsNotFound(err) bool`.
- `testnode.New(id) *Node`, `URL()`, `Close()`, `Update(func(*Node))`, fields `Healthy`, `PeerView`, `RunStatus`, `CompleteAfter`, `Lost`, `Delay`, accessors `RunBodies()`, `StatusCalls()`.
- Tests: timeout → `Timeout`; closed server → `Unreachable`; redirect not followed → `HTTP` 302; body over 4 MiB → `Decode`; `409` message extracted and body kept.
- [ ] write tests → fail → implement → test → commit.

## Task 3: cluster snapshot

- Produces: `cluster.Probe(ctx, c *nodeclient.Client, peers []config.Peer) Snapshot`.
- Tests: all healthy; one down (row error, others unaffected, `peers_seen` from survivors); disagreement matrix; four nodes.
- [ ] write tests → fail → implement → test → commit.

## Task 4: run ids, request resolution, store, tracker

- Produces: `runs.EncodeID`, `runs.DecodeID`; `runs.CreateRequest` (pointer fields + `Coordinator`), `runs.Resolve(req, d config.Defaults) (NodeRequest, error)`; `runs.NewStore(capacity)`, `HasRoom`, `Add`, `Get`, `List(limit, offset)`, `SetStatus`, `SetReport`, `SetState`; `runs.NewTracker(ctx, store, client, peerURLs, interval, maxFailures, logger)`, `Track(runID)`, `Wait()`.
- Tests: id round trip and malformed ids; every validation rule; omitted seed omitted from node request; eviction of oldest finished; full of running; tracker to `complete` with report stored; lost by `404`; lost after five failures; recovery resets the counter; cancellation stops trackers (`Wait` returns).
- [ ] write tests → fail → implement → `go test -race ./...` → commit.

## Task 5: HTTP server and main

- Produces: `server.New(server.Deps) http.Handler`; `cmd/gateway` binary; `config/peers.gateway.yaml`; `gateway/README.md`.
- Tests: `/healthz`; `/api/config` has no `base_seed`; launch to report end to end against fake nodes; `400` validation without contacting the node; unknown coordinator; unknown JSON field; body over 1 MiB; `409` passthrough with node body; node down → 502; slow node → 504; status live then stale after node closes; report fallback after `404`; unknown and malformed run ids → 404; list paging and bad params; provisional report is not stored.
- [ ] write tests → fail → implement → `go vet ./... && go test -race ./...` → commit.

## Task 6: frontend routing, mock run, Live screen

- `vite.config.ts` proxy target `http://127.0.0.1:8090`.
- `App.tsx`: parse `#/live/{id}` and `#/report/{id}`; remove the accepted-run panel and `submittedRun` state.
- Mock: module-level run table; `createRun` registers a run; status advances over 10 s plus 4 s serial phase; `serial-mismatch` scenario sets the match flag false; `coordinator-loss` scenario loses the run after 4 s.
- `LivePage`: polls record and status every 500 ms; backoff 1, 2, 4, 5 s; terminal handling per spec.
- [ ] `npm run typecheck && npm test && npm run build` → commit.

## Task 7: Report screen

- `lib/report.ts`: `ciScale(metric)` returning percentage positions for CI low, high, mean and theoretical; `formatSeconds`; tests in `lib/report.test.ts`.
- `ReportPage`: verdict, metrics table and CI bars, tasks per node, failed tasks, timing and speedup, serial-match badge, n < 30 warning, stale marker, Copy JSON; poll every 2 s while `PENDING`.
- [ ] tests → implement → `npm run typecheck && npm test && npm run build` → commit.

## Task 8: live verification

- `docker compose up --build`, run the gateway and `npm run dev:gateway`; launch 100 replications from the browser; confirm the Report shows PASS with real values; reload it; stop the coordinator mid-run and confirm `coordinator_lost`.
