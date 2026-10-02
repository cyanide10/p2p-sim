# p2p-sim GUI roadmap

End-to-end roadmap for adding a dockerized web GUI to p2p-sim. This document covers the whole journey, from setting up a Windows machine to a hardened, containerized release. The detailed task list for Phases 2 and 3 lives in `gui-stage1-2-plan.md`; this file is the map around it.

Effort figures are rough estimates for one developer working with an AI coding agent. Treat them as relative sizes, not commitments.

---

## 1. Goal and guiding principles

**Goal:** a browser GUI to observe the cluster, launch batches on any node, watch them live, read statistical reports, keep history, and eventually demonstrate failure handling, all running in Docker next to the existing nodes.

**Principles (these should survive every design decision):**

1. **No permanent coordinator.** The GUI gateway is a convenience layer. If it dies, the cluster keeps running and nothing is lost except the dashboard.
2. **Nodes stay symmetric.** Don't add a "GUI node" or special roles to the pool.
3. **Membership comes from `peers.yaml`.** The GUI reads the same file as the nodes, so adding node-4 needs no code changes.
4. **Trusted-network security model.** No auth or TLS in the pool, loopback-bound by default. Every new component must not weaken this. Anything powerful (container control) is opt-in and isolated.
5. **Read before write.** Early phases only observe; changes to node code come later, are small, and are read-only endpoints.
6. **Everything testable without Docker, network or Python** until the packaging phase, matching the existing test philosophy.

---

## 2. Phase overview

| # | Phase | Needs Docker/WSL? | Touches `node/`? | Size |
|---|---|---|---|---|
| 0 | Windows environment setup | No | No | S |
| 1 | Discovery and API contract | No | No | S |
| 2 | Frontend with mock API (Stage 1) | No | No | L |
| 3 | Go gateway with fake nodes (Stage 2) | No | No | L |
| 4 | Native end-to-end with real nodes (optional) | No | No | M |
| 5 | Node API additions | No | **Yes** | M |
| 6 | WSL 2 and Docker setup | Installs it | No | S |
| 7 | Dockerize gateway, Compose integration | Yes | No | M |
| 8 | Failure lab (optional sidecar) | Yes | No | M |
| 9 | Hardening, docs, release | Yes | No | M |
| 10 | Stretch goals | Varies | Varies | Open |

```
0 ─► 1 ─► 2 ──┐
          └► 3 ─┴─► 4 ─► 5 ──┐
                              ├─► 7 ─► 8 ─► 9 ─► 10
                    6 ────────┘
```

- Phases 2 and 3 can run in parallel after the contract in Phase 1 is agreed.
- Phase 6 can happen any time before Phase 7, so install it while other work is in progress.
- Phase 5 is independent of 6; it only needs Go.

---

## Phase 0: Windows environment setup

**Goal:** native tooling to build and test everything up to packaging.

**Install:**
- Git for Windows. Run `git config --global core.autocrlf input` before cloning.
- Go 1.27 (check it matches `node/go.mod`).
- Node.js LTS.
- VS Code, with the Go and ESLint extensions.
- Optional: Python 3, only if you want real simulations in Phase 4.

**Conventions:**
- Use PowerShell. Use `curl.exe`, not `curl`.
- Add a `.gitattributes` (`* text=auto`, `*.sh text eol=lf`) so shell scripts and container files keep LF endings even though you aren't using WSL yet.
- Know your Windows edition (Settings → System → About). It decides the Docker route in Phase 6.

**Exit criteria:** `go version`, `node --version` and `git --version` work; `go test ./...` passes in `node/` (it needs no Python, Docker or network); the repo builds.

---

## Phase 1: Discovery and API contract

**Goal:** replace assumptions with facts, and agree on the contract everything else builds on.

**Tasks:**
- Read `node/internal/api`, `batch`, `peers`, `config` and the YAML under `config/`.
- Write `docs/node-api-observed.md`: the real JSON for `/run`, `/status`, `/report`, `/peers`, `/health`. Mark unknowns `UNVERIFIED`.
- Write `docs/node-api-gaps.md`: what the GUI wants that nodes lack (batch list, per-task detail, load info, event stream).
- Write `docs/gateway-api.md`: the browser-to-gateway contract (endpoints, errors, composite batch id, `stale` flag, run states).
- Decide framework (Preact or React) and chart library; record in a short decision log (`docs/decisions.md`).

