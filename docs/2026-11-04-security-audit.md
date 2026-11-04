# Security Audit Report — 2026-11-04

Auditor: OpenCode (automated review + tooling)
Scope: full repository at commit `c0c8b7f` ("Add worker-backed Threat Lab campaigns with PDES execution")
Validation environment: Linux, Go 1.27.0/1.25.5 toolchains, Python 3.14.8, Node 26.12.1

---

## 1. Executive summary

**The project is in working condition and has an unusually strong security posture for a
research/simulation codebase.** All three components build cleanly, every test suite passes
(144 tests total), `go vet` is silent, and the production web build succeeds.

No critical or high-severity issues were found in the application code. The findings below are
concentrated in **dependency hygiene** (Go standard library patches in the build toolchain, a
vulnerable Vite dev-server version) and in a few **low-severity hardening gaps**, mostly
inherent to the project's "trusted static peer pool" threat model, which is deliberate and
documented.

| Area                  | Result                                            |
| --------------------- | ------------------------------------------------- |
| Working condition     | ✅ All builds & tests pass (see §3)                |
| Application code      | ✅ No exploitable issues found                     |
| Go dependencies       | ⚠️ Stdlib vulns reachable from built binaries (§5.1) |
| Python dependencies   | ✅ pip-audit: no known vulnerabilities             |
| JavaScript dependencies | ⚠️ Vite 8.3.2 — 6 known vulns, 1 high (§5.2)     |
| Docker / runtime config | ✅ Strong hardening (§4.4)                       |

---

## 2. System under review

Four cooperating components:

- **`node/` (Go):** the peer node — accepts `POST /run`, `POST /task`, network/PDES/attack
  endpoints, and SSE live streams; executes `sim/*.py` as subprocesses.
- **`gateway/` (Go):** public API + embedded GUI, run history in SQLite, proxies to nodes.
- **`sim/` (Python):** SimPy simulation scripts invoked as subprocesses.
- **`web/` (TypeScript/React):** the GUI, built with Vite and embedded into the gateway.

Trust model (per README and code comments): a **static, trusted peer list** (`config/peers.yaml`);
node-to-node traffic is unauthenticated by design; host ports default to **loopback binding**.

---

## 3. Working-condition verification

| Component | Check                                  | Result |
| --------- | -------------------------------------- | ------ |
| `node`    | `go build ./...`                       | ✅     |
| `node`    | `go test ./...` (12 packages)          | ✅ all pass |
| `node`    | `go vet ./...`                         | ✅ no findings |
| `gateway` | `go build ./...`                       | ✅     |
| `gateway` | `go test ./...` (7 packages)           | ✅ all pass |
| `gateway` | `go vet ./...`                         | ✅ no findings |
| `sim`     | `pytest` (Python 3.14, SimPy 4.1.1)    | ✅ **77 passed** |
| `web`     | `tsc --pretty` (typecheck)             | ✅     |
| `web`     | `vitest run` (9 files)                 | ✅ **67 passed** |
| `web`     | `vite build` (production bundle)       | ✅ built in ~130 ms |

Notes for reproducibility:

- A Go toolchain of **at least 1.27** is required for `gateway` (`go.mod` declares `go 1.27`).
  `node` builds with 1.22+ (its `go.mod` declares `go 1.22`).
- `web/node_modules` is not committed — run `npm ci` in `web/` first.

---

## 4. Application-code review findings

The manual review covered command invocation, HTTP surface, request parsing, subprocess
isolation, datastore access, config handling, and the frontend. Verified strengths first.

### 4.1 Verified security strengths

- **No command injection anywhere.** All subprocess invocations
  (`node/internal/sim/runner.go:55`, `node/internal/sim/network.go:57`,
  `node/internal/sim/stream.go:97`, `node/internal/pdes/worker.go:59`) use `os/exec` directly
  with **no shell**. Task parameters reach `simulate.py` only as formatted floats/integers
  (`Args()` in `runner.go`); network/attack scenarios are delivered on **stdin, never argv**.
- **Minimal subprocess environment.** `subprocessEnv()` (`runner.go:73-81`) forwards only
  `PATH`, `LANG`, `SIM_LOG_LEVEL` to children — node credentials cannot leak into simulations.
- **Tight request parsing.** Every endpoint uses `http.MaxBytesReader` (1 MiB default;
  4 MiB + metadata for PDES/attack plans) plus `DisallowUnknownFields`; the gateway also
  rejects trailing JSON data.
- **SSRF resistance.** Peers come solely from the validated `peers.yaml` (absolute http(s)
  URLs enforced in `gateway/internal/config/config.go:123-127`). Both outbound HTTP clients
  (`node/internal/dispatch/client.go:38`, `node/internal/pdes/http.go:222`) **refuse
  redirects** so a compromised peer cannot steer requests to arbitrary hosts. Run IDs are
  `url.PathEscape`-d before being placed in node URLs.
- **Response-size limits.** All inbound `io.ReadAll` calls are bounded
  (`maxResponseBytes` 1 MiB; partition replies capped at 64 MiB); subprocess stdout/error
  output is capped by `cappedBuffer` so a runaway script cannot exhaust memory.
