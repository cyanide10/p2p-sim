#!/usr/bin/env bash
# Starts a batch on any node of a running pool, follows its progress and
# prints the report. The node you send the request to coordinates the batch.
#
#   scripts/demo.sh [replications] [extra JSON fields]
#   scripts/demo.sh 100 '"serial_baseline": false'
#   NODE=http://localhost:8083 scripts/demo.sh      # let node-3 coordinate
set -euo pipefail

NODE="${NODE:-http://localhost:8081}"
REPS="${1:-100}"
EXTRA="${2:-}"
[[ -n "$EXTRA" ]] && EXTRA=", $EXTRA"

body="{\"replications\": $REPS, \"lambda\": 0.8, \"mu\": 1.0, \"sim_time\": 10000, \"warmup_time\": 1000, \"tolerance_pct\": 10$EXTRA}"

pretty() { if command -v jq >/dev/null; then jq "$@"; else cat; fi; }

echo "POST $NODE/run $body"
curl -fsS -X POST "$NODE/run" -H "Content-Type: application/json" -d "$body" | pretty .

while :; do
  status="$(curl -fsS "$NODE/status")"
  if command -v jq >/dev/null; then
    echo "$status" | jq -c '{phase, pending, assigned, complete, failed, failed_attempts, serial_baseline, elapsed_seconds}'
  else
    echo "$status" | tr -d '\n '; echo
  fi
  grep -q '"state": "complete"' <<<"$status" && break
  sleep 2
done

echo
echo "GET $NODE/report"
curl -fsS "$NODE/report" | pretty .
