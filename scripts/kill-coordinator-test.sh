#!/usr/bin/env bash
# Coordinator-loss check. There is no permanent coordinator: whichever node
# receives POST /run coordinates that batch. If that node dies, its batch is
# lost -- but seeds fully determine results, so resubmitting the same
# base_seed to any surviving node reproduces the batch exactly.
#
#   scripts/kill-coordinator-test.sh [replications]
set -euo pipefail

FIRST="${FIRST:-http://localhost:8081}"
FIRST_CONTAINER="${FIRST_CONTAINER:-node-1}"
SECOND="${SECOND:-http://localhost:8082}"
REPS="${1:-100}"
SEED="${SEED:-777}"
body="{\"replications\": $REPS, \"base_seed\": $SEED, \"serial_baseline\": false}"

field() { grep -o "\"$1\": *[^,}]*" | head -1 | sed 's/.*: *//; s/"//g'; }

curl -fsS -X POST "$FIRST/run" -H "Content-Type: application/json" -d "$body" >/dev/null
until [[ "$(curl -fsS "$FIRST/status" | field complete)" -ge $((REPS / 5)) ]]; do sleep 0.5; done
echo "stopping coordinator $FIRST_CONTAINER at: $(curl -fsS "$FIRST/status" | tr -d '\n ')"
docker stop -t 0 "$FIRST_CONTAINER" >/dev/null

echo "resubmitting base_seed=$SEED to $SECOND"
curl -fsS -X POST "$SECOND/run" -H "Content-Type: application/json" -d "$body" | tr -d '\n '; echo
until curl -fsS "$SECOND/status" | grep -q '"state": "complete"'; do sleep 1; done
report="$(curl -fsS "$SECOND/report")"

docker start "$FIRST_CONTAINER" >/dev/null
echo "restarted $FIRST_CONTAINER"

complete="$(echo "$report" | sed -n '/"tasks"/,/}/p' | field complete)"
failed="$(echo "$report" | sed -n '/"tasks"/,/}/p' | field failed)"
echo "coordinator=$(echo "$report" | field coordinator) complete=$complete failed=$failed verdict=$(echo "$report" | field verdict)"

if [[ "$complete" == "$REPS" && "$failed" == "0" ]]; then
  echo "OK: batch reproduced on a surviving node after the coordinator died"
else
  echo "FAIL: expected $REPS complete and 0 failed"
  exit 1
fi
