# GUI Implementation Tasks and Plan

This checklist turns the review of [`gui-stage1-2-plan.md`](../gui-stage1-2-plan.md) into an execution order. The active environment is native Windows/PowerShell. Docker and WSL setup are deferred; native development and tests must not depend on them.

## Phase 0: Resolve Contract and Deployment Assumptions

- [x] Read the node API implementation and record exact `/status`, `/report`, `/peers`, `/health`, and `/run` JSON shapes in `docs/node-api-observed.md`.
- [x] Record node API limitations and affected UI features in `docs/node-api-gaps.md`, especially the absence of per-replication task detail.
- [x] Decide unstable-queue behavior. Draft contract blocks `lambda >= mu` to match node validation; changing node behavior would require separate approval.
- [x] Specify the launch defaults source. Draft contract uses a gateway-readable shared node config file or node-equivalent built-in defaults and records that remote defaults cannot be verified.
- [x] Specify that the gateway resolves omitted `/run` fields and stores effective values, including `base_seed`.
- [x] Define matching validation limits for frontend and gateway: replications 2 through 100,000; positive finite lambda, mu, sim_time, and tolerance; warmup time at least zero and less than sim_time; base seed at least zero and within the node's supported integer range.
- [x] Clarify gateway run state mapping: node status `complete` is distinct from report verdict `PASS`/`FAIL`; task failures are reported as counts and failed tasks.
- [x] Record the actual report shape for future frontend types and mock data, including `timing.serial_results_match_distributed`.
- [x] Define cluster response semantics for observer identity and `peers_seen` based on each observer's `/peers` response.
- [x] Define an opaque, URL-safe gateway run ID rather than assuming arbitrary peer IDs are safe path segments.
- [ ] Define token use in the browser if `GATEWAY_TOKEN` is enabled. Never bundle a secret into frontend assets.
- [x] Clarify offline verification: dependencies may require initial downloads; builds/tests run offline after installation or caching.

**Gate:** `docs/gateway-api.md` is drafted against the observed node API. Review/approve its contract and decide browser token delivery before frontend and gateway implementation depend on it.

## Phase 1: Native Frontend

- [x] Scaffold `web/` with Vite, strict TypeScript, hash routing, theme support, API types/client, mock client, and dev-only scenario selection.
- [ ] Add shared pure helpers for validation, formatting, and M/M/1 statistics; test them with Vitest.
- [x] Implement Cluster: arbitrary node count, health and latency, observer identity, who-sees-whom matrix, disagreement indication, refresh/loading/error states.
- [x] Implement Launch: config defaults, healthy coordinator selection, validation and warnings, random seed, 409 alternate-node action, and accepted-run navigation.
- [ ] Implement Live batch: status polling/backoff, progress, terminal states, coordinator-loss resubmission, and task-grid placeholder when real task details are absent.
- [ ] Implement Report: real report fields, metric confidence intervals and theory comparisons, verdict, timing, serial-match status, stale state, small-sample warning, and copy-as-JSON.
- [ ] Implement History: pagination, empty/error/loading states, correct Live/Report navigation, and rerun with the same parameters.
- [ ] Exercise all mock scenarios, including worker failure/retry, coordinator loss, busy, validation failure, small sample size, serial mismatch, and a fourth node.
- [ ] Verify keyboard navigation, visible focus, semantic controls, and responsive layout down to 360px.

**Gate:** `npm run typecheck`, `npm test`, and `npm run build` pass in `web/`; all screens and mock scenarios are navigable without a gateway or nodes.

## Phase 2: Native Go Gateway

- [ ] Create the independent `gateway/` Go module and implement settings plus a validated peers-file reader.
- [ ] Implement node HTTP clients with request timeouts, redirect refusal, response-size limits, and distinguishable downstream errors.
- [ ] Add fake-node helpers using `httptest` so gateway tests need no running nodes.
- [ ] Implement cluster aggregation, config endpoint, and liveness endpoint; test node failures, matrix disagreement, and four-node membership.
- [ ] Implement SQLite persistence, migrations, retention/pruning, and run history.
- [ ] Implement run submission and one bounded tracker per run; test completion, coordinator loss, 409 passthrough, restart recovery, and cancellation.
- [ ] Implement status/report proxying and stale snapshot fallback; cover all routes and unknown-run behavior.
- [ ] Add middleware for strict JSON, request-size limits, optional bearer auth, security headers, logging, recovery, and graceful shutdown.
- [ ] Specify and implement the frontend build-copy step into a directory inside `gateway/` before embedding; retain a committed placeholder so Go builds before the web bundle exists.
- [ ] Keep gateway peers hot reload distinct from node membership. A gateway config change alone must not be presented as changing the nodes' dispatch membership.
- [ ] Run `go vet ./...` and `go test ./...` in `gateway/`; attempt `go test -race ./...` only if the native toolchain supports it and record the result.

**Gate:** Native gateway tests pass without Docker, running nodes, or Python. The frontend works against fake nodes with mock mode disabled.

## Phase 3: Native Integration and Documentation

- [ ] Create/document a native peers config using URLs reachable from Windows; do not use Compose-only DNS names such as `node-1` from the native gateway.
- [ ] Document PowerShell commands to build and run the web app and gateway, and to point the gateway at the native peers/config/database paths.
- [ ] Verify one complete flow against fake nodes: cluster view, launch, live status, report, history, and stale fallback.
- [ ] Verify no files under `node/` or `sim/` changed.
- [ ] Complete `docs/assumptions.md` and record dependencies, native test results, and any unavailable race test.

**Gate:** The native definition of done in `gui-stage1-2-plan.md` is met and the documented workflow does not require Docker or WSL.

## Phase 4: Deferred Docker/WSL Integration

- [ ] After Docker/WSL is available, choose whether the gateway runs on the Windows host or in Compose. Document that choice before wiring addresses.
- [ ] If the gateway runs in Compose, use service DNS names for node URLs and bind/publish the gateway port intentionally; do not reuse host-loopback URLs inside the container.
- [ ] Mount the peers config and persistent SQLite directory at explicit container paths; verify permissions with the gateway's runtime user.
- [ ] Add the gateway service/build to Compose only in this phase; preserve the current node-only setup until then.
- [ ] Verify from the browser that the published gateway URL loads the embedded SPA and that the gateway can reach every node over the Compose network.
- [ ] Test membership updates end to end: update the peer list consistently for every node and restart/reconfigure nodes as required; gateway hot reload alone does not update node dispatch membership.
- [ ] Add a fourth node and confirm it is both visible in the UI and included in node dispatch after all nodes adopt the four-node peer list.

**Gate:** Compose/WSL integration works independently of the native test suite, and adding a node requires configuration changes only, not UI or gateway code changes.
