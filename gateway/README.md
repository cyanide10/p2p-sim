# gateway

HTTP API for the web app. It forwards a run to the coordinating node the user picked, follows the run until the node's report is ready, and keeps every run's last status and final report in memory so the browser can read them back, even after the node has dropped the batch.

The gateway is not a coordinator. If it stops, the node pool keeps working; only the dashboard and its history (in memory, lost on restart) go away.

## Run it

From the repository root, because the default config paths are relative to it:

```bash
docker compose up --build                                        # node-1..3 on 127.0.0.1:8081..8083
(cd gateway && go build -o ../bin/gateway ./cmd/gateway) && bin/gateway
(cd web && npm run dev:gateway)                                  # UI on http://127.0.0.1:5173
```

Vite's gateway mode proxies `/api` and `/healthz` to `http://127.0.0.1:8090`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_LISTEN` | `127.0.0.1:8090` | Bind address. There is no auth; keep it on loopback. |
| `PEERS_CONFIG` | `config/peers.gateway.yaml` | Node ids and URLs reachable from where the gateway runs. Ids must match the nodes' `NODE_ID`s. |
| `NODE_CONFIG` | `config/node.yaml` | Only its `defaults` block is read, to fill fields a run request omits. |
| `NODE_REQUEST_TIMEOUT` | `5s` | Per call to a node. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

The peers file is read once at startup. It does not change which nodes the pool dispatches to; that is each node's own `peers.yaml`.

## API

Routes, run ids and error mapping are specified in [`docs/gateway-api.md`](../docs/gateway-api.md) and narrowed for this release in [`docs/superpowers/specs/2026-10-23-minimal-gateway-design.md`](../docs/superpowers/specs/2026-10-23-minimal-gateway-design.md).

## Tests

```bash
cd gateway && go vet ./... && go test -race ./...
```

Tests use in-process fake nodes (`internal/testnode`) and need no network, Docker or Python.
