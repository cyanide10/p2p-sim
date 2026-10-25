#!/usr/bin/env python3
"""Packet-level network simulation (queueing model) built on SimPy.

A scenario describes a topology and its traffic:

  * hosts send and receive flows; they never forward transit traffic;
  * routers are single-server FIFO queues (service_rate packets/s) with a
    finite buffer (packets in the router, including the one in service);
    a full buffer drops the arriving packet;
  * links are bidirectional; each direction transmits one packet at a time
    in 1/bandwidth seconds (fixed-size packets) from a finite buffer, then
    the packet propagates for `delay` seconds;
  * routing is shortest path by latency (delay + 1/bandwidth per link),
    recomputed whenever a link or router goes down or comes back;
  * flows are Poisson with a constant rate, a rate schedule (step or linear
    between points), or on/off bursts (exponential on and off periods);
  * events take links or routers down and up at given times. Packets inside
    a failed element are dropped.

Modes (the scenario JSON is read from stdin in every mode):

    netsim.py --validate               -> {"ok": true, ...} or exit 1
    netsim.py --seed N                 -> one JSON line: seed, runtime_seconds, metrics
    netsim.py --stream --seed N --speed S
                                       -> one JSON event per line, paced in real time

Same contract as simulate.py: stdout carries only JSON, diagnostics go to
stderr, exit 0 on success and 1 on invalid input or failure.
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import os
import random
import sys
import time
from typing import Any, Callable

import simpy

# Limits keep one replication within the node's per-task time budget.
MAX_NODES = 60
MAX_LINKS = 120
MAX_FLOWS = 40
MAX_EVENTS = 60
MAX_POINTS = 60
MAX_DURATION = 3600.0
MAX_OFFERED_PACKETS = 150_000  # peak offered rate x duration, summed over flows
MAX_STREAM_PACKET_RATE = 150.0  # peak offered packets per wall-clock second when streaming
BINS = 40

Emit = Callable[[dict], None]


class ScenarioError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _num(obj: dict, key: str, where: str, *, default: float | None = None, minimum: float = 0.0,
         exclusive: bool = True, maximum: float = math.inf) -> float:
    value = obj.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ScenarioError(f"{where}: {key} must be a finite number")
    if (exclusive and value <= minimum) or (not exclusive and value < minimum) or value > maximum:
        bound = f"> {minimum}" if exclusive else f">= {minimum}"
        raise ScenarioError(f"{where}: {key} must be {bound}" + (f" and <= {maximum}" if maximum < math.inf else ""))
    return float(value)


def _ident(obj: dict, key: str, where: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value or len(value) > 40:
        raise ScenarioError(f"{where}: {key} must be a non-empty string of at most 40 characters")
    return value


def peak_rate(flow: dict) -> float:
    pattern = flow["pattern"]
    if pattern["type"] == "schedule":
        return max(p["rate"] for p in pattern["points"])
    return flow["rate"]


def validate(raw: Any) -> dict:
    """Checks a scenario and returns a normalized copy (defaults filled in)."""
    if not isinstance(raw, dict):
        raise ScenarioError("scenario must be a JSON object")
    duration = _num(raw, "duration", "scenario", maximum=MAX_DURATION)
    nodes_raw, links_raw = raw.get("nodes"), raw.get("links")
    flows_raw, events_raw = raw.get("flows", []), raw.get("events", [])
    for name, value, limit in (("nodes", nodes_raw, MAX_NODES), ("links", links_raw, MAX_LINKS),
                               ("flows", flows_raw, MAX_FLOWS), ("events", events_raw, MAX_EVENTS)):
        if not isinstance(value, list) or len(value) > limit:
            raise ScenarioError(f"{name} must be a list of at most {limit} items")
    if not flows_raw:
        raise ScenarioError("add at least one flow")

    nodes: dict[str, dict] = {}
    for i, n in enumerate(nodes_raw):
        where = f"nodes[{i}]"
        if not isinstance(n, dict):
            raise ScenarioError(f"{where} must be an object")
        nid = _ident(n, "id", where)
        if nid in nodes:
            raise ScenarioError(f"{where}: duplicate id {nid!r}")
        kind = n.get("kind")
        if kind not in ("host", "router"):
            raise ScenarioError(f"{where} ({nid}): kind must be 'host' or 'router'")
        node = {"id": nid, "kind": kind}
        if kind == "router":
            node["service_rate"] = _num(n, "service_rate", f"router {nid}", default=100.0, maximum=1e6)
            node["buffer"] = int(_num(n, "buffer", f"router {nid}", default=50, minimum=1, exclusive=False, maximum=10_000))
        nodes[nid] = node

    links: dict[str, dict] = {}
    for i, link in enumerate(links_raw):
        where = f"links[{i}]"
        if not isinstance(link, dict):
            raise ScenarioError(f"{where} must be an object")
        lid = _ident(link, "id", where)
        if lid in links or lid in nodes:
            raise ScenarioError(f"{where}: duplicate id {lid!r}")
        a, b = _ident(link, "a", where), _ident(link, "b", where)
        if a not in nodes or b not in nodes or a == b:
            raise ScenarioError(f"link {lid}: must join two different existing nodes")
        links[lid] = {
            "id": lid, "a": a, "b": b,
            "bandwidth": _num(link, "bandwidth", f"link {lid}", default=100.0, maximum=1e6),
            "delay": _num(link, "delay", f"link {lid}", default=0.01, exclusive=False, maximum=60.0),
            "buffer": int(_num(link, "buffer", f"link {lid}", default=50, minimum=1, exclusive=False, maximum=10_000)),
        }

    flows: dict[str, dict] = {}
    for i, f in enumerate(flows_raw):
        where = f"flows[{i}]"
        if not isinstance(f, dict):
            raise ScenarioError(f"{where} must be an object")
        fid = _ident(f, "id", where)
        if fid in flows:
            raise ScenarioError(f"{where}: duplicate id {fid!r}")
        src, dst = _ident(f, "src", where), _ident(f, "dst", where)
        for end in (src, dst):
            if nodes.get(end, {}).get("kind") != "host":
                raise ScenarioError(f"flow {fid}: {end!r} is not a host")
        if src == dst:
            raise ScenarioError(f"flow {fid}: source and destination must differ")
        pattern = f.get("pattern") or {"type": "constant"}
        if not isinstance(pattern, dict):
            raise ScenarioError(f"flow {fid}: pattern must be an object")
        kind = pattern.get("type", "constant")
        flow = {"id": fid, "src": src, "dst": dst}
        if kind == "constant":
            flow["rate"] = _num(f, "rate", f"flow {fid}", maximum=1e5)
            flow["pattern"] = {"type": "constant"}
        elif kind == "onoff":
            flow["rate"] = _num(f, "rate", f"flow {fid}", maximum=1e5)
            flow["pattern"] = {
                "type": "onoff",
                "on_mean": _num(pattern, "on_mean", f"flow {fid} on/off", default=2.0, maximum=MAX_DURATION),
                "off_mean": _num(pattern, "off_mean", f"flow {fid} on/off", default=2.0, maximum=MAX_DURATION),
            }
        elif kind == "schedule":
            points = pattern.get("points")
            if not isinstance(points, list) or not 1 <= len(points) <= MAX_POINTS:
                raise ScenarioError(f"flow {fid}: a schedule needs 1 to {MAX_POINTS} points")
            clean = []
            for j, p in enumerate(points):
                if not isinstance(p, dict):
                    raise ScenarioError(f"flow {fid} point {j} must be an object")
                clean.append({
                    "t": _num(p, "t", f"flow {fid} point {j}", exclusive=False, maximum=duration),
                    "rate": _num(p, "rate", f"flow {fid} point {j}", exclusive=False, maximum=1e5),
                })
            clean.sort(key=lambda p: p["t"])
            if max(p["rate"] for p in clean) <= 0:
                raise ScenarioError(f"flow {fid}: the schedule never sends anything")
            interpolate = pattern.get("interpolate", "step")
            if interpolate not in ("step", "linear"):
                raise ScenarioError(f"flow {fid}: interpolate must be 'step' or 'linear'")
            flow["rate"] = max(p["rate"] for p in clean)
            flow["pattern"] = {"type": "schedule", "points": clean, "interpolate": interpolate}
        else:
            raise ScenarioError(f"flow {fid}: pattern type must be constant, schedule or onoff")
        flows[fid] = flow

    events = []
    for i, e in enumerate(events_raw):
        where = f"events[{i}]"
        if not isinstance(e, dict):
            raise ScenarioError(f"{where} must be an object")
        target = _ident(e, "target", where)
        if target not in links and nodes.get(target, {}).get("kind") != "router":
            raise ScenarioError(f"{where}: target must be a link or router id, got {target!r}")
        action = e.get("action")
        if action not in ("down", "up"):
            raise ScenarioError(f"{where}: action must be 'down' or 'up'")
        events.append({"t": _num(e, "t", where, exclusive=False, maximum=duration), "target": target, "action": action})
    events.sort(key=lambda e: e["t"])

    offered = sum(peak_rate(f) for f in flows.values()) * duration
    if offered > MAX_OFFERED_PACKETS:
        raise ScenarioError(
            f"too much traffic for one replication: about {offered:,.0f} packets at peak "
            f"(limit {MAX_OFFERED_PACKETS:,}); lower the rates or the duration")

    return {"duration": duration, "nodes": nodes, "links": links, "flows": flows, "events": events}


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def compute_routes(sc: dict, down: set[str]) -> dict[str, dict[str, str]]:
    """next_hop[node][dst] = link id to take. Hosts only originate/terminate."""
    adj: dict[str, list[tuple[str, str, float]]] = {n: [] for n in sc["nodes"]}
    for link in sc["links"].values():
        if link["id"] in down or link["a"] in down or link["b"] in down:
            continue
        w = link["delay"] + 1.0 / link["bandwidth"]
        adj[link["a"]].append((link["b"], link["id"], w))
        adj[link["b"]].append((link["a"], link["id"], w))
    hosts = [n for n, v in sc["nodes"].items() if v["kind"] == "host"]
    table: dict[str, dict[str, str]] = {n: {} for n in sc["nodes"]}
    for dst in hosts:
        # Dijkstra from dst; transit only through routers.
        dist = {dst: 0.0}
        heap = [(0.0, dst)]
        while heap:
            d, u = heapq.heappop(heap)
            if d > dist.get(u, math.inf):
                continue
            if u != dst and sc["nodes"][u]["kind"] == "host":
                continue  # a host can be reached but never forwards
            for v, lid, w in sorted(adj[u]):
                nd = d + w
                if nd < dist.get(v, math.inf) - 1e-12:
                    dist[v] = nd
                    table[v][dst] = lid
                    heapq.heappush(heap, (nd, v))
    return table


def path_of(sc: dict, table: dict, src: str, dst: str) -> list[str]:
    path, node, seen = [src], src, {src}
    while node != dst:
        lid = table[node].get(dst)
        if lid is None:
            return []
        link = sc["links"][lid]
        node = link["b"] if link["a"] == node else link["a"]
        if node in seen:
            return []
        seen.add(node)
        path.append(node)
    return path


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

class Station:
    """A FIFO single server with a finite buffer: a router or one link direction."""

    def __init__(self, env: simpy.Environment, capacity: int, duration: float):
        self.env = env
        self.capacity = capacity
        self.server = simpy.Resource(env, capacity=1)
        self.in_system = 0
        self.busy = 0.0
        self.window_busy = 0.0
        self.area = 0.0
        self.last = 0.0
        self.packets = 0
        self.drops = 0
        self.duration = duration
        self.epoch = 0  # incremented on failure; packets inside are dropped

    def _advance(self) -> None:
        now = self.env.now
        self.area += self.in_system * (now - self.last)
        self.last = now

    def enter(self) -> None:
        self._advance()
        self.in_system += 1

    def leave(self) -> None:
        self._advance()
        self.in_system -= 1


class Network:
    def __init__(self, sc: dict, seed: int, env: simpy.Environment, emit: Emit | None = None,
                 stats_every: float | None = None):
        self.sc, self.env, self.emit = sc, env, emit
        self.rng = random.Random(seed)
        self.duration = sc["duration"]
        self.bin_width = self.duration / BINS
        self.down: set[str] = set()
        self.routes = compute_routes(sc, self.down)
        self.routers = {nid: Station(env, n["buffer"], self.duration)
                        for nid, n in sc["nodes"].items() if n["kind"] == "router"}
        self.links = {}
        for lid, link in sc["links"].items():
            self.links[(lid, link["a"])] = Station(env, link["buffer"], self.duration)  # transmitting from a
            self.links[(lid, link["b"])] = Station(env, link["buffer"], self.duration)
        self.flow_stats = {fid: {"sent": 0, "delivered": 0, "dropped": 0, "delays": [],
                                 "drops": {}} for fid in sc["flows"]}
        self.bins = {"delivered": [0] * BINS, "dropped": [0] * BINS, "delay_sum": [0.0] * BINS,
                     "flows": {fid: [0] * BINS for fid in sc["flows"]}}
        self.packet_id = 0
        self.stats_every = stats_every

    # -- helpers ----------------------------------------------------------
    def _bin(self, t: float) -> int:
        return min(BINS - 1, int(t / self.bin_width))

    def _send(self, event: dict) -> None:
        if self.emit:
            self.emit(event)

    def _drop(self, pkt: int, fid: str, at: str, reason: str) -> None:
        st = self.flow_stats[fid]
        st["dropped"] += 1
        st["drops"][reason] = st["drops"].get(reason, 0) + 1
        self.bins["dropped"][self._bin(self.env.now)] += 1
        self._send({"type": "drop", "t": round(self.env.now, 4), "pkt": pkt, "flow": fid, "at": at, "reason": reason})

    # -- traffic ----------------------------------------------------------
    def _rate_at(self, flow: dict, t: float) -> float:
        points = flow["pattern"]["points"]
        if t < points[0]["t"]:
            return points[0]["rate"]
        for a, b in zip(points, points[1:]):
            if a["t"] <= t < b["t"]:
                if flow["pattern"]["interpolate"] == "linear":
                    return a["rate"] + (b["rate"] - a["rate"]) * (t - a["t"]) / (b["t"] - a["t"])
                return a["rate"]
        return points[-1]["rate"]

    def source(self, flow: dict):
        rng = random.Random(self.rng.getrandbits(64))
        kind = flow["pattern"]["type"]
        if kind == "onoff":
            on = rng.random() < flow["pattern"]["on_mean"] / (flow["pattern"]["on_mean"] + flow["pattern"]["off_mean"])
            while True:
                period = rng.expovariate(1.0 / (flow["pattern"]["on_mean"] if on else flow["pattern"]["off_mean"]))
                end = self.env.now + period
                if on:
                    while True:
                        gap = rng.expovariate(flow["rate"])
                        if self.env.now + gap > end:
                            break
                        yield self.env.timeout(gap)
                        self._launch(flow, rng)
                    yield self.env.timeout(max(0.0, end - self.env.now))
                else:
                    yield self.env.timeout(period)
                on = not on
        peak = flow["rate"]
        while True:
            yield self.env.timeout(rng.expovariate(peak))
            if kind == "schedule" and rng.random() * peak > self._rate_at(flow, self.env.now):
                continue  # thinning: accept with probability rate(t) / peak
            self._launch(flow, rng)

    def _launch(self, flow: dict, rng: random.Random) -> None:
        self.packet_id += 1
        self.flow_stats[flow["id"]]["sent"] += 1
        self.env.process(self.packet(self.packet_id, flow))

    # -- packet life ------------------------------------------------------
    def packet(self, pkt: int, flow: dict):
        env, fid, dst = self.env, flow["id"], flow["dst"]
        born = env.now
        node = flow["src"]
        self._send({"type": "send", "t": round(born, 4), "pkt": pkt, "flow": fid, "at": node})
        hops = 0
        while node != dst:
            hops += 1
            lid = self.routes[node].get(dst)
            if lid is None or hops > 64:
                self._drop(pkt, fid, node, "no_route")
                return
            link = self.sc["links"][lid]
            nxt = link["b"] if link["a"] == node else link["a"]
            st = self.links[(lid, node)]
            if st.in_system >= st.capacity:
                st.drops += 1
                self._drop(pkt, fid, lid, "link_buffer")
                return
            epoch = st.epoch
            st.enter()
            with st.server.request() as req:
                yield req
                if st.epoch != epoch:
                    st.leave()
                    self._drop(pkt, fid, lid, "link_down")
                    return
                tx = 1.0 / link["bandwidth"]
                self._send({"type": "hop", "t": round(env.now, 4), "pkt": pkt, "flow": fid, "link": lid,
                            "from": node, "to": nxt})
                yield env.timeout(tx)
                st.busy += tx
                st.window_busy += tx
            st.leave()
            st.packets += 1
            if link["delay"] > 0:
                yield env.timeout(link["delay"])
            if st.epoch != epoch or lid in self.down:
                self._drop(pkt, fid, lid, "link_down")
                return
            node = nxt
            if node == dst:
                break
            router = self.routers.get(node)
            if router is None:
                self._drop(pkt, fid, node, "no_route")  # hosts do not forward
                return
            if node in self.down:
                self._drop(pkt, fid, node, "router_down")
                return
            if router.in_system >= router.capacity:
                router.drops += 1
                self._drop(pkt, fid, node, "router_buffer")
                return
            epoch = router.epoch
            router.enter()
            with router.server.request() as req:
                yield req
                if router.epoch != epoch:
                    router.leave()
                    self._drop(pkt, fid, node, "router_down")
                    return
                service = self.rng.expovariate(self.sc["nodes"][node]["service_rate"])
                yield env.timeout(service)
                router.busy += service
                router.window_busy += service
            router.leave()
            router.packets += 1
            if router.epoch != epoch:
                self._drop(pkt, fid, node, "router_down")
                return
        delay = env.now - born
        st = self.flow_stats[fid]
        st["delivered"] += 1
        st["delays"].append(delay)
        b = self._bin(env.now)
        self.bins["delivered"][b] += 1
        self.bins["delay_sum"][b] += delay
        self.bins["flows"][fid][b] += 1
        self._send({"type": "deliver", "t": round(env.now, 4), "pkt": pkt, "flow": fid, "delay": round(delay, 4)})

    # -- failures -----------------------------------------------------------
    def failures(self):
        for e in self.sc["events"]:
            if e["t"] > self.env.now:
                yield self.env.timeout(e["t"] - self.env.now)
            target = e["target"]
            if e["action"] == "down":
                self.down.add(target)
                stations = [self.routers[target]] if target in self.routers else \
                    [self.links[(target, self.sc["links"][target]["a"])], self.links[(target, self.sc["links"][target]["b"])]]
                for st in stations:
                    st.epoch += 1
            else:
                self.down.discard(target)
            self.routes = compute_routes(self.sc, self.down)
            self._send({"type": "failure", "t": round(self.env.now, 4), "target": target, "action": e["action"],
                        "routes": self.flow_paths()})

    def flow_paths(self) -> dict[str, list[str]]:
        return {fid: path_of(self.sc, self.routes, f["src"], f["dst"]) for fid, f in self.sc["flows"].items()}

    # -- live statistics ------------------------------------------------------
    def reporter(self):
        while True:
            yield self.env.timeout(self.stats_every)
            links = {}
            for lid, link in self.sc["links"].items():
                ab, ba = self.links[(lid, link["a"])], self.links[(lid, link["b"])]
                links[lid] = {"util": round(min(1.0, max(ab.window_busy, ba.window_busy) / self.stats_every), 3),
                              "queue": ab.in_system + ba.in_system}
                ab.window_busy = ba.window_busy = 0.0
            routers = {}
            for rid, r in self.routers.items():
                routers[rid] = {"util": round(min(1.0, r.window_busy / self.stats_every), 3), "queue": r.in_system}
                r.window_busy = 0.0
            flows = {fid: {"sent": s["sent"], "delivered": s["delivered"], "dropped": s["dropped"],
                           "mean_delay": round(sum(s["delays"]) / len(s["delays"]), 4) if s["delays"] else None}
                     for fid, s in self.flow_stats.items()}
            self._send({"type": "stats", "t": round(self.env.now, 4), "links": links, "routers": routers,
                        "flows": flows})

    def start(self) -> None:
        for flow in self.sc["flows"].values():
            self.env.process(self.source(flow))
        if self.sc["events"]:
            self.env.process(self.failures())
        if self.stats_every:
            self.env.process(self.reporter())

    def finish(self) -> None:
        for st in list(self.routers.values()) + list(self.links.values()):
            st._advance()

    def run(self) -> None:
        self.start()
        self.env.run(until=self.duration)
        self.finish()

    def snapshot(self, t: float) -> dict:
        """State at time t, sent when a stream starts mid-run."""
        return {
            "type": "seek", "t": round(t, 4), "down": sorted(self.down), "routes": self.flow_paths(),
            "links": {lid: {"util": 0.0, "queue": self.links[(lid, link["a"])].in_system + self.links[(lid, link["b"])].in_system}
                      for lid, link in self.sc["links"].items()},
            "routers": {rid: {"util": 0.0, "queue": r.in_system} for rid, r in self.routers.items()},
            "flows": {fid: {"sent": s["sent"], "delivered": s["delivered"], "dropped": s["dropped"],
                            "mean_delay": round(sum(s["delays"]) / len(s["delays"]), 4) if s["delays"] else None}
                      for fid, s in self.flow_stats.items()},
        }

    # -- results ------------------------------------------------------------
    def metrics(self) -> dict:
        d = self.duration
        r4 = lambda v: round(v, 6)  # noqa: E731
        flows, total_delays = {}, []
        sent = delivered = dropped = 0
        for fid, s in self.flow_stats.items():
            delays = sorted(s["delays"])
            total_delays += delays
            sent, delivered, dropped = sent + s["sent"], delivered + s["delivered"], dropped + s["dropped"]
            flows[fid] = {
                "sent": s["sent"], "delivered": s["delivered"], "dropped": s["dropped"],
                "loss_rate": r4(s["dropped"] / s["sent"]) if s["sent"] else 0.0,
                "mean_delay": r4(sum(delays) / len(delays)) if delays else None,
                "p95_delay": r4(delays[min(len(delays) - 1, int(0.95 * len(delays)))]) if delays else None,
                "throughput": r4(s["delivered"] / d),
            }
        links = {}
        for lid, link in self.sc["links"].items():
            ab, ba = self.links[(lid, link["a"])], self.links[(lid, link["b"])]
            links[lid] = {
                "utilization": r4(max(ab.busy, ba.busy) / d),
                "utilization_ab": r4(ab.busy / d), "utilization_ba": r4(ba.busy / d),
                "packets": ab.packets + ba.packets, "drops": ab.drops + ba.drops,
                "mean_queue": r4((ab.area + ba.area) / d),
            }
        routers = {rid: {"utilization": r4(r.busy / d), "mean_queue": r4(r.area / d),
                         "packets": r.packets, "drops": r.drops}
                   for rid, r in self.routers.items()}
        w = self.bin_width
        series = {
            "bin_width": r4(w),
            "delivered_rate": [r4(c / w) for c in self.bins["delivered"]],
            "dropped_rate": [r4(c / w) for c in self.bins["dropped"]],
            "mean_delay": [r4(s / c) if c else None for s, c in zip(self.bins["delay_sum"], self.bins["delivered"])],
            "flows": {fid: [r4(c / w) for c in counts] for fid, counts in self.bins["flows"].items()},
        }
        totals = {
            "sent": sent, "delivered": delivered, "dropped": dropped,
            "loss_rate": r4(dropped / sent) if sent else 0.0,
            "mean_delay": r4(sum(total_delays) / len(total_delays)) if total_delays else None,
            "throughput": r4(delivered / d),
        }
        return {"duration": d, "flows": flows, "links": links, "routers": routers, "totals": totals, "series": series}


def run_replication(scenario: Any, seed: int) -> dict:
    sc = validate(scenario)
    started = time.perf_counter()
    net = Network(sc, seed, simpy.Environment())
    net.run()
    return {"seed": seed, "runtime_seconds": time.perf_counter() - started, "metrics": net.metrics()}


def stream_replication(scenario: Any, seed: int, speed: float, emit: Emit, realtime: bool = True,
                       start: float = 0.0) -> dict:
    """Runs one replication and emits its events, paced to `speed` simulated
    seconds per wall-clock second. With start > 0 the simulation runs at full
    speed, silently, up to `start`, then reports the state there in a "seek"
    event and continues in real time. The packets are those of the same seed
    from t = 0, so any point of a run can be watched again exactly."""
    sc = validate(scenario)
    if not (math.isfinite(speed) and speed > 0):
        raise ScenarioError("speed must be a positive number")
    if not (math.isfinite(start) and 0 <= start < sc["duration"]):
        raise ScenarioError("start must be within the run")
    peak = sum(peak_rate(f) for f in sc["flows"].values())
    if peak * speed > MAX_STREAM_PACKET_RATE:
        raise ScenarioError(
            f"{peak * speed:.0f} packets per second at this speed exceeds {MAX_STREAM_PACKET_RATE:.0f}; lower the speed")

    env = simpy.Environment()

    def gated(event: dict) -> None:
        if event.get("t", 0.0) >= start:
            emit(event)

    net = Network(sc, seed, env, emit=gated, stats_every=speed * 0.25)
    emit({"type": "meta", "seed": seed, "speed": speed, "duration": sc["duration"], "start": start,
          "routes": net.flow_paths()})
    net.start()
    wall0: float | None = None
    while True:
        nxt = env.peek()
        if nxt >= sc["duration"]:
            break  # like env.run(until=duration): events at the end time are not processed
        if nxt >= start and wall0 is None:
            wall0 = time.monotonic()
            if start > 0:
                emit(net.snapshot(start))
        if realtime and wall0 is not None:
            delay = wall0 + (nxt - start) / speed - time.monotonic()
            if delay > 0:
                time.sleep(delay)
        env.step()
    env.run(until=sc["duration"])
    net.finish()
    metrics = net.metrics()
    emit({"type": "done", "t": sc["duration"], "metrics": metrics})
    return metrics


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _write(event: dict) -> None:
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Network queueing simulation (scenario JSON on stdin).")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--validate", action="store_true")
    mode.add_argument("--stream", action="store_true")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--start", type=float, default=0.0, help="streaming: begin playback at this simulated time")
    args = parser.parse_args(argv)
    try:
        raw = json.loads(sys.stdin.read(1 << 20) or "null")
    except json.JSONDecodeError as exc:
        print(f"invalid scenario: not JSON ({exc})", file=sys.stderr)
        return 1
    try:
        if args.validate:
            sc = validate(raw)
            peak = sum(peak_rate(f) for f in sc["flows"].values())
            _write({"ok": True, "nodes": len(sc["nodes"]), "links": len(sc["links"]), "flows": len(sc["flows"]),
                    "offered_packets": round(peak * sc["duration"]), "peak_rate": peak})
        elif args.stream:
            stream_replication(raw, args.seed, args.speed, _write, start=args.start)
        else:
            _write(run_replication(raw, args.seed))
    except ScenarioError as exc:
        print(f"invalid scenario: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        try:
            sys.stdout = open(os.devnull, "w")
        except OSError:
            pass
        return 0
    except Exception as exc:  # noqa: BLE001 - any failure must map to exit 1
        print(f"simulation failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
