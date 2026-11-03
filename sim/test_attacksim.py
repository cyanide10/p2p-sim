import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest
import simpy

from attacksim import (
    Campaign,
    PartitionWorker,
    ScenarioError,
    merge_partition_states,
    partition_plan,
    run_replication,
    summarize,
    validate,
)

SCRIPT = Path(__file__).with_name("attacksim.py")

SCENARIO = {
    "kind": "ddos",
    "duration": 60,
    "step": 0.5,
    "seed": 2026,
    "scale": 48_000,
    "intensity": 5,
    "capacity": 40,
    "defense": 60,
    "phases": [
        {"id": "recon", "at": 0},
        {"id": "arming", "at": 0.1},
        {"id": "flood", "at": 0.2},
        {"id": "detect", "at": 0.58},
        {"id": "scrub", "at": 0.7},
        {"id": "recover", "at": 0.86},
    ],
    "nodes": [
        {"id": "dc", "index": 0, "role": "target", "units": 1},
        {"id": "api", "index": 1, "role": "service", "units": 1},
        {"id": "edge-na", "index": 2, "role": "edge", "units": 1},
        {"id": "ws-na", "index": 3, "role": "endpoint", "units": 8000},
        {"id": "bot-na", "index": 4, "role": "bot", "units": 2286},
    ],
}


def _partitioned_metrics(scenario, parts, seed):
    sc = validate(scenario)
    plan = partition_plan(sc, parts)
    workers = [PartitionWorker(scenario, plan, part, seed) for part in range(parts)]
    until = 0.0
    for _ in range(plan["windows"]):
        until = min(sc["duration"], until + plan["lookahead"])
        for worker in workers:
            assert worker.step(until, [])["outbound"] == []
    states = [worker.finish()["state"] for worker in workers]
    return merge_partition_states(scenario, states)


def _cli(args, scenario):
    return subprocess.run([sys.executable, str(SCRIPT), *args], input=json.dumps(scenario),
                          capture_output=True, text=True, timeout=120)


def test_validate_normalizes_defaults_and_sorts_nodes():
    scenario = copy.deepcopy(SCENARIO)
    scenario.pop("step")
    scenario["nodes"] = list(reversed(scenario["nodes"]))
    sc = validate(scenario)
    assert sc["step"] == 0.5
    assert [node["id"] for node in sc["nodes"]] == ["dc", "api", "edge-na", "ws-na", "bot-na"]
    assert sc["kind"] == "ddos"


@pytest.mark.parametrize("mutation, message", [
    (lambda s: s.update(kind="ransom"), "kind must be"),
    (lambda s: s.update(duration=0), "duration must be"),
    (lambda s: s.update(step=0), "step must be"),
    (lambda s: s.update(scale=0), "scale must be"),
    (lambda s: s.update(capacity=0), "capacity must be"),
    (lambda s: s.update(defense=101), "defense must be"),
    (lambda s: s.update(seed=-1), "seed must be"),
    (lambda s: s.update(nodes=[]), "nodes must be"),
    (lambda s: s["nodes"].append({"id": "dc", "index": 9, "role": "target", "units": 1}), "duplicate id"),
    (lambda s: s["nodes"].append({"id": "x", "index": 0, "role": "target", "units": 1}), "duplicate index"),
    (lambda s: s["nodes"][0].update(role="router"), "role must be"),
    (lambda s: s["phases"].append({"id": "back", "at": 0.05}), "sorted"),
])
def test_validate_rejects_invalid_scenarios(mutation, message):
    scenario = copy.deepcopy(SCENARIO)
    mutation(scenario)
    with pytest.raises(ScenarioError, match=message):
        validate(scenario)


def test_replication_is_deterministic_and_covers_the_grid():
    first = run_replication(SCENARIO, 7)["metrics"]
    second = run_replication(SCENARIO, 7)["metrics"]
    assert first == second
    assert first["samples"][0]["t"] == 0
    assert first["samples"][-1]["t"] == SCENARIO["duration"]
    assert len(first["samples"]) == SCENARIO["duration"] / SCENARIO["step"] + 1
    assert first["summary"]["peakThreat"] > 50
    # Every sample describes every topology token.
    assert all(set(sample["nodes"]) == {node["id"] for node in SCENARIO["nodes"]}
               for sample in first["samples"])


def test_campaign_every_node_role_reacts():
    ddos = run_replication({**SCENARIO, "defense": 0}, 1)["metrics"]
    peak = max(ddos["samples"], key=lambda sample: sample["threat"])
    assert peak["nodes"]["dc"]["load"] > 1
    assert peak["nodes"]["bot-na"]["compromise"] > 0
    worm = run_replication({**SCENARIO, "kind": "worm"}, 1)["metrics"]
    assert worm["samples"][-1]["nodes"]["ws-na"]["compromise"] > 0.5
    exfil = run_replication({**SCENARIO, "kind": "exfil"}, 1)["metrics"]
    assert exfil["summary"]["exfiltratedGb"] == pytest.approx(exfil["samples"][-1]["impact"])


