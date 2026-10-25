import json
import statistics
import subprocess
import sys
from pathlib import Path

import pytest

from simulate import run_replication

SCRIPT = Path(__file__).with_name("simulate.py")


def _without_runtime(result: dict) -> dict:
    return {k: v for k, v in result.items() if k != "runtime_seconds"}


def _replicate(n: int, base_seed: int, **params) -> list[dict]:
    return [run_replication(seed=base_seed + i, **params) for i in range(n)]


def test_same_seed_is_deterministic():
    a = run_replication(seed=7, lam=0.8, mu=1.0, sim_time=2000, warmup_time=200)
    b = run_replication(seed=7, lam=0.8, mu=1.0, sim_time=2000, warmup_time=200)
    assert _without_runtime(a) == _without_runtime(b)


def test_different_seeds_differ():
    a = run_replication(seed=1, lam=0.8, mu=1.0, sim_time=2000, warmup_time=200)
    b = run_replication(seed=2, lam=0.8, mu=1.0, sim_time=2000, warmup_time=200)
    assert a["mean_wait_time"] != b["mean_wait_time"]


def test_result_schema():
    r = run_replication(seed=42007, lam=0.8, mu=1.0, sim_time=1000, warmup_time=100)
    assert set(r) == {
        "seed",
        "mean_wait_time",
        "mean_queue_length",
        "utilization",
        "packets_served",
        "runtime_seconds",
    }
    assert r["seed"] == 42007
    assert isinstance(r["packets_served"], int) and r["packets_served"] > 0
    assert 0.0 <= r["utilization"] <= 1.0


@pytest.mark.parametrize(
    "kwargs",
    [
        dict(lam=1.0, mu=1.0, sim_time=100, warmup_time=0),  # rho == 1
        dict(lam=1.5, mu=1.0, sim_time=100, warmup_time=0),  # rho > 1
        dict(lam=0.0, mu=1.0, sim_time=100, warmup_time=0),
        dict(lam=0.5, mu=-1.0, sim_time=100, warmup_time=0),
        dict(lam=0.5, mu=1.0, sim_time=100, warmup_time=100),  # no observation window
        dict(lam=0.5, mu=1.0, sim_time=100, warmup_time=-1),
        dict(lam=float("nan"), mu=1.0, sim_time=100, warmup_time=0),
    ],
)
def test_invalid_parameters_raise(kwargs):
    with pytest.raises(ValueError):
        run_replication(seed=1, **kwargs)


@pytest.mark.parametrize("lam,mu,tol", [(0.5, 1.0, 0.05), (0.8, 1.0, 0.10)])
def test_mm1_matches_closed_form(lam, mu, tol):
    rho = lam / mu
    expected_w = 1.0 / (mu - lam)
    expected_l = rho / (1.0 - rho)

    runs = _replicate(10, 1000, lam=lam, mu=mu, sim_time=30000, warmup_time=2000)
    w = statistics.fmean(r["mean_wait_time"] for r in runs)
    l_ = statistics.fmean(r["mean_queue_length"] for r in runs)
    util = statistics.fmean(r["utilization"] for r in runs)

    assert w == pytest.approx(expected_w, rel=tol)
    assert l_ == pytest.approx(expected_l, rel=tol)
    assert util == pytest.approx(rho, rel=0.03)


def test_littles_law_holds_per_replication():
    r = run_replication(seed=3, lam=0.7, mu=1.0, sim_time=50000, warmup_time=1000)
    assert r["mean_queue_length"] == pytest.approx(0.7 * r["mean_wait_time"], rel=0.03)


def test_md1_matches_pollaczek_khinchine():
    lam, mu = 0.5, 1.0
    rho = lam / mu
    expected_w = 1.0 / mu + rho / (2.0 * mu * (1.0 - rho))  # 1.5
    runs = _replicate(
        5, 500, lam=lam, mu=mu, sim_time=30000, warmup_time=2000, service="det"
    )
    w = statistics.fmean(r["mean_wait_time"] for r in runs)
    assert w == pytest.approx(expected_w, rel=0.05)


