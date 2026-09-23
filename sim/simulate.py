#!/usr/bin/env python3
"""Single-server FIFO queue replication (M/M/1 baseline) built on SimPy.

This script is the simulation core of the system. The Go peer service invokes
it as a subprocess, one replication per task. It is also usable standalone:

    python3 simulate.py --seed 42007 --lam 0.8 --mu 1.0 --sim-time 10000 --warmup-time 1000

CLI contract (the Go <-> Python interface, keep it exact):
  * stdout: exactly one line of JSON on success, nothing else.
  * stderr: all diagnostics / logging / error messages.
  * exit 0 on success; exit 1 on invalid parameters or internal error.

Reported metrics (all measured over the window [warmup_time, sim_time]):
  * mean_wait_time    -- mean time in system (queueing + service) of customers
                         that arrived after warm-up and departed before sim_time.
                         Validated against W = 1 / (mu - lambda).
  * mean_queue_length -- time-averaged number of customers in system.
                         Validated against L = rho / (1 - rho).
  * utilization       -- time-averaged fraction of time the server is busy (~rho).
  * packets_served    -- number of customers contributing to mean_wait_time.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import random
import sys
import time
from typing import Callable

import simpy

log = logging.getLogger("simulate")

# ---------------------------------------------------------------------------
# Pluggable random-variate generators.
#
# A factory takes the replication's RNG and a rate and returns a zero-argument
# sampler. New traffic models (Pareto, MMPP, ...) or service distributions
# (M/G/1) are added by registering another factory; the simulation loop does
# not change.
# ---------------------------------------------------------------------------

Sampler = Callable[[], float]
SamplerFactory = Callable[[random.Random, float], Sampler]


def exponential(rng: random.Random, rate: float) -> Sampler:
    return lambda: rng.expovariate(rate)


def deterministic(rng: random.Random, rate: float) -> Sampler:
    value = 1.0 / rate
    return lambda: value


ARRIVAL_PROCESSES: dict[str, SamplerFactory] = {
    "poisson": exponential,
}

SERVICE_DISTRIBUTIONS: dict[str, SamplerFactory] = {
    "exp": exponential,  # M/M/1
    "det": deterministic,  # M/D/1
}


class Monitor:
    """Collects post-warm-up statistics for a single-server queue."""

    def __init__(self, env: simpy.Environment, warmup_time: float, capacity: int = 1):
        self.env = env
        self.warmup_time = warmup_time
        self.capacity = capacity
        self.in_system = 0
        self.last_change = 0.0
        self.area_in_system = 0.0
        self.area_busy = 0.0
        self.total_time_in_system = 0.0
        self.served = 0

    def _advance(self) -> None:
        """Accumulate time-weighted areas since the last state change,
        counting only the portion that falls after the warm-up period."""
        now = self.env.now
        start = max(self.last_change, self.warmup_time)
        if now > start:
            dt = now - start
            self.area_in_system += self.in_system * dt
            self.area_busy += min(self.in_system, self.capacity) * dt
        self.last_change = now

    def arrive(self) -> None:
        self._advance()
        self.in_system += 1

    def depart(self, arrival_time: float) -> None:
        self._advance()
        self.in_system -= 1
        if arrival_time >= self.warmup_time:
            self.served += 1
            self.total_time_in_system += self.env.now - arrival_time

    def close(self) -> None:
        self._advance()


def _source(env, server, monitor, next_interarrival: Sampler, next_service: Sampler):
    while True:
        yield env.timeout(next_interarrival())
        env.process(_customer(env, server, monitor, next_service()))


def _customer(env, server, monitor, service_time: float):
    arrived = env.now
    monitor.arrive()
    with server.request() as req:
        yield req
        yield env.timeout(service_time)
    monitor.depart(arrived)


def validate_params(lam: float, mu: float, sim_time: float, warmup_time: float) -> None:
    values = {"lam": lam, "mu": mu, "sim_time": sim_time, "warmup_time": warmup_time}
    for name, value in values.items():
        if not math.isfinite(value):
            raise ValueError(f"{name} must be a finite number, got {value}")
    if lam <= 0:
        raise ValueError(f"lam must be > 0, got {lam}")
    if mu <= 0:
        raise ValueError(f"mu must be > 0, got {mu}")
    if lam >= mu:
        raise ValueError(
            f"unstable system: rho = lam/mu = {lam / mu:.4f} >= 1 (require lam < mu)"
        )
    if warmup_time < 0:
        raise ValueError(f"warmup_time must be >= 0, got {warmup_time}")
    if sim_time <= warmup_time:
        raise ValueError(
            f"sim_time ({sim_time}) must be greater than warmup_time ({warmup_time})"
        )


def run_replication(
    seed: int,
    lam: float,
    mu: float,
    sim_time: float,
    warmup_time: float,
    service: str = "exp",
    arrivals: str = "poisson",
) -> dict:
    """
    Runs a single M/M/1 SimPy replication and returns a summary dict.
    Must be deterministic given the same seed and parameters.
    Raises ValueError if lam >= mu (unstable system) or parameters are invalid.
    """
    validate_params(lam, mu, sim_time, warmup_time)
    if service not in SERVICE_DISTRIBUTIONS:
        raise ValueError(f"unknown service distribution {service!r}")
    if arrivals not in ARRIVAL_PROCESSES:
        raise ValueError(f"unknown arrival process {arrivals!r}")

    started = time.perf_counter()
    rng = random.Random(seed)
    env = simpy.Environment()
    server = simpy.Resource(env, capacity=1)
    monitor = Monitor(env, warmup_time, capacity=1)

    env.process(
        _source(
            env,
            server,
            monitor,
            ARRIVAL_PROCESSES[arrivals](rng, lam),
            SERVICE_DISTRIBUTIONS[service](rng, mu),
        )
    )
    env.run(until=sim_time)
    monitor.close()

    if monitor.served == 0:
        raise RuntimeError(
            "no customers completed after warm-up; increase sim_time or reduce warmup_time"
        )

    window = sim_time - warmup_time
    result = {
        "seed": seed,
        "mean_wait_time": monitor.total_time_in_system / monitor.served,
        "mean_queue_length": monitor.area_in_system / window,
        "utilization": monitor.area_busy / window,
        "packets_served": monitor.served,
        "runtime_seconds": time.perf_counter() - started,
    }
    log.debug("replication finished: %s", result)
    return result


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one SimPy queue replication.")
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--lam", type=float, required=True, help="arrival rate lambda")
    parser.add_argument("--mu", type=float, required=True, help="service rate mu")
    parser.add_argument("--sim-time", type=float, required=True)
    parser.add_argument("--warmup-time", type=float, default=0.0)
    parser.add_argument("--service", choices=sorted(SERVICE_DISTRIBUTIONS), default="exp")
    parser.add_argument("--arrivals", choices=sorted(ARRIVAL_PROCESSES), default="poisson")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        stream=sys.stderr,
        level=os.environ.get("SIM_LOG_LEVEL", "WARNING").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    args = _parse_args(argv)
    try:
        result = run_replication(
            seed=args.seed,
            lam=args.lam,
            mu=args.mu,
            sim_time=args.sim_time,
            warmup_time=args.warmup_time,
            service=args.service,
            arrivals=args.arrivals,
        )
    except ValueError as exc:
        print(f"invalid parameters: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - any failure must map to exit 1
        print(f"simulation failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
