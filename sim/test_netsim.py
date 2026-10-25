import copy
import hashlib
import json
import math
import random
import subprocess
import sys
from pathlib import Path

import pytest
import simpy

from netsim import (
    ArrivalRecord,
    Network,
    PartitionWorker,
    ScenarioError,
    _entity_rng,
    compute_routes,
    merge_partition_states,
    partition_plan,
    path_of,
    run_replication,
    stream_replication,
    validate,
)

SCRIPT = Path(__file__).with_name("netsim.py")


def _partitioned_metrics(scenario, parts, seed):
    sc = validate(scenario, partitioned=True)
    plan = partition_plan(sc, parts)
    workers = [PartitionWorker(scenario, plan, part, seed) for part in range(parts)]
    inbound = [[] for _ in range(parts)]
    until = 0.0
    for _ in range(plan["windows"]):
        until = min(sc["duration"], until + plan["lookahead"])
        next_inbound = [[] for _ in range(parts)]
        replies = [worker.step(until, inbound[part]) for part, worker in enumerate(workers)]
        for reply in replies:
            for record in reply["outbound"]:
                next_inbound[plan["assignment"][record["to"]]].append(record)
        inbound = next_inbound
    states = [worker.finish()["state"] for worker in workers]
    return merge_partition_states(scenario, states)


LINE = {
    "duration": 200,
    "nodes": [
        {"id": "h1", "kind": "host"}, {"id": "h2", "kind": "host"},
        {"id": "r1", "kind": "router", "service_rate": 50, "buffer": 1000},
    ],
    "links": [
        {"id": "a", "a": "h1", "b": "r1", "bandwidth": 1000, "delay": 0},
        {"id": "b", "a": "r1", "b": "h2", "bandwidth": 1000, "delay": 0},
    ],
    "flows": [{"id": "f", "src": "h1", "dst": "h2", "rate": 25}],
}

DIAMOND = {
    "duration": 100,
    "nodes": [
        {"id": "h1", "kind": "host"}, {"id": "h2", "kind": "host"},
        {"id": "r1", "kind": "router"}, {"id": "r2", "kind": "router"},
        {"id": "r3", "kind": "router"}, {"id": "r4", "kind": "router"},
    ],
    "links": [
        {"id": "e1", "a": "h1", "b": "r1"}, {"id": "e2", "a": "r4", "b": "h2"},
        {"id": "fast1", "a": "r1", "b": "r2", "delay": 0.001}, {"id": "fast2", "a": "r2", "b": "r4", "delay": 0.001},
        {"id": "slow1", "a": "r1", "b": "r3", "delay": 0.05}, {"id": "slow2", "a": "r3", "b": "r4", "delay": 0.05},
    ],
    "flows": [{"id": "f", "src": "h1", "dst": "h2", "rate": 20}],
    "events": [{"t": 40, "target": "fast1", "action": "down"}, {"t": 70, "target": "fast1", "action": "up"}],
}


def test_router_queue_matches_mm1():
    # Links are 20x faster than the router, so the router dominates: ~M/M/1 with rho = 0.5.
    flows = [run_replication(LINE, seed)["metrics"]["flows"]["f"] for seed in range(8)]
    delay = sum(f["mean_delay"] for f in flows) / len(flows)
    assert delay == pytest.approx(1 / (50 - 25) + 2 / 1000, rel=0.15)
    assert all(f["dropped"] == 0 for f in flows)


def test_same_seed_is_deterministic():
    a, b = run_replication(DIAMOND, 3), run_replication(DIAMOND, 3)
    assert a["metrics"] == b["metrics"]
    assert run_replication(DIAMOND, 4)["metrics"] != a["metrics"]


def test_link_traversal_returns_receiver_arrival_record():
    scenario = validate(LINE)
    env = simpy.Environment()
    network = Network(scenario, 3, env)
    process = env.process(network._traverse_link(
        pkt=1, seq=7, born=0.0, flow=scenario["flows"]["f"], source="h1",
    ))
    env.run()

    arrival = process.value
    assert isinstance(arrival, ArrivalRecord)
    assert arrival.flow == "f"
    assert arrival.seq == 7
    assert arrival.born == 0.0
    assert arrival.link == "a"
    assert arrival.source == "h1" and arrival.target == "r1"
    assert arrival.start == 0.0
    assert arrival.arrive == pytest.approx(0.001)
    assert arrival.as_dict() == {
        "flow": "f", "seq": 7, "born": 0.0, "link": "a",
        "from": "h1", "to": "r1", "start": 0.0, "arrive": pytest.approx(0.001),
    }
    assert arrival.order_key() == (arrival.arrive, "a", "f", 7)


