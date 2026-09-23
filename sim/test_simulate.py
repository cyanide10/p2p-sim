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
