# Assumptions and Decisions

Recorded while building the gateway and the Live/Report screens (2026-10-04).

## Dependencies

| Component | Dependency | Why |
|---|---|---|
| gateway | `gopkg.in/yaml.v3` v3.0.1 | Same YAML library and version as `node/`. |
| gateway | `modernc.org/sqlite` v1.60.1 | Pure-Go SQLite, so no C compiler is needed (Windows constraint in the plan). Its transitive modules are listed in `gateway/go.mod`. |
| web | none added | The report charts are hand-drawn SVG; no chart library. |

## Gateway behavior beyond the draft contract

- **Completed runs are served from storage.** Once a run is `complete` with a stored status and report, `/status` and `/report` return the stored copies with `stale: false` instead of asking the node. Nodes keep only 10 batches in memory, so asking would eventually 404 and wrongly look like a lost coordinator.
- **A lost coordinator can come back.** If a `coordinator_lost` run's coordinator answers `/status` again, the record returns to `running` and tracking resumes.
- **Lost detection.** Five consecutive failed polls (1 s apart) or a single node `404` mark a running batch `coordinator_lost`. Tunable with `LOST_AFTER_FAILURES` and `POLL_INTERVAL`.
- **No base seed is invented.** If the request omits `base_seed`, the node picks one and the gateway records the node's value. The GUI always sends one.
- **`features.task_grid` is false.** Nodes expose aggregate counts only (docs/node-api-gaps.md), so the Live screen shows a placeholder instead of a per-replication grid.
- **Methods.** An unsupported method on an API path returns 405. Unknown `GET /api/*` paths return 404 JSON.
- **List limits.** `GET /api/runs` defaults to 50 and clamps `limit` to 200.

## Live traffic view (2026-10-04)

- **Node and simulator changes were required.** The plan's rule of not touching `node/` or `sim/` could not hold, because only the nodes can stream simulation events. Existing behavior is unchanged: `simulate.py` gains a separate `--stream` mode, and the node gains `GET /stream`. Batch tasks, the one-line JSON contract and `POST /run` are untouched.
- **Server-Sent Events, not polling.** The plan listed SSE as a non-goal; live packets need push. SSE is one-directional, works through the Go servers, and the browser reads it with `fetch` so error messages from 400/503 responses are kept.
- **Overload is allowed when streaming.** Up to ρ = 1.5, so a growing queue can be shown. Duration (≤ 3600) and packet rate (λ × speed ≤ 200 per second) are bounded on the node.
- **Streams share simulation slots** with batch tasks (`max_concurrent_tasks`), so live viewing cannot overload a node.

## Network lab (2026-10-04)

- **Distribution by replication, not by partitioning the topology.** Chosen by the owner. Every node simulates the whole network with its own seeds; results are combined with confidence intervals. This reuses the dispatcher unchanged (retries, busy handling, coordinator-loss resubmission) and avoids synchronizing simulation time between nodes.
- **Queueing model.** Fixed-size packets; routers are FIFO single servers with exponential service and a finite buffer; each link direction transmits at `bandwidth` packets/s from its own finite buffer, then adds propagation delay. Routing is shortest path by latency, recomputed on failure and recovery; hosts never forward. Packets inside a failed element are dropped. There is no TCP-style congestion control.
- **The simulator is the single source of validation.** The node calls `netsim.py --validate` before dispatching or streaming, so the GUI's checks are a convenience only.
- **Colors.** Flows use the dataviz reference categorical palette (validated on this app's light and dark surfaces; light mode has three colors under 3:1 contrast, so every flow is also named in a table). Load uses a neutral ramp plus line width, and saturated links get a "⚠ %" label, so hue stays reserved for flows.
- **The mock API has no network simulator.** Network runs and live network views need the real nodes (the Docker stack).

## Open items

- **Browser token delivery.** `GATEWAY_TOKEN` protects `/api/*` for scripted clients, but the GUI has no way to send it yet. Leave it unset when using the GUI.
- **Race detector.** `go test -race ./...` passes on Linux. It needs CGO and a C compiler, so it may not run on the Windows machine in the original plan.
- **History screen.** Not built yet (M1.4). `GET /api/runs` already supports it.