def _run_cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=60
    )


def test_cli_prints_single_json_line():
    proc = _run_cli(
        "--seed", "42007", "--lam", "0.8", "--mu", "1.0",
        "--sim-time", "2000", "--warmup-time", "200",
    )
    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["seed"] == 42007
    expected = run_replication(seed=42007, lam=0.8, mu=1.0, sim_time=2000, warmup_time=200)
    assert _without_runtime(payload) == _without_runtime(expected)


def test_cli_unstable_system_exits_nonzero_with_stderr():
    proc = _run_cli(
        "--seed", "1", "--lam", "1.2", "--mu", "1.0",
        "--sim-time", "100", "--warmup-time", "10",
    )
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "rho" in proc.stderr


# ---------------------------------------------------------------------------
# Streaming mode (live traffic view)
# ---------------------------------------------------------------------------

from simulate import stream_replication  # noqa: E402


def _stream(seed=11, lam=0.8, mu=1.0, duration=300.0, speed=10.0) -> list[dict]:
    events: list[dict] = []
    stream_replication(seed, lam, mu, duration, speed, events.append, realtime=False)
    return events


def test_stream_event_sequence_is_consistent():
    events = _stream()
    assert events[0]["type"] == "meta" and events[0]["theory"] == {"rho": 0.8, "W": 5.0, "L": 4.0}
    assert events[-1]["type"] == "done"
    times = [e["t"] for e in events[1:]]
    assert times == sorted(times), "events must be in time order"

    seen: dict[int, list[str]] = {}
    for e in events:
        if e["type"] in ("arrival", "start", "depart"):
            seen.setdefault(e["id"], []).append(e["type"])
            assert e.get("in_system", 0) >= 0
    for packet_id, kinds in seen.items():
        assert kinds in (["arrival"], ["arrival", "start"], ["arrival", "start", "depart"]), (packet_id, kinds)

    done = events[-1]
    assert done["served"] == sum(1 for e in events if e["type"] == "depart")
    assert done["arrived"] == sum(1 for e in events if e["type"] == "arrival")
    assert done["in_system"] == done["arrived"] - done["served"]
    assert any(e["type"] == "stats" for e in events)


def test_stream_is_deterministic_and_fifo():
    a, b = _stream(seed=5), _stream(seed=5)
    assert a == b
    starts = [e["id"] for e in a if e["type"] == "start"]
    assert starts == sorted(starts), "a single FIFO server starts packets in arrival order"


def test_stream_delay_matches_theory_over_a_long_run():
    done = _stream(seed=3, duration=3600.0)[-1]
    assert done["mean_delay"] == pytest.approx(5.0, rel=0.25)
    assert done["utilization"] == pytest.approx(0.8, rel=0.1)


def test_stream_allows_bounded_overload():
    events = _stream(lam=1.2, mu=1.0, duration=200.0)
    assert events[0]["theory"] is None
    assert events[-1]["in_system"] > 10, "an overloaded queue keeps growing"


@pytest.mark.parametrize(
    "kwargs",
    [
        dict(lam=2.0, mu=1.0),  # rho above the streaming bound
        dict(duration=10_000.0),
        dict(lam=0.9, speed=500.0),  # packet rate above the bound
        dict(speed=0.0),
    ],
)
def test_stream_rejects_invalid_parameters(kwargs):
    with pytest.raises(ValueError):
        _stream(**kwargs)


def test_cli_stream_prints_event_lines():
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "--stream", "--seed", "9", "--lam", "0.8", "--mu", "1.0",
         "--sim-time", "20", "--speed", "200"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    lines = [json.loads(line) for line in proc.stdout.splitlines()]
    assert lines[0]["type"] == "meta" and lines[-1]["type"] == "done"
    assert lines[-1]["t"] == pytest.approx(20.0)