def test_single_partition_worker_matches_replication_metrics():
    plan = partition_plan(validate(DIAMOND, partitioned=True), 1)
    worker = PartitionWorker(DIAMOND, plan, 0, 42)
    worker.step(DIAMOND["duration"], [])
    assert worker.finish()["metrics"] == run_replication(DIAMOND, 42)["metrics"]


@pytest.mark.parametrize("parts", [2, 3, 4])
def test_partitioned_metrics_match_single_process_with_failures(parts):
    scenario = copy.deepcopy(DIAMOND)
    scenario["duration"] = 80
    for link in scenario["links"]:
        link.update(bandwidth=10, delay=0.2)
    baseline = run_replication(scenario, 11)["metrics"]
    partitioned = _partitioned_metrics(scenario, parts, 11)
    assert partitioned == baseline


def test_partition_worker_emits_cross_partition_records():
    sc = copy.deepcopy(DIAMOND)
    sc["duration"] = 2
    sc["events"] = []
    plan = partition_plan(validate(sc, partitioned=True), 2)
    worker = PartitionWorker(sc, plan, 0, 21)
    emitted = []
    while worker.env.now < sc["duration"] and not emitted:
        result = worker.step(min(sc["duration"], worker.env.now + plan["lookahead"]), [])
        emitted.extend(result["outbound"])
    assert emitted
    record = emitted[0]
    assert record["from"] in plan["assignment"]
    assert record["to"] in plan["assignment"]
    assert plan["assignment"][record["from"]] == 0
    assert plan["assignment"][record["to"]] != 0
    assert record["arrive"] >= record["start"] + plan["lookahead"] - 1e-12


def test_partition_worker_rejects_inbound_arrival_in_the_past():
    plan = partition_plan(validate(DIAMOND, partitioned=True), 1)
    worker = PartitionWorker(DIAMOND, plan, 0, 2)
    worker.step(1.0, [])
    record = {
        "flow": "f", "seq": 1, "born": 0.0, "link": "e1", "from": "h1", "to": "r1",
        "start": 0.0, "arrive": 0.02,
    }
    with pytest.raises(ScenarioError, match="past"):
        worker.step(2.0, [record])


def test_entity_random_streams_follow_the_seed_kind_and_id():
    seed, kind, entity_id = 17, "flow", "f"
    stream_seed = int.from_bytes(hashlib.sha256(f"{seed}:{kind}:{entity_id}".encode()).digest()[:8], "big")
    expected = random.Random(stream_seed)
    actual = _entity_rng(seed, kind, entity_id)
    assert [actual.random() for _ in range(3)] == [expected.random() for _ in range(3)]

    assert _entity_rng(seed, "flow", entity_id).random() != _entity_rng(seed, "router", "r1").random()
    assert _entity_rng(seed, "flow", entity_id).random() != _entity_rng(seed, "flow", "other").random()
    assert _entity_rng(seed, kind, entity_id).random() == random.Random(stream_seed).random()


def test_shortest_path_and_reroute_on_failure():
    sc = validate(DIAMOND)
    assert path_of(sc, compute_routes(sc, set()), "h1", "h2") == ["h1", "r1", "r2", "r4", "h2"]
    assert path_of(sc, compute_routes(sc, {"fast1"}), "h1", "h2") == ["h1", "r1", "r3", "r4", "h2"]
    assert path_of(sc, compute_routes(sc, {"fast1", "slow1"}), "h1", "h2") == []


