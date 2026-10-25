import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

from netsim import ScenarioError, compute_routes, path_of, run_replication, stream_replication, validate

SCRIPT = Path(__file__).with_name("netsim.py")

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


def test_shortest_path_and_reroute_on_failure():
    sc = validate(DIAMOND)
    assert path_of(sc, compute_routes(sc, set()), "h1", "h2") == ["h1", "r1", "r2", "r4", "h2"]
    assert path_of(sc, compute_routes(sc, {"fast1"}), "h1", "h2") == ["h1", "r1", "r3", "r4", "h2"]
    assert path_of(sc, compute_routes(sc, {"fast1", "slow1"}), "h1", "h2") == []


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
    bad = _cli(["--validate"], {"duration": 1})
    assert bad.returncode == 1 and bad.stdout == "" and "invalid scenario" in bad.stderr


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