**Exit criteria:** the contract is reviewed and agreed. Both the frontend and gateway can be built against it without further questions.

**Risks:** the README omits the `/status` and `/report` JSON. Mitigation: derive from code, isolate in one types file.

---

## Phase 2: Frontend with mock API (Stage 1)

**Goal:** a complete, navigable GUI running on mock data via `npm run dev`.

**Deliverables:** the Cluster, Launch, Live batch, Report and History screens; an `ApiClient` interface with mock and HTTP implementations; mock scenarios (happy path, worker death, coordinator death, 409, validation error, small n, serial mismatch, 4th node); validation logic with unit tests.

**Why mock first:** it is the largest part of the work, gives hot reload (faster than Docker), and forces UI states to be designed for failure cases before real failures happen.

**Exit criteria:** `typecheck`, `test` and `build` pass; every screen works in every scenario; responsive to 360px; keyboard and accessibility basics verified.

Details and acceptance criteria: `gui-stage1-2-plan.md`, section 3.

---

## Phase 3: Go gateway with fake nodes (Stage 2)

**Goal:** a gateway binary implementing the contract, tested natively.

**Deliverables:** the peers reader (hot-reloading), a node client (no redirects, size limits), cluster aggregation (who-sees-whom matrix), SQLite history (pure-Go driver), a background run tracker, middleware (limits, optional bearer token, security headers), embedded SPA serving, and a reusable fake-node test helper.

**Exit criteria:** `go vet` and `go test` pass with no network, Docker or Python; the frontend with mock off works against the gateway and fake nodes; a restart resumes tracking of running batches.

Details: `gui-stage1-2-plan.md`, section 4.

**Key design call:** the gateway caches the final report in its own store. Nodes keep only 10 batches in memory, so without this, history would disappear whenever a node restarted.

---

## Phase 4: Native end-to-end with real nodes (optional)

**Goal:** validate the GUI against genuine node behavior before investing in Docker.

**Tasks:**
- Build the node binary, create a Python venv, and run three nodes on different ports with a `localhost` peers file.
- Run the gateway pointing at them, run real batches, kill a node process by hand to see retry behavior in the Live screen.
- Compare real JSON to `node-api-observed.md`; fix any contract drift.

**Known caveat:** nodes launch Python with a stripped environment (`PATH`, `LANG`). On Windows, Python may need `SystemRoot` and could fail to start. Don't change `node/` for this in this phase; if it blocks you, skip to Phase 6 and use containers.

**Exit criteria:** one real batch completes in the GUI, or the Windows limitation is documented and deferred.

---

## Phase 5: Node API additions

**Goal:** close the gaps that block the best GUI features. These are the only changes to node code in this roadmap, and should be small, read-only, and consistent with the design ("seeds determine results", symmetric nodes).

**Candidates, in priority order:**