def test_partition_plan_is_deterministic_balanced_and_uses_minimum_cut_latency():
    sc = validate(DIAMOND)
    plan = partition_plan(sc, 2)
    assert plan == partition_plan(sc, 2)
    assert plan["load"] == [2, 2]
    assert plan["assignment"]["h1"] == plan["assignment"]["r1"]
    assert plan["assignment"]["h2"] == plan["assignment"]["r4"]
    assert plan["cut_links"]
    assert plan["lookahead"] == min(
        1 / sc["links"][lid]["bandwidth"] + sc["links"][lid]["delay"]
        for lid in plan["cut_links"]
    )
    assert plan["windows"] == math.ceil(sc["duration"] / plan["lookahead"])


def test_partition_plan_rejects_invalid_part_counts_and_too_many_windows():
    with pytest.raises(ScenarioError, match="positive integer"):
        partition_plan(validate(DIAMOND), 0)
    with pytest.raises(ScenarioError, match="router count"):
        partition_plan(validate(DIAMOND), 5)

    scenario = copy.deepcopy(DIAMOND)
    scenario["duration"] = 3600
    for link in scenario["links"]:
        link.update(bandwidth=1_000_000, delay=0)
    with pytest.raises(ScenarioError, match="200000 windows"):
        partition_plan(validate(scenario), 2)


def test_failure_shifts_traffic_and_recovers():
    m = run_replication(DIAMOND, 1)["metrics"]
    assert m["links"]["slow1"]["packets"] > 0, "traffic moved to the backup path while fast1 was down"
    assert m["links"]["fast1"]["packets"] > m["links"]["slow1"]["packets"]
    f = m["flows"]["f"]
    assert f["delivered"] + f["dropped"] <= f["sent"]
    assert m["totals"]["sent"] == f["sent"]


def test_hosts_do_not_forward():
    sc = copy.deepcopy(LINE)
    sc["nodes"].append({"id": "h3", "kind": "host"})
    sc["links"] = [{"id": "a", "a": "h1", "b": "h3"}, {"id": "b", "a": "h3", "b": "h2"}]
    m = run_replication(sc, 1)["metrics"]["flows"]["f"]
    assert m["delivered"] == 0 and m["dropped"] == m["sent"] > 0


def test_finite_buffer_drops_under_overload():
    sc = copy.deepcopy(LINE)
    sc["nodes"][2].update(service_rate=10, buffer=5)
    f = run_replication(sc, 2)["metrics"]["flows"]["f"]
    assert f["loss_rate"] > 0.4


def test_schedule_and_onoff_shape_traffic():
    sc = copy.deepcopy(LINE)
    sc["flows"] = [
        {"id": "s", "src": "h1", "dst": "h2", "pattern": {"type": "schedule", "points": [{"t": 0, "rate": 2}, {"t": 100, "rate": 20}]}},
        {"id": "o", "src": "h2", "dst": "h1", "rate": 10, "pattern": {"type": "onoff", "on_mean": 1, "off_mean": 3}},
    ]
    m = run_replication(sc, 5)["metrics"]
    series = m["series"]["flows"]["s"]
    assert sum(series[25:]) > 5 * sum(series[:15]), "rate rises after t = 100"
    assert m["flows"]["o"]["sent"] == pytest.approx(10 * 200 * 0.25, rel=0.35), "on a quarter of the time"


@pytest.mark.parametrize("mutate, message", [
    (lambda s: s["links"].append({"id": "x", "a": "h1", "b": "nope"}), "existing nodes"),
    (lambda s: s["flows"].append({"id": "g", "src": "h1", "dst": "r1", "rate": 1}), "not a host"),
    (lambda s: s["nodes"].append({"id": "h1", "kind": "host"}), "duplicate"),
    (lambda s: s.update(duration=0), "duration"),
    (lambda s: s["flows"][0].update(rate=10_000), "too much traffic"),
    (lambda s: s.update(events=[{"t": 1, "target": "h1", "action": "down"}]), "link or router"),
    (lambda s: s.update(flows=[]), "at least one flow"),
])
def test_validation_errors(mutate, message):
    sc = copy.deepcopy(LINE)
    mutate(sc)
    with pytest.raises(ScenarioError, match=message):
        validate(sc)


