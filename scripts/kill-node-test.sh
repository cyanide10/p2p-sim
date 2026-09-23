#!/usr/bin/env bash
# Worker-loss check: stops a (non-coordinating) node mid-batch and verifies the
# batch still completes with every task done -- the stopped node's in-flight
# task is reassigned to the remaining nodes.
#
#   scripts/kill-node-test.sh [victim-container] [replications]
#   NODE=http://localhost:8083 scripts/kill-node-test.sh node-1   # node-3 coordinates
set -euo pipefail

NODE="${NODE:-http://localhost:8081}"
VICTIM="${1:-node-2}"
REPS="${2:-100}"

field() { grep -o "\"$1\": *[^,}]*" | head -1 | sed 's/.*: *//; s/"//g'; }

coordinator="$(curl -fsS -X POST "$NODE/run" -H "Content-Type: application/json" \
  -d "{\"replications\": $REPS, \"serial_baseline\": false}" | field coordinator)"
if [[ "$coordinator" == "$VICTIM" ]]; then
  echo "refusing: $VICTIM is coordinating this batch; use scripts/kill-coordinator-test.sh" >&2
  exit 2
fi

# Wait until the batch is well under way, then stop the victim.
until [[ "$(curl -fsS "$NODE/status" | field complete)" -ge $((REPS / 5)) ]]; do sleep 0.5; done
echo "stopping $VICTIM (coordinator: $coordinator) at: $(curl -fsS "$NODE/status" | tr -d '\n ')"
docker stop -t 0 "$VICTIM" >/dev/null

until curl -fsS "$NODE/status" | grep -q '"state": "complete"'; do sleep 1; done
report="$(curl -fsS "$NODE/report")"

docker start "$VICTIM" >/dev/null
echo "restarted $VICTIM"

complete="$(echo "$report" | sed -n '/"tasks"/,/}/p' | field complete)"
failed="$(echo "$report" | sed -n '/"tasks"/,/}/p' | field failed)"
retried="$(echo "$report" | field failed_attempts)"
echo "complete=$complete failed=$failed failed_attempts=$retried verdict=$(echo "$report" | field verdict)"
echo "tasks_per_peer: $(echo "$report" | sed -n '/"tasks_per_peer"/,/}/p' | tr -d '\n ')"

if [[ "$complete" == "$REPS" && "$failed" == "0" ]]; then
  echo "OK: batch completed despite $VICTIM being stopped"
else
  echo "FAIL: expected $REPS complete and 0 failed"
  exit 1
fi