| Addition | Unlocks | Notes |
|---|---|---|
| Per-task detail in a batch endpoint (`task_id`, seed, executing node, attempts, status) | The task grid, per-replication distribution charts, a visible retry/reassignment story | Highest value; touches the batch state structure |
| `GET /batches` (list a node's held batches) | Rebuilding history after a gateway restart, discovering batches started by other tools | Cheap |
| Load info in `/health` or `/peers` (in-flight vs `max_concurrent_tasks`) | Busy indicators on the Cluster screen | Cheap; reuses the existing concurrency limiter |
| SSE stream of batch events | Replaces polling | Optional; only if polling feels laggy |

**Rules:** add tests alongside each change (`go test -race ./...` works in WSL/Docker if not natively), keep response shapes additive so older clients still work, and update `node-api-observed.md`. Then flip the frontend feature flags and gateway passthroughs.

**Exit criteria:** the task grid renders from real data; existing node tests still pass.

---

## Phase 6: WSL 2 and Docker setup

**Goal:** the machine can build and run the Compose stack.

**Tasks:**
- Install WSL 2 (`wsl --install`) and reboot; ensure BIOS virtualization is enabled.
- Install Docker Desktop with the WSL 2 backend and enable integration for your distro.
- Clone or move the repo **into the WSL filesystem** (e.g. `~/p2p-sim`), not `/mnt/c`, for speed and correct line endings.
- Cap resources via `%UserProfile%\.wslconfig` (for example 6 GB, 4 processors), then `wsl --shutdown`.
- Verify: `docker version`, `docker compose up --build` for the existing 3 nodes, `curl http://localhost:8082/health`, and run `scripts/demo.sh`.

**Exit criteria:** the original stack runs unchanged and the shipped bash scripts work.

---

## Phase 7: Dockerize the gateway and integrate with Compose

**Goal:** `docker compose up` brings up nodes plus the GUI.

**Tasks:**
- Multi-stage `gateway/Dockerfile`: a Node stage builds `web/dist`, a Go stage embeds it and builds a static binary, and the final stage is distroless or scratch.
- Mirror the nodes' hardening: non-root user, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem, `pids_limit`, `mem_limit`.
- Add a `ui` service to `docker-compose.yml`:
  - Publishes `127.0.0.1:8080` by default (configurable via a `UI_BIND` variable, mirroring `NODE_BIND`).
  - Mounts `config/peers.yaml` read-only (and `peers.4.yaml` in the node4 override).
  - Mounts a named volume for the SQLite database (needed because the root filesystem is read-only).
  - `depends_on` the nodes with a health check on `/healthz`.
- Verify peers URLs resolve via Docker DNS (`node-1:8000`). Add a gateway config note for the non-Docker `localhost` case.
- Test the scaling scenario: `docker-compose.node4.yml` makes node-4 appear on the Cluster screen automatically.

**Exit criteria:** from a cold start, a user opens `http://localhost:8080`, launches a batch on node-2, and sees the report; history survives `docker compose restart ui`.

---

## Phase 8: Failure lab (optional)

**Goal:** replace the two shell scripts with a visual demonstration of failure handling.

**Scenarios:**
1. **Worker death:** kill a worker mid-batch. The Live screen shows the task reassigned, and the batch still completes.
2. **Coordinator death:** kill the coordinating node. The batch goes to `coordinator_lost`. "Resubmit same `base_seed` elsewhere" runs it again, and a comparison view shows the results are bit-identical, proving the reproducibility claim.

**Design (security-critical):**
- Container control requires the Docker socket, which is effectively host root. **Never mount `docker.sock` into the web-facing gateway.**
- Use a separate sidecar service behind a Compose `profile` (off by default), with a restricted socket proxy allowing only stop/start/restart on containers carrying a specific label.
- The gateway talks to the sidecar over an internal network. The sidecar is not published to the host.
- Require explicit opt-in (`docker compose --profile lab up`) and show a visible "lab mode" banner in the UI.
- The UI hides the lab entirely when the sidecar is not present.

**Exit criteria:** both scenarios run from the UI; with the profile off, nothing in the default stack can control containers.

---

## Phase 9: Hardening, documentation, release

**Security checklist:**
- Loopback bind by default; token auth available and tested when binding to a LAN.
- No secrets in images or logs; dependency versions pinned (note the existing "pinned by tag, not digest" limitation, and consider pinning the base images by digest for the new image).
- Strict CSP; no external scripts or fonts loaded at runtime.
- Dependency scan on `go.mod` and `package-lock.json`.
- Review that the gateway never follows redirects and never forwards arbitrary URLs: it can only reach nodes listed in `peers.yaml`.

**Quality:**
- CI-style script running `go vet`, `go test -race`, `npm run typecheck`, `npm test`, `npm run build`, and an image build.
- A smoke test in Compose: start the stack, hit `/healthz` and `/api/cluster`, run a small batch through the gateway.

**Docs:**
- Update `README.md`: a GUI section, the new Compose service and variables, security notes (the gateway is a new entry point), and the layout tree.
- A short user guide with screenshots.
- A short architecture note on why the gateway is separate from the nodes.

**Exit criteria:** a fresh clone, `docker compose up --build`, and the guide works end to end.

---

## Phase 10: Stretch goals

Pick based on interest, in no particular order:

- Server-sent events replacing polling (if not done in Phase 5).
- Run comparison and trend views across history (for example how speedup changes with node count).
- Parameter sweeps: queue several batches over a λ grid and plot the results against theory.
- Export reports (JSON, CSV).
- Visualize leader-election-based failover, if the PRD stretch goal of automatic coordinator failover is ever built.
- Multi-user mode with real authentication, if the GUI ever leaves a trusted network.

---

## 3. Testing strategy

| Layer | Tool | Runs where | Phases |
|---|---|---|---|
| Frontend pure logic (validation, stats, formatting) | Vitest | Native | 2 |
| Frontend flows against mock scenarios | Manual plus optional component tests | Native | 2 |
| Gateway units (peers, client, store, aggregate, runs) | `go test` with `httptest` fake nodes | Native | 3 |
| Gateway-to-frontend integration | Dev proxy, mock off | Native | 3 |
| Real nodes end to end | Manual | Native or Docker | 4, 7 |
| Node additions | Existing Go test suite plus new tests | Native or WSL | 5 |
| Container integration | Compose smoke test | Docker | 7, 9 |
| Failure handling | Failure lab and the shipped scripts | Docker | 8 |

`-race` requires CGO and a C compiler, so on native Windows it may be unavailable. Run it in WSL or in a container build step instead.

---

## 4. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Real JSON shapes differ from assumptions | High | Medium | Phase 1 discovery; types isolated in one file; Phase 4 validation |
| Windows can't run nodes natively (Python env) | Medium | Low | Phase 4 is optional; use containers in Phase 6 and 7 |
| Task grid blocked by missing node API | High | Medium | Feature flag; Phase 5 adds the endpoint |
| Gateway becomes an unauthenticated control plane | Medium | High | Loopback by default; token auth; documented in the README |
| Docker socket exposure in the failure lab | Medium | **Very high** | Separate sidecar, profile-gated, label-restricted socket proxy, never in the gateway |
| History lost because nodes restart | High | Medium | Gateway stores final reports in SQLite on a volume |
| Batch ID collisions across coordinators | Medium | Medium | Composite `{coordinator}:{batch_id}` keys |
| Scope creep into node internals | Medium | Medium | Phase 5 is the only node-touching phase, limited to read-only additions |
| WSL line-ending or `/mnt/c` performance issues | Medium | Low | Work inside the WSL filesystem; `.gitattributes` |
| Docker Desktop memory pressure | Medium | Low | `.wslconfig` caps; container `mem_limit` |

---

## 5. Decision log (to maintain in `docs/decisions.md`)

| Decision | Choice | Reason |
|---|---|---|
| Where the GUI lives | Separate gateway container | Keeps nodes symmetric and small; no CORS; one published port |
| Gateway language | Go | Reuses peers and config knowledge; static binary; embeds the SPA |
| Frontend | Vite + TypeScript + Preact or React | Fast dev loop; small bundle |
| Live updates | Polling at 500 ms | No node push channel exists |
| History store | SQLite via a pure-Go driver | No CGO on Windows; works on a read-only root with a volume |
| Batch identity | Composite key | IDs are only unique per coordinator |
| Container control | Isolated optional sidecar | Avoids socket exposure |
| Node changes | Read-only, additive, Phase 5 only | Protects the existing, tested core |

---

## 6. Rough sequencing and checkpoints

Suggested order of work, with a review checkpoint after each:

1. **Setup and contract** (Phases 0 and 1). Checkpoint: the contract is agreed.
2. **Parallel build** (Phases 2 and 3). Checkpoint: the GUI runs against the gateway with fake nodes.
3. **Reality check** (Phase 4, plus Phase 6 installing in the background). Checkpoint: contract drift fixed.
4. **Node additions** (Phase 5). Checkpoint: the task grid is live.
5. **Packaging** (Phase 7). Checkpoint: the full stack from a cold `docker compose up`.
6. **Failure lab and hardening** (Phases 8 and 9). Checkpoint: the release candidate.
7. **Stretch** (Phase 10) as desired.

A minimal valuable stopping point exists after Phase 3: a working GUI over the current node API, minus the task grid. Every later phase adds value without invalidating earlier work.

---

## 7. Definition of done for the whole project

- `docker compose up --build` starts nodes and GUI; the GUI is reachable on loopback only by default.
- Launching a batch on any node, watching it live, and reading the report all work; adding node-4 requires no code changes.
- History persists across restarts of both the gateway and the nodes.
- Worker and coordinator failure scenarios are demonstrable (via the lab or the existing scripts), and the resubmit-same-seed comparison shows identical results.
- All test suites pass; the security checklist is complete; the README documents the GUI, its configuration and its security posture.
- The pool still works fully with the gateway stopped.