def test_stream_events_are_consistent():
    events = []
    stream_replication(DIAMOND, 9, speed=1.0, emit=events.append, realtime=False)
    assert events[0]["type"] == "meta" and events[0]["routes"]["f"][0] == "h1"
    assert events[-1]["type"] == "done"
    kinds = {e["type"] for e in events}
    assert {"send", "hop", "deliver", "stats", "failure"} <= kinds
    sent = sum(e["type"] == "send" for e in events)
    assert sent == events[-1]["metrics"]["flows"]["f"]["sent"]
    failures = [e for e in events if e["type"] == "failure"]
    assert failures[0]["routes"]["f"] == ["h1", "r1", "r3", "r4", "h2"]


def test_stream_rejects_too_fast_playback():
    with pytest.raises(ScenarioError, match="lower the speed"):
        stream_replication(DIAMOND, 1, speed=100.0, emit=lambda e: None, realtime=False)


def _cli(args, scenario):
    return subprocess.run([sys.executable, str(SCRIPT), *args], input=json.dumps(scenario),
                          capture_output=True, text=True, timeout=60)


def test_cli_modes():
    ok = _cli(["--validate"], LINE)
    assert ok.returncode == 0 and json.loads(ok.stdout)["ok"] is True
    run = _cli(["--seed", "4"], LINE)
    assert run.returncode == 0, run.stderr
    lines = run.stdout.splitlines()
    assert len(lines) == 1 and json.loads(lines[0])["seed"] == 4
    plan = _cli(["--plan", "--parts", "1"], DIAMOND)
    assert plan.returncode == 0, plan.stderr
    assert json.loads(plan.stdout)["load"] == [4]
    bad = _cli(["--validate"], {"duration": 1})
    assert bad.returncode == 1 and bad.stdout == "" and "invalid scenario" in bad.stderr


def test_partition_cli_json_lines_protocol():
    plan = partition_plan(validate(DIAMOND, partitioned=True), 1)
    requests = [
        {"op": "open", "scenario": DIAMOND, "plan": plan, "part": 0, "seed": 4},
        {"op": "step", "until": DIAMOND["duration"], "inbound": []},
        {"op": "finish"},
    ]
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--partition"],
        input="".join(json.dumps(request) + "\n" for request in requests),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    responses = [json.loads(line) for line in result.stdout.splitlines()]
    assert responses[0] == {"ok": True}
    assert responses[1]["outbound"] == []
    assert responses[2]["metrics"] == run_replication(DIAMOND, 4)["metrics"]
    merge_worker = PartitionWorker(DIAMOND, plan, 0, 4)
    merge_worker.step(DIAMOND["duration"], [])
    merge_request = {"scenario": DIAMOND, "states": [merge_worker.finish()["state"]]}
    merged = subprocess.run(
        [sys.executable, str(SCRIPT), "--merge"],
        input=json.dumps(merge_request),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert merged.returncode == 0, merged.stderr
    assert json.loads(merged.stdout) == run_replication(DIAMOND, 4)["metrics"]


def test_stream_matches_the_batch_replication_for_the_same_seed():
    events = []
    stream_replication(DIAMOND, 21, speed=1.0, emit=events.append, realtime=False)
    assert events[-1]["metrics"] == run_replication(DIAMOND, 21)["metrics"]


def test_stream_can_start_mid_run():
    full, late = [], []
    stream_replication(DIAMOND, 8, speed=1.0, emit=full.append, realtime=False)
    stream_replication(DIAMOND, 8, speed=1.0, emit=late.append, realtime=False, start=50.0)
    assert late[0]["type"] == "meta" and late[0]["start"] == 50.0
    seek = late[1]
    assert seek["type"] == "seek" and seek["t"] == 50.0
    assert seek["down"] == ["fast1"], "fast1 failed at t=40 and is still down at t=50"
    assert seek["routes"]["f"] == ["h1", "r1", "r3", "r4", "h2"]
    assert all(e.get("t", 50.0) >= 50.0 for e in late[2:])
    # The same packets as the full run from t = 50 on.
    tail = [e for e in full if e["type"] in ("hop", "deliver", "drop") and e["t"] >= 50.0]
    assert [e for e in late if e["type"] in ("hop", "deliver", "drop")] == tail
    assert late[-1]["metrics"] == full[-1]["metrics"]
    with pytest.raises(ScenarioError, match="start"):
        stream_replication(DIAMOND, 8, speed=1.0, emit=lambda e: None, realtime=False, start=1000.0)
