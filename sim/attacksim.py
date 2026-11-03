#!/usr/bin/env python3
"""Deterministic cyber-attack campaign model with partitioned execution.

The scenario describes a campaign and the topology tokens it affects:

  * ``kind`` is one of ``ddos``, ``synflood``, ``worm`` or ``exfil``;
  * ``duration`` and ``step`` define the campaign timeline;
  * ``seed``, ``scale``, ``intensity``, ``capacity`` and ``defense`` are the
    strategic inputs exposed by the Threat Lab;
  * ``phases`` are the named campaign phases (ids and start fractions);
  * ``nodes`` are the visible topology tokens with their role, represented
    host count and stable index (used for deterministic per-node jitter).

The model is analytic: it turns those inputs into a repeatable sequence of
campaign samples rather than simulating packets. A sample carries the global
campaign state plus a load/compromise pair for every topology token.

Modes (the scenario JSON is read from stdin in every mode):

    attacksim.py --validate               -> {"ok": true, ...} or exit 1
    attacksim.py --plan --parts K         -> deterministic entity partition plan
    attacksim.py --partition              -> JSON-lines open/step/finish worker
    attacksim.py --merge                  -> merge partition samples from stdin
    attacksim.py --seed N                 -> one JSON line: seed, runtime, metrics

Partitioning: topology tokens are assigned to workers. Every worker advances
the same campaign windows in lock-step and emits telemetry only for the tokens
it owns. Because the campaign state is global, workers never exchange arrival
records (``outbound`` is always empty); the coordinator merges the per-token
maps into one timeline. ``parts=1`` is a normal single-worker execution.

Same contract as netsim.py: stdout carries only JSON, diagnostics go to stderr,
exit 0 on success and 1 on invalid input or failure.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from typing import Any

import simpy

MAX_DURATION = 3600.0
MAX_STEP = 60.0
MAX_NODES = 500
MAX_PHASES = 40
MAX_WINDOWS = 200_000
MAX_SAMPLES = 200_000

KINDS = ("ddos", "synflood", "worm", "exfil")
ROLES = ("target", "service", "endpoint", "edge", "bot")


class ScenarioError(ValueError):
    pass


def _num(obj: dict, key: str, where: str, *, default: float | None = None,
         minimum: float = 0.0, exclusive: bool = True, maximum: float = math.inf) -> float:
    value = obj.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ScenarioError(f"{where}: {key} must be a finite number")
    if (exclusive and value <= minimum) or (not exclusive and value < minimum) or value > maximum:
        bound = f"> {minimum}" if exclusive else f">= {minimum}"
        raise ScenarioError(f"{where}: {key} must be {bound}" +
                            (f" and <= {maximum}" if maximum < math.inf else ""))
    return float(value)


def _ident(obj: dict, key: str, where: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ScenarioError(f"{where}: {key} must be a non-empty string of at most 64 characters")
    return value


def _int(obj: dict, key: str, where: str, *, minimum: int = 0) -> int:
    value = obj.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ScenarioError(f"{where}: {key} must be an integer >= {minimum}")
    return value


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate(raw: Any) -> dict:
    """Checks a scenario and returns a normalized copy."""
    if not isinstance(raw, dict):
        raise ScenarioError("scenario must be a JSON object")
    kind = raw.get("kind")
    if kind not in KINDS:
        raise ScenarioError("kind must be ddos, synflood, worm or exfil")
    duration = _num(raw, "duration", "scenario", maximum=MAX_DURATION)
    step = _num(raw, "step", "scenario", default=0.5, maximum=MAX_STEP)
    seed = _int(raw, "seed", "scenario")
    scale = _num(raw, "scale", "scenario", minimum=1, exclusive=False, maximum=200_000)
    intensity = _num(raw, "intensity", "scenario", minimum=1, exclusive=False, maximum=10)
    capacity = _num(raw, "capacity", "scenario", maximum=1e6)
    defense = _num(raw, "defense", "scenario", minimum=0, exclusive=False, maximum=100)

    nodes_raw, phases_raw = raw.get("nodes"), raw.get("phases")
    if not isinstance(nodes_raw, list) or not nodes_raw:
        raise ScenarioError("nodes must be a non-empty list")
    if len(nodes_raw) > MAX_NODES:
        raise ScenarioError(f"nodes must contain at most {MAX_NODES} items")
    if not isinstance(phases_raw, list) or not phases_raw:
        raise ScenarioError("phases must be a non-empty list")
    if len(phases_raw) > MAX_PHASES:
        raise ScenarioError(f"phases must contain at most {MAX_PHASES} items")

    nodes: list[dict] = []
    ids: set[str] = set()
    indices: set[int] = set()
    for i, node in enumerate(nodes_raw):
        where = f"nodes[{i}]"
        if not isinstance(node, dict):
            raise ScenarioError(f"{where} must be an object")
        nid = _ident(node, "id", where)
        if nid in ids:
            raise ScenarioError(f"{where}: duplicate id {nid!r}")
        index = _int(node, "index", where)
        if index in indices:
            raise ScenarioError(f"{where}: duplicate index {index}")
        role = node.get("role")
        if role not in ROLES:
            raise ScenarioError(f"{where} ({nid}): role must be one of {', '.join(ROLES)}")
        units = _num(node, "units", where, minimum=1, exclusive=False, maximum=1e9)
        ids.add(nid)
        indices.add(index)
        nodes.append({"id": nid, "index": index, "role": role, "units": units})
    nodes.sort(key=lambda n: (n["index"], n["id"]))

    phases: list[dict] = []
    previous = -math.inf
    for i, phase in enumerate(phases_raw):
        where = f"phases[{i}]"
        if not isinstance(phase, dict):
            raise ScenarioError(f"{where} must be an object")
        pid = _ident(phase, "id", where)
        at = _num(phase, "at", where, minimum=0, exclusive=False, maximum=1)
        if at < previous:
            raise ScenarioError("phases must be sorted by start fraction")
        previous = at
        phases.append({"id": pid, "at": at})

    windows = max(1, math.ceil(duration / step - 1e-12))
    if windows > MAX_WINDOWS:
        raise ScenarioError(f"campaign needs {windows} windows; increase step or shorten the run")
    if windows + 1 > MAX_SAMPLES:
        raise ScenarioError(f"campaign needs more than {MAX_SAMPLES} samples")

    return {
        "kind": kind, "duration": duration, "step": step, "seed": seed,
        "scale": scale, "intensity": intensity, "capacity": capacity, "defense": defense,
        "nodes": nodes, "phases": phases,
    }


# ---------------------------------------------------------------------------
# Campaign model
# ---------------------------------------------------------------------------

def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _smooth(value: float) -> float:
    t = _clamp(value, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _flood_profile(u: float, t: float) -> float:
    pulse = 1 + 0.05 * math.sin(t * 1.7) + 0.025 * math.sin(t * 0.53)
    if u < 0.1:
        return 0.0
    if u < 0.2:
        return _smooth((u - 0.1) / 0.1) * pulse
    if u < 0.58:
        return pulse
    if u < 0.7:
        return 1.35 * pulse
    if u < 0.86:
        return (1.35 - ((u - 0.7) / 0.16) * 1.3) * pulse
    return 0.02


def _handshake_profile(u: float, t: float) -> float:
    pulse = 1 + 0.06 * math.sin(t * 2.2)
    if u < 0.12:
        return 0.0
    if u < 0.22:
        return _smooth((u - 0.12) / 0.1) * pulse
    if u < 0.55:
        return pulse
    if u < 0.66:
        return 1.18 * pulse
    if u < 0.84:
        return (1.18 - ((u - 0.66) / 0.18) * 1.12) * pulse
    return 0.02


def _exfil_profile(u: float, t: float) -> float:
    pulse = 0.96 + 0.04 * math.sin(t * 0.8)
    if u < 0.14:
        return 0.0
    if u < 0.28:
        return _smooth((u - 0.14) / 0.14) * pulse
    if u < 0.7:
        return 0.82 * pulse
    if u < 0.8:
        return 1.28 * pulse
    if u < 0.92:
        return (1.28 - ((u - 0.8) / 0.12) * 1.22) * pulse
    return 0.03


def _logistic(u: float, midpoint: float, steepness: float) -> float:
    return 1 / (1 + math.exp(-steepness * (u - midpoint)))


def _loss_for_load(ratio: float) -> float:
    if ratio <= 0.9:
        return 0.0
    return _clamp(((ratio - 0.9) / max(0.2, ratio)) * 135, 0, 99)


def _latency_for_load(ratio: float) -> float:
    if ratio < 0.92:
        return 12 / max(0.08, 1 - ratio * 0.92)
    return min(9_999, 180 + ratio * ratio * 640)


def _target_state(load_ratio: float, availability: float, compromise: float) -> str:
    if availability < 40 or load_ratio > 1.6 or compromise > 0.85:
        return "offline"
    if availability < 82 or load_ratio > 1.1 or compromise > 0.55:
        return "critical"
    if availability < 98 or load_ratio > 0.8 or compromise > 0.2:
        return "degraded"
    return "secure"


def _phase_at(sc: dict, u: float) -> str:
    current = sc["phases"][0]["id"]
    for phase in sc["phases"]:
        if u >= phase["at"]:
            current = phase["id"]
    return current


class Campaign:
    """One campaign timeline for a partition.

    The SimPy environment is the campaign clock. Samples are emitted on the
    scenario's fixed grid up to the requested time; each partition keeps only
    the topology tokens it owns in ``nodes``.
    """

    def __init__(self, sc: dict, env: simpy.Environment, assignment: dict[str, int] | None = None,
                 part: int = 0):
        self.sc, self.env = sc, env
        self.assignment = assignment or {node["id"]: 0 for node in sc["nodes"]}
        self.part = part
        self.duration = sc["duration"]
        self.step = sc["step"]
        self.exfiltrated_gb = 0.0
        self.samples: list[dict] = []
        self.next_index = 0
        self._record(0.0)
        self.next_index = 1

    def _owned(self, node: dict) -> bool:
        return self.assignment[node["id"]] == self.part

    def _record(self, time: float) -> None:
        sc = self.sc
        kind = sc["kind"]
        u = time / self.duration
        defense = sc["defense"] / 100
        phase = _phase_at(sc, u)

        attack_load = 0.0
        legit_load = 0.0
        capacity = sc["capacity"]
        impact = 0.0
        impact_pct = 0.0
        availability = 100.0
        latency_ms = 12.0
        compromised = 0.0
        bots_active = 0.0
        blocked = 0.0
        target_compromise = 0.0

        if kind in ("ddos", "synflood"):
            is_ddos = kind == "ddos"
            base = (sc["scale"] * 0.0012 * (sc["intensity"] / 5) if is_ddos
                    else sc["scale"] * 0.00022 * (sc["intensity"] / 5))
            profile = _flood_profile(u, time) if is_ddos else _handshake_profile(u, time)
            detect_at = 0.58 if is_ddos else 0.55
            mitigation = defense * _smooth((u - detect_at) / 0.14)
            attack_load = base * profile * (1 - mitigation)
            legit_load = (6.0 if is_ddos else 1.6) * (0.96 + 0.04 * math.sin(time / 7))
            ratio = (attack_load + legit_load) / capacity
            loss = _loss_for_load(ratio)
            impact = loss
            impact_pct = loss
            availability = _clamp(100 - loss * 0.92 - max(0.0, ratio - 1) * 18, 0, 100)
            latency_ms = _latency_for_load(ratio)
            compromised = sc["scale"] * _clamp((u - 0.08) / 0.12, 0, 1)
            bots_active = sc["scale"] * _clamp(profile, 0, 1)
            blocked = mitigation * 100
        elif kind == "worm":
            start = 0.12
            midpoint = 0.55 - (sc["intensity"] - 5) * 0.018
            steepness = 12 + sc["intensity"] * 1.2
            containment = defense * _smooth((u - 0.62) / 0.12)
            effective_u = u - containment * max(0.0, u - 0.62) * 0.92
            susceptible = _logistic(effective_u, midpoint, steepness)
            initial = _logistic(start, midpoint, steepness)
            fraction = _clamp((susceptible - initial) / max(1e-6, 1 - initial), 0, 1)
            next_fraction = _clamp(
                (_logistic(effective_u + 0.001, midpoint, steepness) - initial) / max(1e-6, 1 - initial),
                0, 1)
            attack_load = max(0.0, (sc["scale"] * (next_fraction - fraction)) /
                             (0.001 * sc["duration"]))
            legit_load = 0.0
            impact = fraction * 100
            impact_pct = impact
            availability = _clamp(100 - fraction * 92 - max(0.0, attack_load / capacity - 1) * 6, 0, 100)
            latency_ms = 12 + fraction * 420
            compromised = sc["scale"] * fraction
            blocked = containment * 100
            target_compromise = fraction * 0.55
        else:
            start = 0.1
            midpoint = 0.58 - (sc["intensity"] - 5) * 0.017
            steepness = 10 + sc["intensity"]
            containment = defense * _smooth((u - 0.7) / 0.12)
            effective_u = u - containment * max(0.0, u - 0.7) * 0.65
            susceptible = _logistic(effective_u, midpoint, steepness)
            initial = _logistic(start, midpoint, steepness)
            fraction = _clamp((susceptible - initial) / max(1e-6, 1 - initial), 0, 1)
            base = sc["scale"] * 0.00006 * (sc["intensity"] / 5)
            profile = _exfil_profile(u, time)
            mitigation = containment * 0.6
            attack_load = base * profile * (1 - mitigation)
            legit_load = 0.5 * (0.94 + 0.06 * math.sin(time / 9))
            self.exfiltrated_gb += (attack_load * self.step) / 8
            impact = self.exfiltrated_gb
            impact_pct = _clamp((self.exfiltrated_gb / 75) * 100, 0, 100)
            ratio = (attack_load + legit_load) / capacity
            availability = _clamp(100 - fraction * 18 - max(0.0, ratio - 1) * 12, 0, 100)
            latency_ms = 12 + max(0.0, ratio - 0.9) * 220
            compromised = sc["scale"] * fraction
            blocked = mitigation * 100
            target_compromise = fraction * 0.2

        load_ratio = (attack_load + legit_load) / capacity
        if kind == "worm":
            threat = _clamp(impact * 0.75 + (100 - availability) * 0.22 +
                            min(load_ratio, 4) * 4, 0, 100)
        elif kind == "exfil":
            threat = _clamp(impact_pct * 0.45 + (compromised / sc["scale"]) * 45 +
                            load_ratio * 9, 0, 100)
        else:
            threat = _clamp(load_ratio * 36 + impact * 0.4 + (100 - availability) * 0.8, 0, 100)

        nodes: dict[str, dict] = {}
        for node in sc["nodes"]:
            if not self._owned(node):
                continue
            index, role = node["index"], node["role"]
            wobble = 0.82 + 0.18 * abs(math.sin(index * 1.7 + sc["seed"] * 0.001))
            load = 0.05
            compromise = 0.0
            if role == "target":
                load = _clamp(load_ratio, 0, 2.4)
                compromise = target_compromise
            elif role == "service":
                if kind == "worm":
                    load = _clamp((compromised / sc["scale"]) * 1.35, 0, 2)
                    compromise = _clamp((compromised / sc["scale"]) * wobble, 0, 1)
                elif kind == "exfil":
                    load = _clamp(load_ratio * (1 if node["id"] == "files" else 0.38), 0, 2)
                    compromise = (_clamp((compromised / sc["scale"]) * 1.15, 0, 1)
                                  if node["id"] == "files" else 0.0)
                else:
                    load = (_clamp(load_ratio, 0, 2) if kind == "synflood" and node["id"] == "api"
                            else _clamp(load_ratio * 0.42, 0, 2))
            elif role == "edge":
                load = _clamp(load_ratio * (0.86 if kind in ("ddos", "synflood") else 0.16), 0, 2)
            elif role == "endpoint":
                if kind in ("worm", "exfil"):
                    load = _clamp((compromised / sc["scale"]) * 1.25, 0, 2)
                    compromise = _clamp((compromised / sc["scale"]) * wobble, 0, 1)
                else:
                    load = 0.06
            else:
                if kind in ("ddos", "synflood"):
                    load = _clamp(bots_active / max(1.0, sc["scale"]), 0, 1.4)
                    compromise = _clamp(bots_active / max(1.0, sc["scale"]), 0, 1)
                else:
                    load = 0.04
                    compromise = 0.12
            nodes[node["id"]] = {"load": load, "compromise": compromise}

        self.samples.append({
            "t": time, "phase": phase, "threat": threat,
            "attackLoad": attack_load, "legitLoad": legit_load, "capacity": capacity,
            "loadRatio": load_ratio, "impact": impact, "impactPct": impact_pct,
            "latencyMs": latency_ms, "availability": availability,
            "compromised": compromised, "botsActive": bots_active, "blocked": blocked,
            "targetState": _target_state(load_ratio, availability, target_compromise),
            "nodes": nodes,
        })

    def advance(self, until: float) -> None:
        """Emit every sample strictly before until and move the SimPy clock."""
        self.env.run(until=until)
        while True:
            next_time = self.next_index * self.step
            if next_time >= until - 1e-12:
                break
            self._record(min(self.duration, next_time))
            self.next_index += 1

    def finish(self) -> None:
        """Emit remaining samples, including the final sample at the duration."""
        if self.env.now < self.duration:
            self.env.run(until=self.duration + 1e-9)
        while self.next_index * self.step < self.duration - 1e-12:
            self._record(min(self.duration, self.next_index * self.step))
            self.next_index += 1
        if not self.samples or self.samples[-1]["t"] < self.duration - 1e-12:
            self._record(self.duration)
            self.next_index += 1

    def metrics(self) -> dict:
        return {
            "kind": self.sc["kind"], "duration": self.duration, "step": self.step,
            "samples": self.samples, "summary": summarize(self.sc, self.samples),
        }


def summarize(sc: dict, samples: list[dict]) -> dict:
    peak_threat = 0.0
    peak_load_ratio = 0.0
    peak_impact = 0.0
    peak_compromised = 0.0
    blocked_pct = 0.0
    time_above_capacity = 0.0
    peak_index = 0
    for index, sample in enumerate(samples):
        if sample["threat"] > peak_threat:
            peak_threat = sample["threat"]
            peak_index = index
        peak_load_ratio = max(peak_load_ratio, sample["loadRatio"])
        peak_impact = max(peak_impact, sample["impact"])
        peak_compromised = max(peak_compromised, sample["compromised"])
        blocked_pct = max(blocked_pct, sample["blocked"])
        if sample["loadRatio"] > 1:
            time_above_capacity += sc["step"]
    peak = samples[peak_index]
    recovery_seconds = None
    for sample in samples[peak_index:]:
        if sample["loadRatio"] < 0.95 and sample["availability"] > 99:
            recovery_seconds = sample["t"] - peak["t"]
            break
    return {
        "peakThreat": peak_threat,
        "peakLoadRatio": peak_load_ratio,
        "peakImpact": peak_impact,
        "peakCompromised": peak_compromised,
        "timeAboveCapacity": time_above_capacity,
        "recoverySeconds": recovery_seconds,
        "exfiltratedGb": samples[-1]["impact"] if sc["kind"] == "exfil" and samples else 0.0,
        "blockedPct": blocked_pct,
    }


# ---------------------------------------------------------------------------
# Partition planning and merge
# ---------------------------------------------------------------------------

def partition_plan(sc: dict, parts: int) -> dict:
    """Distribute topology tokens across workers deterministically."""
    if isinstance(parts, bool) or not isinstance(parts, int) or parts < 1:
        raise ScenarioError("parts must be a positive integer")
    nodes = sorted(sc["nodes"], key=lambda node: node["id"])
    if parts > len(nodes):
        raise ScenarioError(f"parts ({parts}) exceeds the topology token count ({len(nodes)})")

    assignment = {node["id"]: index % parts for index, node in enumerate(nodes)}
    load = [0] * parts
    for owner in assignment.values():
        load[owner] += 1
    lookahead = sc["step"]
    windows = max(1, math.ceil(sc["duration"] / lookahead - 1e-12))
    if windows > MAX_WINDOWS:
        raise ScenarioError(f"partition plan needs {windows} windows; increase step or shorten the run")
    return {
        "ok": True,
        "parts": parts,
        "assignment": {nid: assignment[nid] for nid in sorted(assignment)},
        "cut_links": [],
        "lookahead": lookahead,
        "windows": windows,
        "load": load,
    }


def merge_partition_states(scenario: Any, states: Any) -> dict:
    """Combine per-token sample maps into one campaign timeline."""
    sc = validate(scenario)
    if not isinstance(states, list) or not states:
        raise ScenarioError("merge requires at least one partition state")
    expected_ids = {node["id"] for node in sc["nodes"]}
    merged: dict[float, dict] = {}
    global_fields = (
        "phase", "threat", "attackLoad", "legitLoad", "capacity", "loadRatio",
        "impact", "impactPct", "latencyMs", "availability", "compromised",
        "botsActive", "blocked", "targetState",
    )
    for state in states:
        if not isinstance(state, dict):
            raise ScenarioError("partition state must be an object")
        samples = state.get("samples")
        if not isinstance(samples, list):
            raise ScenarioError("partition state is missing its sample list")
        for sample in samples:
            if not isinstance(sample, dict):
                raise ScenarioError("partition sample must be an object")
            t = sample.get("t")
            if isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t):
                raise ScenarioError("partition sample has an invalid time")
            numeric_t = float(t)
            bucket = merged.get(numeric_t)
            if bucket is None:
                bucket = {"t": numeric_t, "nodes": {}}
                for field in global_fields:
                    bucket[field] = sample.get(field)
                merged[numeric_t] = bucket
            else:
                for field in global_fields:
                    if bucket[field] != sample.get(field):
                        raise ScenarioError(
                            f"partition samples disagree on {field} at t={numeric_t:g}")
            nodes = sample.get("nodes")
            if not isinstance(nodes, dict):
                raise ScenarioError("partition sample is missing its node map")
            for nid, values in nodes.items():
                if nid not in expected_ids:
                    raise ScenarioError(f"partition sample has unknown node {nid!r}")
                if nid in bucket["nodes"]:
                    raise ScenarioError(f"partition sample repeats node {nid!r} at t={numeric_t:g}")
                if not isinstance(values, dict):
                    raise ScenarioError(f"partition sample for {nid!r} must be an object")
                bucket["nodes"][nid] = values

    samples = [merged[t] for t in sorted(merged)]
    if not samples:
        raise ScenarioError("partition states contain no samples")
    for sample in samples:
        missing = expected_ids - set(sample["nodes"])
        if missing:
            raise ScenarioError(
                f"merged sample at t={sample['t']:g} is missing nodes: {', '.join(sorted(missing))}")
    return {
        "kind": sc["kind"], "duration": sc["duration"], "step": sc["step"],
        "samples": samples, "summary": summarize(sc, samples),
    }


# ---------------------------------------------------------------------------
# Worker protocol and CLI
# ---------------------------------------------------------------------------

class PartitionWorker:
    """Stateful one-partition worker used by the JSON-lines protocol."""

    def __init__(self, scenario: Any, plan: dict, part: int, seed: int):
        self.sc = validate(scenario)
        if not isinstance(plan, dict) or plan.get("ok") is not True:
            raise ScenarioError("plan must be a successful partition plan")
        parts, assignment = plan.get("parts"), plan.get("assignment")
        if isinstance(parts, bool) or not isinstance(parts, int) or not isinstance(assignment, dict):
            raise ScenarioError("plan has invalid parts or assignment")
        if isinstance(part, bool) or not isinstance(part, int):
            raise ScenarioError("part must be an integer")
        if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
            raise ScenarioError("seed must be a non-negative integer")
        if not 0 <= part < parts:
            raise ScenarioError(f"part must be in [0, {parts})")
        expected = {node["id"] for node in self.sc["nodes"]}
        if set(assignment) != expected:
            raise ScenarioError("plan assignment must contain every scenario node")
        if any(isinstance(owner, bool) or not isinstance(owner, int) or not 0 <= owner < parts
               for owner in assignment.values()):
            raise ScenarioError("plan assignment contains an invalid partition")
        lookahead, windows = plan.get("lookahead"), plan.get("windows")
        if (isinstance(lookahead, bool) or not isinstance(lookahead, (int, float)) or
                not math.isfinite(lookahead) or lookahead <= 0):
            raise ScenarioError("plan has an invalid lookahead")
        if isinstance(windows, bool) or not isinstance(windows, int) or windows < 1:
            raise ScenarioError("plan has an invalid window count")
        self.plan, self.part, self.seed = plan, part, seed
        self.env = simpy.Environment()
        self.campaign = Campaign(self.sc, self.env, assignment=assignment, part=part)
        self.finished = False

    def step(self, until: Any, inbound: Any) -> dict:
        if self.finished:
            raise ScenarioError("worker is already finished")
        if isinstance(until, bool) or not isinstance(until, (int, float)) or not math.isfinite(until):
            raise ScenarioError("step until must be a finite number")
        if until <= self.env.now or until > self.sc["duration"]:
            raise ScenarioError(
                f"step until must be greater than {self.env.now} and <= run duration")
        if not isinstance(inbound, list):
            raise ScenarioError("step inbound must be a list")
        if inbound:
            raise ScenarioError("attack partitions do not exchange arrival records")
        before = len(self.campaign.samples)
        started = time.perf_counter()
        self.campaign.advance(float(until))
        compute_s = time.perf_counter() - started
        return {
            "outbound": [],
            "compute_s": compute_s,
            "events": len(self.campaign.samples) - before,
        }

    def finish(self) -> dict:
        if self.finished:
            raise ScenarioError("worker is already finished")
        if self.env.now < self.sc["duration"] - 1e-9:
            raise ScenarioError("worker cannot finish before the run duration")
        self.campaign.finish()
        self.finished = True
        return {
            "metrics": self.campaign.metrics(),
            "state": {"samples": self.campaign.samples},
        }


def run_replication(scenario: Any, seed: int) -> dict:
    sc = validate(scenario)
    started = time.perf_counter()
    env = simpy.Environment()
    campaign = Campaign(sc, env)
    campaign.finish()
    return {"seed": seed, "runtime_seconds": time.perf_counter() - started,
            "metrics": campaign.metrics()}


def _write(event: dict) -> None:
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _partition_protocol() -> int:
    worker: PartitionWorker | None = None
    max_request_bytes = 8 << 20
    while True:
        line = sys.stdin.buffer.readline(max_request_bytes + 1)
        if not line:
            return 0
        if len(line) > max_request_bytes:
            _write({"error": "partition request exceeds 8 MiB"})
            return 1
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ScenarioError("partition request must be a JSON object")
            op = request.get("op")
            if op == "open":
                if worker is not None:
                    raise ScenarioError("worker is already open")
                worker = PartitionWorker(
                    request.get("scenario"), request.get("plan"), request.get("part"),
                    request.get("seed"))
                response = {"ok": True}
            elif op == "step":
                if worker is None:
                    raise ScenarioError("worker is not open")
                response = worker.step(request.get("until"), request.get("inbound", []))
            elif op == "finish":
                if worker is None:
                    raise ScenarioError("worker is not open")
                response = worker.finish()
                _write(response)
                return 0
            else:
                raise ScenarioError(f"unknown partition operation {op!r}")
            _write(response)
        except (json.JSONDecodeError, ScenarioError) as exc:
            _write({"error": str(exc)})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Deterministic attack campaign simulation (scenario JSON on stdin).")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--validate", action="store_true")
    mode.add_argument("--plan", action="store_true")
    mode.add_argument("--partition", action="store_true")
    mode.add_argument("--merge", action="store_true")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--parts", type=int, default=1, help="plan: number of entity partitions")
    args = parser.parse_args(argv)
    if args.partition:
        return _partition_protocol()
    if args.merge:
        try:
            request = json.loads(sys.stdin.read(256 << 20) or "null")
            if not isinstance(request, dict):
                raise ScenarioError("merge request must be a JSON object")
            _write(merge_partition_states(request.get("scenario"), request.get("states")))
        except (json.JSONDecodeError, ScenarioError) as exc:
            print(f"invalid scenario: {exc}", file=sys.stderr)
            return 1
        except Exception as exc:  # noqa: BLE001 - CLI errors must be explicit
            print(f"merge failed: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        return 0
    try:
        raw = json.loads(sys.stdin.read(1 << 20) or "null")
    except json.JSONDecodeError as exc:
        print(f"invalid scenario: not JSON ({exc})", file=sys.stderr)
        return 1
    try:
        if args.validate:
            sc = validate(raw)
            windows = max(1, math.ceil(sc["duration"] / sc["step"] - 1e-12))
            _write({"ok": True, "kind": sc["kind"], "nodes": len(sc["nodes"]),
                    "samples": windows + 1, "windows": windows})
        elif args.plan:
            _write(partition_plan(validate(raw), args.parts))
        else:
            _write(run_replication(raw, args.seed))
    except ScenarioError as exc:
        print(f"invalid scenario: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        try:
            sys.stdout = open("/dev/null", "w")
        except OSError:
            pass
        return 0
    except Exception as exc:  # noqa: BLE001 - any failure must map to exit 1
        print(f"simulation failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
