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
    netsim.py --plan --parts K         -> deterministic partition plan or exit 1
    netsim.py --partition              -> JSON-lines open/step/finish worker
    netsim.py --merge                  -> merge partition metric states from stdin
    netsim.py --seed N                 -> one JSON line: seed, runtime_seconds, metrics
    netsim.py --stream --seed N --speed S
                                       -> one JSON event per line, paced in real time

Same contract as simulate.py: stdout carries only JSON, diagnostics go to
stderr, exit 0 on success and 1 on invalid input or failure.
"""

from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import os
import random
import sys
import time
from collections import deque
from dataclasses import dataclass
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


@dataclass(frozen=True)
class ArrivalRecord:
    flow: str
    seq: int
    born: float
    link: str
    source: str
    target: str
    start: float
    arrive: float

    def as_dict(self) -> dict:
        return {
            "flow": self.flow,
            "seq": self.seq,
            "born": self.born,
            "link": self.link,
            "from": self.source,
            "to": self.target,
            "start": self.start,
            "arrive": self.arrive,
        }

    def order_key(self) -> tuple[float, str, str, int]:
        return self.arrive, self.link, self.flow, self.seq


def _entity_rng(seed: int, kind: str, entity_id: str) -> random.Random:
    key = f"{seed}:{kind}:{entity_id}".encode()
    stream_seed = int.from_bytes(hashlib.sha256(key).digest()[:8], "big")
    return random.Random(stream_seed)


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


def validate(raw: Any, *, partitioned: bool = False) -> dict:
    """Checks a scenario and returns a normalized copy (defaults filled in)."""
    if not isinstance(raw, dict):
        raise ScenarioError("scenario must be a JSON object")
    duration = _num(raw, "duration", "scenario", maximum=MAX_DURATION)
    nodes_raw, links_raw = raw.get("nodes"), raw.get("links")
    flows_raw, events_raw = raw.get("flows", []), raw.get("events", [])
    limits = (("nodes", 2_000), ("links", 6_000), ("flows", 400), ("events", 200)) if partitioned else (
        ("nodes", MAX_NODES), ("links", MAX_LINKS), ("flows", MAX_FLOWS), ("events", MAX_EVENTS))
    for name, limit in limits:
        value = {"nodes": nodes_raw, "links": links_raw, "flows": flows_raw, "events": events_raw}[name]
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
    offered_limit = 2_000_000 if partitioned else MAX_OFFERED_PACKETS
    if offered > offered_limit:
        raise ScenarioError(
            f"too much traffic for one replication: about {offered:,.0f} packets at peak "
            f"(limit {offered_limit:,}); lower the rates or the duration")

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


def partition_plan(sc: dict, parts: int) -> dict:
    """Build a deterministic router partition plan for a normalized scenario."""
    if isinstance(parts, bool) or not isinstance(parts, int) or parts < 1:
        raise ScenarioError("parts must be a positive integer")
    routers = sorted(nid for nid, node in sc["nodes"].items() if node["kind"] == "router")
    if not routers:
        raise ScenarioError("partition planning requires at least one router")
    if parts > len(routers):
        raise ScenarioError(f"parts ({parts}) exceeds the router count ({len(routers)})")

    adjacency: dict[str, list[tuple[str, float, str]]] = {rid: [] for rid in routers}
    attached_hosts: dict[str, list[tuple[float, str]]] = {
        nid: [] for nid, node in sc["nodes"].items() if node["kind"] == "host"
    }
    for link in sc["links"].values():
        latency = 1.0 / link["bandwidth"] + link["delay"]
        a_kind, b_kind = sc["nodes"][link["a"]]["kind"], sc["nodes"][link["b"]]["kind"]
        if a_kind == b_kind == "router":
            adjacency[link["a"]].append((link["b"], latency, link["id"]))
            adjacency[link["b"]].append((link["a"], latency, link["id"]))
        elif a_kind == "host" and b_kind == "router":
            attached_hosts[link["a"]].append((latency, link["b"]))
        elif a_kind == "router" and b_kind == "host":
            attached_hosts[link["b"]].append((latency, link["a"]))
    for edges in adjacency.values():
        edges.sort(key=lambda edge: (edge[1], edge[0], edge[2]))

    def hop_distances(start: str) -> dict[str, int]:
        distances = {start: 0}
        queue = deque([start])
        while queue:
            current = queue.popleft()
            for neighbor, _, _ in adjacency[current]:
                if neighbor not in distances:
                    distances[neighbor] = distances[current] + 1
                    queue.append(neighbor)
        return distances

    seeds = [routers[0]]
    seed_distances = [hop_distances(seeds[0])]
    while len(seeds) < parts:
        remaining = [rid for rid in routers if rid not in seeds]
        seed = min(
            remaining,
            key=lambda rid: (
                -min((dist.get(rid, math.inf) for dist in seed_distances), default=math.inf),
                rid,
            ),
        )
        seeds.append(seed)
        seed_distances.append(hop_distances(seed))

    regions = [[seed] for seed in seeds]
    owner = {seed: part for part, seed in enumerate(seeds)}
    while len(owner) < len(routers):
        part = min(range(parts), key=lambda index: (len(regions[index]), index))
        frontier = [
            (latency, neighbor, link_id, current)
            for current in regions[part]
            for neighbor, latency, link_id in adjacency[current]
            if neighbor not in owner
        ]
        if frontier:
            _, selected, _, _ = min(frontier)
        else:
            selected = min(rid for rid in routers if rid not in owner)
        owner[selected] = part
        regions[part].append(selected)

    assignment = dict(owner)
    for host, neighbors in attached_hosts.items():
        assignment[host] = assignment[min(neighbors)[1]] if neighbors else 0

    cut_links = sorted(
        link["id"] for link in sc["links"].values()
        if assignment[link["a"]] != assignment[link["b"]]
    )
    if cut_links:
        lookahead = min(
            1.0 / sc["links"][lid]["bandwidth"] + sc["links"][lid]["delay"]
            for lid in cut_links
        )
    else:
        lookahead = sc["duration"]
    windows = math.ceil(sc["duration"] / lookahead)
    if windows > 200_000:
        raise ScenarioError(
            "partition plan exceeds 200000 windows; increase link delays on links between regions or shorten the run"
        )
    return {
        "ok": True,
        "parts": parts,
        "assignment": {nid: assignment[nid] for nid in sorted(assignment)},
        "cut_links": cut_links,
        "lookahead": lookahead,
        "windows": windows,
        "load": [len(region) for region in regions],
    }


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
                 stats_every: float | None = None, assignment: dict[str, int] | None = None,
                 part: int = 0):
        self.sc, self.env, self.emit = sc, env, emit
        self.seed = seed
        self.assignment = assignment or {nid: 0 for nid in sc["nodes"]}
        self.part = part
        self.duration = sc["duration"]
        self.bin_width = self.duration / BINS
        self.down: set[str] = set()
        self.routes = compute_routes(sc, self.down)
        self.routers = {nid: Station(env, n["buffer"], self.duration)
                        for nid, n in sc["nodes"].items() if n["kind"] == "router"}
        self.router_rngs = {rid: _entity_rng(seed, "router", rid) for rid in self.routers}
        self.links = {}
        for lid, link in sc["links"].items():
            self.links[(lid, link["a"])] = Station(env, link["buffer"], self.duration)  # transmitting from a
            self.links[(lid, link["b"])] = Station(env, link["buffer"], self.duration)
        self.flow_stats = {fid: {"sent": 0, "delivered": 0, "dropped": 0, "delays": [],
                                 "drops": {}} for fid in sc["flows"]}
        self.bins = {"delivered": [0] * BINS, "dropped": [0] * BINS, "delay_sum": [0.0] * BINS,
                     "delay_values": [[] for _ in range(BINS)],
                     "flows": {fid: [0] * BINS for fid in sc["flows"]}}
        self.packet_id = 0
        self.flow_sequences = {fid: 0 for fid in sc["flows"]}
        self.outbound: list[ArrivalRecord] = []
        self.event_count = 0
        self.stats_every = stats_every

    # -- helpers ----------------------------------------------------------
    def _bin(self, t: float) -> int:
        return min(BINS - 1, int(t / self.bin_width))

    def _send(self, event: dict) -> None:
        self.event_count += 1
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
        rng = _entity_rng(self.seed, "flow", flow["id"])
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
        fid = flow["id"]
        self.flow_sequences[fid] += 1
        self.flow_stats[fid]["sent"] += 1
        self.env.process(self.packet(self.packet_id, self.flow_sequences[fid], flow))

    # -- packet life ------------------------------------------------------
    def _traverse_link(self, pkt: int, seq: int, born: float, flow: dict, source: str):
        """Transmit one hop and produce its receiver-facing arrival record."""
        env, fid = self.env, flow["id"]
        lid = self.routes[source].get(flow["dst"])
        if lid is None:
            self._drop(pkt, fid, source, "no_route")
            return None
        link = self.sc["links"][lid]
        target = link["b"] if link["a"] == source else link["a"]
        station = self.links[(lid, source)]
        if station.in_system >= station.capacity:
            station.drops += 1
            self._drop(pkt, fid, lid, "link_buffer")
            return None
        epoch = station.epoch
        cross_partition = self.assignment[target] != self.part
        station.enter()
        with station.server.request() as req:
            yield req
            if station.epoch != epoch:
                station.leave()
                self._drop(pkt, fid, lid, "link_down")
                return None
            start = env.now
            tx = 1.0 / link["bandwidth"]
            arrival = ArrivalRecord(
                flow=fid, seq=seq, born=born,
                link=lid, source=source, target=target, start=start,
                arrive=start + tx + link["delay"],
            )
            if cross_partition:
                self.outbound.append(arrival)
            self._send({"type": "hop", "t": round(start, 4), "pkt": pkt, "flow": fid, "link": lid,
                        "from": source, "to": target})
            yield env.timeout(tx)
            station.busy += tx
            station.window_busy += tx
        station.leave()
        station.packets += 1
        if cross_partition:
            return None
        if link["delay"] > 0:
            yield env.timeout(link["delay"])
        if station.epoch != epoch or lid in self.down:
            self._drop(pkt, fid, lid, "link_down")
            return None
        return arrival

    def _receive_arrival(self, pkt: int, arrival: ArrivalRecord, flow: dict):
        """Process a packet at its receiving router; return False when dropped."""
        node, fid = arrival.target, flow["id"]
        if node == flow["dst"]:
            return True
        router = self.routers.get(node)
        if router is None:
            self._drop(pkt, fid, node, "no_route")
            return False
        if node in self.down:
            self._drop(pkt, fid, node, "router_down")
            return False
        if router.in_system >= router.capacity:
            router.drops += 1
            self._drop(pkt, fid, node, "router_buffer")
            return False
        epoch = router.epoch
        router.enter()
        with router.server.request() as req:
            yield req
            if router.epoch != epoch:
                router.leave()
                self._drop(pkt, fid, node, "router_down")
                return False
            service = self.router_rngs[node].expovariate(self.sc["nodes"][node]["service_rate"])
            yield self.env.timeout(service)
            router.busy += service
            router.window_busy += service
        router.leave()
        router.packets += 1
        if router.epoch != epoch:
            self._drop(pkt, fid, node, "router_down")
            return False
        return True

    def packet(self, pkt: int, seq: int, flow: dict):
        born = self.env.now
        node = flow["src"]
        self._send({"type": "send", "t": round(born, 4), "pkt": pkt, "flow": flow["id"], "at": node})
        yield from self._route_packet(pkt, seq, born, flow, node)

    def _route_packet(self, pkt: int, seq: int, born: float, flow: dict, node: str):
        env, fid, dst = self.env, flow["id"], flow["dst"]
        hops = 0
        while node != dst:
            hops += 1
            if hops > 64:
                self._drop(pkt, fid, node, "no_route")
                return
            arrival = yield from self._traverse_link(pkt, seq, born, flow, node)
            if arrival is None:
                return
            node = arrival.target
            if node == dst:
                break
            if not (yield from self._receive_arrival(pkt, arrival, flow)):
                return
        delay = env.now - born
        st = self.flow_stats[fid]
        st["delivered"] += 1
        st["delays"].append(delay)
        b = self._bin(env.now)
        self.bins["delivered"][b] += 1
        self.bins["delay_sum"][b] += delay
        self.bins["delay_values"][b].append((env.now, fid, seq, delay))
        self.bins["flows"][fid][b] += 1
        self._send({"type": "deliver", "t": round(env.now, 4), "pkt": pkt, "flow": fid, "delay": round(delay, 4)})

    def _link_failed_during(self, record: ArrivalRecord) -> bool:
        if record.link in self.down:
            return True
        return any(
            event["target"] == record.link and event["action"] == "down"
            and record.start < event["t"] <= record.arrive
            for event in self.sc["events"]
        )

    def inject_arrival(self, record: ArrivalRecord):
        if record.arrive < self.env.now:
            raise ScenarioError(
                f"inbound arrival for {record.flow}/{record.seq} at {record.arrive} precedes current time {self.env.now}"
            )
        yield self.env.timeout(record.arrive - self.env.now)
        if self._link_failed_during(record):
            self._drop(record.seq, record.flow, record.link, "link_down")
            return
        flow = self.sc["flows"][record.flow]
        if record.target != flow["dst"] and not (
            yield from self._receive_arrival(record.seq, record, flow)
        ):
            return
        yield from self._route_packet(record.seq, record.seq, record.born, flow, record.target)

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
            if self.assignment[flow["src"]] == self.part:
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

    def partition_state(self) -> dict:
        station = lambda value: {  # noqa: E731
            "busy": value.busy, "area": value.area, "packets": value.packets, "drops": value.drops,
        }
        return {
            "flows": self.flow_stats,
            "bins": self.bins,
            "links": {
                lid: {link["a"]: station(self.links[(lid, link["a"])]),
                      link["b"]: station(self.links[(lid, link["b"])])}
                for lid, link in self.sc["links"].items()
            },
            "routers": {rid: station(value) for rid, value in self.routers.items()},
        }


def merge_partition_states(scenario: Any, states: Any) -> dict:
    """Merge worker-owned raw counters before applying the normal metric rounding."""
    sc = validate(scenario, partitioned=True)
    if not isinstance(states, list) or not states:
        raise ScenarioError("merge requires at least one partition state")
    env = simpy.Environment()
    merged = Network(sc, 0, env)
    delay_values = [[] for _ in range(BINS)]
    for state in states:
        if not isinstance(state, dict):
            raise ScenarioError("partition state must be an object")
        for fid, flow in state.get("flows", {}).items():
            if fid not in merged.flow_stats:
                raise ScenarioError(f"partition state has unknown flow {fid!r}")
            target = merged.flow_stats[fid]
            target["sent"] += flow["sent"]
            target["delivered"] += flow["delivered"]
            target["dropped"] += flow["dropped"]
            target["delays"].extend(flow["delays"])
            for reason, count in flow["drops"].items():
                target["drops"][reason] = target["drops"].get(reason, 0) + count
        bins = state.get("bins", {})
        for key in ("delivered", "dropped"):
            merged.bins[key] = [a + b for a, b in zip(merged.bins[key], bins[key])]
        for index, values in enumerate(bins["delay_values"]):
            delay_values[index].extend(values)
        for fid, values in bins["flows"].items():
            merged.bins["flows"][fid] = [a + b for a, b in zip(merged.bins["flows"][fid], values)]
        for lid, link in state.get("links", {}).items():
            if lid not in merged.sc["links"]:
                raise ScenarioError(f"partition state has unknown link {lid!r}")
            for endpoint, values in link.items():
                station = merged.links.get((lid, endpoint))
                if station is None:
                    raise ScenarioError(f"partition state has invalid endpoint {endpoint!r} for link {lid!r}")
                station.busy += values["busy"]
                station.area += values["area"]
                station.packets += values["packets"]
                station.drops += values["drops"]
        for rid, values in state.get("routers", {}).items():
            station = merged.routers.get(rid)
            if station is None:
                raise ScenarioError(f"partition state has unknown router {rid!r}")
            station.busy += values["busy"]
            station.area += values["area"]
            station.packets += values["packets"]
            station.drops += values["drops"]
    for index, values in enumerate(delay_values):
        values.sort(key=lambda value: (value[0], value[1], value[2]))
        merged.bins["delay_sum"][index] = sum(value[3] for value in values)
    return merged.metrics()


class PartitionWorker:
    """Stateful one-partition worker used by the JSON-lines protocol."""

    def __init__(self, scenario: Any, plan: dict, part: int, seed: int):
        self.sc = validate(scenario, partitioned=True)
        if not isinstance(plan, dict) or plan.get("ok") is not True:
            raise ScenarioError("plan must be a successful partition plan")
        parts = plan.get("parts")
        assignment = plan.get("assignment")
        if isinstance(parts, bool) or not isinstance(parts, int) or not isinstance(assignment, dict):
            raise ScenarioError("plan has invalid parts or assignment")
        if isinstance(part, bool) or not isinstance(part, int):
            raise ScenarioError("part must be an integer")
        if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
            raise ScenarioError("seed must be a non-negative integer")
        if not 0 <= part < parts:
            raise ScenarioError(f"part must be in [0, {parts})")
        if set(assignment) != set(self.sc["nodes"]):
            raise ScenarioError("plan assignment must contain every scenario node")
        if any(isinstance(owner, bool) or not isinstance(owner, int) or not 0 <= owner < parts
               for owner in assignment.values()):
            raise ScenarioError("plan assignment contains an invalid partition")
        self.plan, self.part, self.seed = plan, part, seed
        self.env = simpy.Environment()
        self.network = Network(self.sc, seed, self.env, assignment=assignment, part=part)
        self.network.start()
        self.finished = False

    def _record(self, raw: Any) -> ArrivalRecord:
        if not isinstance(raw, dict):
            raise ScenarioError("inbound record must be an object")
        try:
            record = ArrivalRecord(
                flow=raw["flow"], seq=raw["seq"], born=raw["born"], link=raw["link"],
                source=raw["from"], target=raw["to"], start=raw["start"], arrive=raw["arrive"],
            )
        except (KeyError, TypeError) as exc:
            raise ScenarioError("inbound record is missing a required field") from exc
        if not isinstance(record.flow, str) or record.flow not in self.sc["flows"]:
            raise ScenarioError("inbound record has an unknown flow")
        if isinstance(record.seq, bool) or not isinstance(record.seq, int) or record.seq < 1:
            raise ScenarioError("inbound sequence number must be a positive integer")
        times = (record.born, record.start, record.arrive)
        if any(isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) for t in times):
            raise ScenarioError("inbound record times must be finite numbers")
        if record.born < 0 or record.start < record.born or record.arrive <= record.start:
            raise ScenarioError("inbound record times must satisfy 0 <= born <= start < arrive")
        link = self.sc["links"].get(record.link)
        if link is None or (record.source, record.target) not in (
            (link["a"], link["b"]), (link["b"], link["a"])
        ):
            raise ScenarioError("inbound record endpoints do not match its link")
        if not isinstance(record.target, str) or record.target not in self.sc["nodes"]:
            raise ScenarioError("inbound record has an unknown target")
        if record.arrive < record.start + 1 / link["bandwidth"] + link["delay"] - 1e-12:
            raise ScenarioError("inbound record arrives before link transmission and propagation complete")
        if self.plan["assignment"][record.target] != self.part:
            raise ScenarioError("inbound record is addressed to a different partition")
        return record

    def step(self, until: Any, inbound: Any) -> dict:
        if self.finished:
            raise ScenarioError("worker is already finished")
        if isinstance(until, bool) or not isinstance(until, (int, float)) or not math.isfinite(until):
            raise ScenarioError("step until must be a finite number")
        if until <= self.env.now or until > self.sc["duration"]:
            raise ScenarioError(f"step until must be greater than {self.env.now} and <= run duration")
        if not isinstance(inbound, list):
            raise ScenarioError("step inbound must be a list")
        records = [self._record(item) for item in inbound]
        records.sort(key=ArrivalRecord.order_key)
        for record in records:
            if record.arrive < self.env.now:
                raise ScenarioError(
                    f"inbound arrival for {record.flow}/{record.seq} at {record.arrive} "
                    f"is in the worker's past ({self.env.now})"
                )

        self.network.outbound = []
        events_before = self.network.event_count
        for record in records:
            self.env.process(self.network.inject_arrival(record))
        started = time.perf_counter()
        self.env.run(until=float(until))
        compute_s = time.perf_counter() - started
        outbound = sorted(self.network.outbound, key=ArrivalRecord.order_key)
        return {
            "outbound": [record.as_dict() for record in outbound],
            "compute_s": compute_s,
            "events": self.network.event_count - events_before + len(records),
        }

    def finish(self) -> dict:
        if self.finished:
            raise ScenarioError("worker is already finished")
        if self.env.now < self.sc["duration"]:
            raise ScenarioError("worker cannot finish before the run duration")
        self.network.finish()
        self.finished = True
        return {"metrics": self.network.metrics(), "state": self.network.partition_state()}


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
    mode.add_argument("--plan", action="store_true")
    mode.add_argument("--stream", action="store_true")
    mode.add_argument("--partition", action="store_true")
    mode.add_argument("--merge", action="store_true")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--parts", type=int, default=1, help="plan: number of router partitions")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--start", type=float, default=0.0, help="streaming: begin playback at this simulated time")
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
            peak = sum(peak_rate(f) for f in sc["flows"].values())
            _write({"ok": True, "nodes": len(sc["nodes"]), "links": len(sc["links"]), "flows": len(sc["flows"]),
                    "offered_packets": round(peak * sc["duration"]), "peak_rate": peak})
        elif args.plan:
            _write(partition_plan(validate(raw, partitioned=True), args.parts))
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
                    request.get("scenario"), request.get("plan"), request.get("part"), request.get("seed")
                )
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


if __name__ == "__main__":
    sys.exit(main())