- **SQL injection: none.** All `gateway/internal/store` queries use `?` placeholders;
  the DSN uses a fixed pragma set; the DB directory is created with `0o750` and the DB
  lives under caller-controlled `GATEWAY_DB` (server-local config, not client input).
- **Result-integrity checks.** Peers must echo correct `task_id`/`seed`
  (`dispatch/client.go:110-113`); the simulation's echoed seed is validated (`runner.go:154-156`).
- **Gateway middleware.** Constant-time (via `crypto/subtle`) bearer-token auth on `/api/*`,
  a strict CSP (`default-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, and `no-store` caching on API responses
  (`gateway/internal/server/server.go:36-37, 371-398`).
- **Path traversal: none.** The gateway static handler cleans paths and resolves strictly
  inside the embedded FS (`server.go:342-352`); the alternate `?vite-wasm-instance` style
  probe only affects Vite dev mode, not the embedded bundle.
- **Frontend input validation** mirrors the server-side rules (`web/src/lib/validation.ts`)
  and rejects non-finite, out-of-range, and unstable-queue values before submission; seeds
  are generated with `crypto.getRandomValues`. No `innerHTML`/`dangerouslySetInnerHTML`/
  `eval` usage exists in `web/src`.
- **Graceful node shutdown**, bounded concurrency (`MAX_CONCURRENT_TASKS`), per-subprocess
  timeouts (`SIM_TIMEOUT`, `PDEStepTimeout`), and idle-partition reaping (`pdes/host.go`).

### 4.2 Low-severity findings

| ID | Finding | Location | Impact | Recommendation |
|----|---------|----------|--------|----------------|
| L-1 | **No CSRF/Origin enforcement on state-changing `/api/*` endpoints.** `decodeJSON` does not require `Content-Type: application/json`, so a cross-origin form (`text/plain`) could submit a valid JSON body to `POST /api/runs` or `POST /api/pdes/plan`. The attacker cannot read responses (no CORS), so this is limited to triggering runs (minor survey/DoS impact). When `GATEWAY_TOKEN` is set, the token is not readily forgeable cross-origin, which mitigates this further. | `gateway/internal/server/server.go:449-467, 96-155` | Low | Reject non-JSON `Content-Type` on `POST /api/*`, and/or verify the `Origin`/`Sec-Fetch-Site` header for state-changing requests. |
| L-2 | **Node-to-node HTTP API is unauthenticated by design.** Any process able to reach a node port can spawn simulation work (`POST /task`, `/netrun`, `POST /partition/*/open`) or delete partition sessions. Docker-over-loopback defaults (`NODE_BIND:-127.0.0.1`) make this fine for the documented topology; the compose comments already warn about this. | `node/internal/api`, configuration in `docker-compose*.yml` | Low (given documented trust model) | If nodes are ever exposed beyond loopback, add a shared bearer token or mTLS between peers; keep the loopback default documented. |
| L-3 | **`GATEWAY_TOKEN` is optional and empty disables auth entirely.** Path check is prefix-based (`/healthz` and static assets stay open). This is intentional for the GUI's use, but the health and static endpoints are exempt by design. | `gateway/internal/server/server.go:371-385`, `gateway/internal/config/config.go:59` | Low | Document that non-loopback gateway deployments must set `GATEWAY_TOKEN`; fail fast (or warn loudly at startup) when binding to a non-loopback address with an empty token. |
| L-4 | **Unbounded per-run partition sessions.** A client may `POST /partition/{run}/open` many times with distinct run IDs until slots are exhausted (then `503`); idle sessions are reaped after 60 s. Scenario payloads are capped at 8 MiB per message, so memory exhaustion is bounded but still possible under sustained abuse from a trusted peer. | `node/internal/pdes/host.go, http.go` | Low | Consider a per-source cap on open partitions or a global cap; acceptable as-is within the trusted pool. |

### 4.3 Informational findings

- `web/.env.gateway` is committed (contains only `VITE_USE_MOCK=false` — not a secret), but
  `.gitignore` has no `.env*` rule; a future local `.env` containing a real `GATEWAY_TOKEN`
  could be committed by accident. **Recommend adding `.env*` (with `!.env.gateway`) to `.gitignore`.**
- `docker-compose.web.yml` passes `GATEWAY_TOKEN: "${GATEWAY_TOKEN:-}"` — safe empty default,
  but see L-3.
- `node/go.mod` declares `go 1.22` while the Dockerfile builds with `golang:1.27`; consider
  raising the module's `go` directive to match the exercised toolchain so local `go vet`/test
  runs reflect production behavior.
- Error messages returned to peers embed peer-supplied text (e.g. `runner.go:147`,
  `worker.go`'s limited stderr buffer). Size is capped (4 KiB) and goes only to the
  coordinating node — acceptable.

### 4.4 Docker / deployment hardening (positive)

`docker-compose.yml` applies a shared hardening block to every service: `read_only: true`,
`cap_drop: ALL`, `no-new-privileges:true`, an in-memory `/tmp`, `pids_limit: 128`, and
`mem_limit: 768m`. `node/Dockerfile` runs as UID 10001 with read-only code;
`gateway/Dockerfile` is a **distroless non-root** image (no shell). Host ports default to
`127.0.0.1` binding across all compose files. All config mounts are `:ro`. This is a model
configuration for this kind of workload.

---

## 5. Dependency / toolchain audit

### 5.1 Go standard library — ⚠️ patch the build toolchain

Both Dockerfiles build with `FROM golang:1.27`. A `govulncheck` binary-mode scan of freshly
built binaries (symbol-level analysis) reports **stdlib vulnerabilities reachable from
project code** with Go 1.27.0:

| Binary            | Reachable vulns | Notable issue classes                                                                                          |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `gateway-bin`     | **11**          | `net/http` (HTTP/2 HPACK encoder race GO-2026-6617, trailer memory exhaustion GO-2026-6603, connection desync GO-2026-6613/6610, Range-header DoS GO-2026-6609), `crypto/x509` / `crypto/tls`, `net/textproto` |
| `node-bin`        | **10**          | same `net/http` families plus `crypto/tls` handshake/resumption issues (GO-2026-4340 / GO-2026-4337 reported by source scan) |

All of these are **fixed in Go patch releases after 1.27.0** (e.g. the `net/http/internal/http2`
issues are fixed by `go1.27.2`). Additional vulns exist in imported packages and required
modules but are **not reachable** from project code.

**Remediation (high-value, low-effort):**

1. Bump the Dockerfile builder images from `golang:1.27` to the latest patched release
   (`golang:1.27-alpine`/`golang:1.27` floats, so a rebuild without pinning picks up fixes —
   but *verify* the digest after the vulndb changes, or pin to `>= 1.27.2`).
2. Add `govulncheck ./...` (source mode) to CI for both modules so new stdlib exposure fails
   the build.

Given the deployment posture (loopback + distroless + static linking), realistic exposure of a
non-HTTP-facing vuln here is low, but the HTTP/2 memory/CPU-exhaustion classes are relevant
because **the gateway is the browser-facing component** and both services serve HTTP.

### 5.2 npm (`web/`) — ⚠️ one high-severity Vite vulnerability

`npm audit` on the current `web/package-lock.json` (vite **8.3.2**):

- **High:** six Vite advisories —
  GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm
  (`launch-editor` command-execution / existence-check bypass, Windows-focused),
  GHSA-9jrq-w75r-8gcw (cross-origin script execution via custom middleware),
  GHSA-rq7h-c2jc-7f22 and GHSA-vfpm-58rq-9qcg (files outside `server.fs` served /
  first-bytes leak via `?vite-wasm-instance`).
- All affect the **dev server** surface (`npm run dev` / `dev:gateway`), not the production
  bundle that the gateway embeds. Nonetheless `vite.config.ts` binds the dev server to
  `127.0.0.1` only, which limits remote exploitation of the middleware/fs issues to local attack.

**Remediation:** `npm audit fix --force` will move Vite to **8.3.5** (outside the currently
declared `^8.3.2` range) — update `web/package.json` and re-run lock audit accordingly.

### 5.3 Go module dependencies — ✅

`node` requires only `gopkg.in/yaml.v3 v3.0.1`; `gateway` adds `modernc.org/sqlite v1.60.1` and
small indirect deps. `govulncheck` reports **0 reachable third-party vulnerabilities** in both
modules (a handful are unreachable; see `govulncheck -show verbose` output if action is wanted).

### 5.4 Python (`sim/`) — ✅

`pip-audit` verdict on the declared environment (simpy 4.1.1, pytest ≥ 8): **no known
vulnerabilities.** The venv also carries no extra services or bind mounts.

---

## 6. Consolidated remediation checklist

Priority order (effort vs. risk reduction):

1. **[High → fix]** Update Vite to ≥ 8.3.5 in `web/` (`npm audit fix --force`, commit lockfile).
2. **[High → fix]** Ensure both Go binaries are built with a **patched Go ≥ 1.27.2**; update the
   Dockerfile builder images and add `govulncheck` to CI.
3. **[Low → fix]** Enforce `Content-Type: application/json` (and/or Origin check) on
   state-changing gateway `/api/*` endpoints (L-1).
4. **[Low → do when needed]** If nodes/gateway will be reachable beyond localhost, require
   `GATEWAY_TOKEN` and add node-to-node auth — or document loudly (L-2/L-3).
5. **[Info → hygiene]** Add `.env*` (keep exception) to `.gitignore`; align `node/go.mod`
   `go 1.22` with the 1.27 toolchain.

## 7. Conclusion

The codebase treats attacker-controlled input conservatively everywhere it was sampled: no
shell, no SQL string-building, no dynamic file access, bounded bodies,
redirect-refusing outbound HTTP, loopback defaults, and container-level sandboxing. The main
real-world risks today are **stale toolchain patches** (5.1/5.2), both of which are quick to
remediate. After items 1–2 the project's security posture is appropriate to, and consistent
with, its documented trusted-peer threat model.