def test_partition_plan_is_deterministic_balanced_and_complete():
    scenario = validate(SCENARIO)
    first = partition_plan(scenario, 2)
    assert first == partition_plan(scenario, 2)
    assert set(first["assignment"]) == {node["id"] for node in scenario["nodes"]}
    assert sum(first["load"]) == len(scenario["nodes"])
    assert first["lookahead"] == scenario["step"]
    assert first["windows"] == scenario["duration"] / scenario["step"]
    with pytest.raises(ScenarioError, match="exceeds"):
        partition_plan(scenario, 6)
    with pytest.raises(ScenarioError, match="positive"):
        partition_plan(scenario, 0)


def test_partitioned_workers_only_emit_owned_tokens_and_merge_exactly():
    scenario = validate(SCENARIO)
    plan = partition_plan(scenario, 2)
    worker = PartitionWorker(SCENARIO, plan, 0, 3)
    reply = worker.step(scenario["duration"], [])
    assert reply["outbound"] == []
    state = worker.finish()["state"]
    owned = {nid for nid, owner in plan["assignment"].items() if owner == 0}
    assert all(set(sample["nodes"]) == owned for sample in state["samples"])

    single = run_replication(SCENARIO, 3)["metrics"]
    for parts in (1, 2, 3, 5):
        assert _partitioned_metrics(SCENARIO, parts, 3) == single


def test_worker_rejects_inbound_records_and_bad_steps():
    plan = partition_plan(validate(SCENARIO), 1)
    worker = PartitionWorker(SCENARIO, plan, 0, 3)
    with pytest.raises(ScenarioError, match="exchange"):
        worker.step(1.0, [{"to": "dc"}])
    with pytest.raises(ScenarioError, match="greater than"):
        worker.step(0.0, [])
    with pytest.raises(ScenarioError, match="cannot finish"):
        worker.finish()
    worker.step(SCENARIO["duration"], [])
    worker.finish()
    with pytest.raises(ScenarioError, match="already finished"):
        worker.step(SCENARIO["duration"], [])


def test_merge_rejects_missing_or_repeated_tokens():
    plan = partition_plan(validate(SCENARIO), 2)
    workers = [PartitionWorker(SCENARIO, plan, part, 3) for part in range(2)]
    for worker in workers:
        worker.step(SCENARIO["duration"], [])
    states = [worker.finish()["state"] for worker in workers]
    with pytest.raises(ScenarioError, match="missing nodes"):
        merge_partition_states(SCENARIO, states[:1])
    with pytest.raises(ScenarioError, match="repeats node"):
        merge_partition_states(SCENARIO, [states[0], states[0]])


def test_cli_modes():
    ok = _cli(["--validate"], SCENARIO)
    assert ok.returncode == 0, ok.stderr
    summary = json.loads(ok.stdout)
    assert summary["ok"] is True and summary["nodes"] == 5
    assert summary["samples"] == SCENARIO["duration"] / SCENARIO["step"] + 1

    run = _cli(["--seed", "7"], SCENARIO)
    assert run.returncode == 0, run.stderr
    lines = run.stdout.splitlines()
    assert len(lines) == 1 and json.loads(lines[0])["seed"] == 7

    plan = _cli(["--plan", "--parts", "2"], SCENARIO)
    assert plan.returncode == 0, plan.stderr
    assert json.loads(plan.stdout)["load"] == [3, 2]

    bad = _cli(["--validate"], {"kind": "ddos"})
    assert bad.returncode == 1 and bad.stdout == "" and "invalid scenario" in bad.stderr


def test_partition_and_merge_cli_round_trip():
    plan = partition_plan(validate(SCENARIO), 2)
    states = []
    for part in range(2):
        requests = [
            {"op": "open", "scenario": SCENARIO, "plan": plan, "part": part, "seed": 4},
            {"op": "step", "until": SCENARIO["duration"], "inbound": []},
            {"op": "finish"},
        ]
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--partition"],
            input="".join(json.dumps(request) + "\n" for request in requests),
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        assert responses[0] == {"ok": True}
        assert responses[1]["outbound"] == []
        states.append(responses[2]["state"])
    merged = subprocess.run(
        [sys.executable, str(SCRIPT), "--merge"],
        input=json.dumps({"scenario": SCENARIO, "states": states}),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert merged.returncode == 0, merged.stderr
    assert json.loads(merged.stdout) == run_replication(SCENARIO, 4)["metrics"]


def test_summary_records_recovery_and_exfil():
    scenario = validate(SCENARIO)
    campaign = Campaign(scenario, simpy.Environment())
    campaign.finish()
    summary = summarize(scenario, campaign.samples)
    assert summary["peakThreat"] == max(sample["threat"] for sample in campaign.samples)
    assert summary["peakLoadRatio"] == max(sample["loadRatio"] for sample in campaign.samples)
    assert summary["recoverySeconds"] is None or summary["recoverySeconds"] >= 0
