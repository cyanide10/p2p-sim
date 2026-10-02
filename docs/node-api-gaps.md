# Node API Gaps Affecting the GUI

The gateway and UI must work around these gaps without modifying `node/` or `sim/` in the current scope.

| Gap | UI or gateway impact | Current design response |
|---|---|---|
| No per-replication status endpoint. `/status` exposes aggregate counts only. | Cannot truthfully render each replication's state, assigned node, or retries in a live task grid. | Keep `tasks` optional in gateway types; render a node-API-support placeholder in real mode. Mock-only task details must never be presented as live data. |
| No retry-attempt history. The final report lists permanently failed tasks and attempt count, while `tasks_per_peer` counts completed results. | Cannot show a retry timeline or precise work distribution including attempts. | Use aggregate status and final-report fields only; label completed results per peer accurately. |
| No endpoint exposes the coordinator's resolved defaults/configuration. | Gateway cannot discover defaults from an arbitrary selected coordinator. | Configure gateway defaults from a shared node config file or explicit gateway settings; submit fully resolved parameters and persist the effective seed. Assume peer nodes use the same defaults/config unless an operator verifies otherwise. |
| Peer membership is static and loaded when each node starts. | Gateway peers-file hot reload can change the GUI's configured list but cannot update node dispatch membership. | Treat gateway membership and node membership separately. Reconfigure/restart every node for membership changes; verify all nodes use the same peer list before claiming a new node participates in runs. |
| Batch state is in coordinator memory; only up to 10 batches are retained. | Gateway outages or coordinator restarts can make live status/report unavailable, even when history remains. | Persist gateway snapshots and final reports; expose stale snapshots. On restart, resume tracking records still marked running. A 404 from the coordinator means it no longer knows that batch. |
| No cancellation endpoint. | Users cannot stop a run from the GUI. | Do not display a cancel action. Poll until terminal or coordinator loss. |
| No explicit execution-failed batch state. `/status` ends in `complete`; report verdict is `PASS`, `FAIL`, or `PENDING`, and task failures are counts/details. | Gateway must not equate statistical `FAIL` with a lost/aborted batch. | Map a node terminal `complete` to gateway `complete`; show the report verdict separately. Reserve `coordinator_lost` for lost coordinator state. |
| No idempotency key for `POST /run`. | A client retry after an ambiguous network failure could start another batch if the first request was accepted but its response was lost. | Preserve the returned batch identity when available; do not blindly retry a timed-out submission. Surface ambiguous submission outcomes for user resolution. |
| No auth or TLS on node endpoints. | The gateway does not make node APIs safe to expose publicly. | Keep nodes on a trusted network, bind gateway to loopback by default, and do not treat the optional gateway token as node-to-node authentication. |

## Recovery Semantics

Coordinator unreachability is not proof of permanent failure. The gateway may mark a run `coordinator_lost` only after a documented threshold of consecutive failures, or immediately when the node returns `404` for the batch. A later successful response should allow the gateway to refresh the record. Resubmission with the same seed is reproducible, but may duplicate work and affect timing measurements.
