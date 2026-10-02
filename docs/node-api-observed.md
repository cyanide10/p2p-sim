# Observed Node API

Observed from `node/internal/api`, `node/internal/batch`, `node/internal/dispatch`, `node/internal/stats`, `node/internal/task`, `node/internal/config`, and the checked-in config files. This records the implementation's JSON tags and behavior, not an independently versioned API guarantee.

## Common Behavior

- Node routes are `/health`, `/peers`, `/run`, `/status`, `/report`, and `/task`.
- JSON responses use `Content-Type: application/json`. Error responses are JSON.
- `/run` rejects unknown JSON fields and caps request bodies at 1 MiB. `/task` also has a 1 MiB cap.
- The node has no authentication or TLS. Its security model assumes trusted peers and limits exposure at the network/deployment layer.
- A node's peer membership is loaded at process startup. Nodes coordinate only batches they started themselves; batch state is in memory and at most 10 recent batches are retained.

## `GET /health`

Returns `200`:

```json
{"status":"ok","node_id":"node-1","peers":3}
```

`peers` is the configured peer count, not a live healthy-peer count.

## `GET /peers`

Returns `200` with an observer ID and one entry per configured peer:

```json
{
  "node_id": "node-1",
  "peers": [
    {"id":"node-1","url":"http://node-1:8000","self":true,"healthy":true},
    {"id":"node-2","url":"http://node-2:8000","self":false,"healthy":false,"error":"connection refused"}
  ]
}
```

Each peer entry includes `id`, `url`, `self`, and `healthy`; `error` is omitted on success and present on probe failure. The endpoint reports health as seen by the responding node. Its checks run concurrently and the endpoint itself returns `200` even when peers are unhealthy.

## `POST /run`

Request fields are optional; omitted fields use the coordinating node's configured defaults (or built-in defaults if no config file is loaded):

```json
{
  "replications": 100,
  "lambda": 0.8,
  "mu": 1.0,
  "sim_time": 10000,
  "warmup_time": 1000,
  "tolerance_pct": 10,
  "base_seed": 42,
  "serial_baseline": true
}
```

`202` response:

```json
{"batch_id":"batch-node-1-20261002T120000-abcdef","status":"started","coordinator":"node-1","replications":100,"base_seed":42,"peers":3}
```

The node resolves and returns the effective replication count and seed. Default seed is current Unix milliseconds. Seeds are generated as `base_seed + task_index`.

Errors:

- `400`: malformed JSON, unknown field, or validation failure; body is `{"error":"message"}`.
- `409`: this node is already coordinating an unfinished batch; body includes `error` and the existing `batch_id`.

Observed validation: replications 2..100,000; lambda and mu positive and finite; lambda must be less than mu; `sim_time` positive and greater than `warmup_time`; warmup time may be zero; tolerance positive and finite; base seed nonnegative and must leave room for every task seed in signed 64-bit range. Unstable queues are rejected, not merely warned about.

## `GET /status[?batch_id=...]`

Without `batch_id`, returns the most recently started batch on this coordinator. Unknown or missing batch returns `404` with `{"error":"message"}`.

The response contains:

- `batch_id`, `coordinator`
- `state`: `running` or `complete`
- `phase`: `distributed`, `serial_baseline`, or `complete`
- `replications`
- embedded task counts: `pending`, `assigned`, `complete`, `failed`, `failed_attempts`
- `elapsed_seconds`
- optional `serial_baseline` counts with the same count fields

`complete` means orchestration has ended; it does not mean every task succeeded or the statistical verdict passed.

## `GET /report[?batch_id=...]`

Without `batch_id`, returns the most recent batch report on this coordinator. Unknown or missing batch returns `404` with `{"error":"message"}`. Reports can be requested while a batch is running; values are provisional and verdict is `PENDING` until the distributed phase ends.

Top-level fields are `batch_id`, `coordinator`, `state`, `phase`, `verdict`, `verdict_detail`, `params`, `replications_requested`, `base_seed`, `seed_scheme`, `tolerance_pct`, `ci_method`, `tasks`, `tasks_per_peer`, `failed_tasks`, `theoretical`, `mean_wait_time`, `mean_queue_length`, `utilization`, and `timing`.

- `params` has `lambda`, `mu`, `sim_time`, and `warmup_time`.
- `tasks` has `pending`, `assigned`, `complete`, `failed`, and `failed_attempts`.
- `tasks_per_peer` maps peer ID to count of completed results attributed to that peer; it is not an attempt/retry history.
- `failed_tasks` entries have `task_id`, `seed`, `attempts`, and `error`.
- `theoretical` has `rho`, `L`, and `W`.
- Each metric comparison is null until at least two results exist; otherwise it includes `n`, `mean`, `stddev`, `ci95_low`, `ci95_high`, `ci95_half_width`, `theoretical`, `rel_error_pct`, `tolerance_pct`, `within_tolerance`, and `theoretical_in_ci`.
- `verdict` is `PENDING`, `PASS`, or `FAIL`. `FAIL` can mean the mean missed tolerance or too few completed results; it is not a distinct node execution state.
- `timing` includes `distributed_wall_clock_seconds`, `distributed_peers`, `sum_replication_runtime_seconds`, `serial_wall_clock_seconds`, and `speedup`. The serial fields can be null. `serial_results_match_distributed` is an optional field nested under `timing`; `serial_peer` and `serial_note` are optional.

The report's sample statistics use the normal-approximation 95% interval `mean +/- 1.96 * sample_stddev / sqrt(n)`. The report identifies it as valid for `n >= 30`; it does not suppress the interval for smaller samples.

## `POST /task`

Node-to-node request:

```json
{"task_id":"batch-0001","seed":42,"params":{"lambda":0.8,"mu":1.0,"sim_time":10000,"warmup_time":1000}}
```

Successful `200` response fields: `task_id`, `peer_id`, `seed`, `mean_wait_time`, `mean_queue_length`, `utilization`, `packets_served`, and `runtime_seconds`.

Errors: `400` for malformed/missing task ID or simulation failure; `503` when the node is at its concurrent-task limit. Error JSON has `task_id` and `error` (the task ID may be empty for malformed input).
