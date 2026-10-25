// Network scenarios (sim/netsim.py) and the live network stream.

export type NodeKind = "host" | "router";

export interface NetNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  service_rate?: number; // routers: packets/s
  buffer?: number; // routers: packets
}

export interface NetLink {
  id: string;
  a: string;
  b: string;
  bandwidth: number; // packets/s per direction
  delay: number; // seconds
  buffer: number; // packets per direction
}

export type FlowPattern =
  | { type: "constant" }
  | { type: "schedule"; points: Array<{ t: number; rate: number }>; interpolate: "step" | "linear" }
  | { type: "onoff"; on_mean: number; off_mean: number };

export interface Flow {
  id: string;
  src: string;
  dst: string;
  rate: number;
  pattern: FlowPattern;
}

export interface NetEvent {
  t: number;
  target: string;
  action: "down" | "up";
}

export interface Scenario {
  duration: number;
  nodes: NetNode[];
  links: NetLink[];
  flows: Flow[];
  events: NetEvent[];
}

// Mirrors netsim.py's limits.
export const LIMITS = { nodes: 60, links: 120, flows: 40, events: 60, duration: 3600, offered: 150_000, streamRate: 150 };
export const FLOW_COLORS = 8; // categorical slots; later flows fold into gray

export function flowSlot(index: number): string {
  return index < FLOW_COLORS ? `var(--flow-${index})` : "var(--flow-other)";
}

export function peakRate(flow: Flow): number {
  return flow.pattern.type === "schedule" ? Math.max(0, ...flow.pattern.points.map((p) => p.rate)) : flow.rate;
}

export function offeredPackets(sc: Scenario): number {
  return sc.flows.reduce((sum, f) => sum + peakRate(f), 0) * sc.duration;
}

export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 1; ; i += 1) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export function allIds(sc: Scenario): string[] {
  return [...sc.nodes.map((n) => n.id), ...sc.links.map((l) => l.id)];
}

/** Client-side checks; the node re-validates with the simulator itself. */
export function checkScenario(sc: Scenario): string[] {
  const errors: string[] = [];
  const nodes = new Map(sc.nodes.map((n) => [n.id, n]));
  if (!(sc.duration > 0) || sc.duration > LIMITS.duration) errors.push(`Duration must be between 0 and ${LIMITS.duration} s.`);
  if (sc.nodes.length > LIMITS.nodes) errors.push(`At most ${LIMITS.nodes} hosts and routers.`);
  if (sc.links.length > LIMITS.links) errors.push(`At most ${LIMITS.links} links.`);
  if (sc.flows.length === 0) errors.push("Add at least one flow (a host sending to another host).");
  if (sc.flows.length > LIMITS.flows) errors.push(`At most ${LIMITS.flows} flows.`);
  for (const r of sc.nodes.filter((n) => n.kind === "router")) {
    if (!((r.service_rate ?? 0) > 0)) errors.push(`Router ${r.id}: service rate must be greater than zero.`);
    if (!((r.buffer ?? 0) >= 1)) errors.push(`Router ${r.id}: buffer must be at least 1.`);
  }
  for (const l of sc.links) {
    if (!(l.bandwidth > 0)) errors.push(`Link ${l.id}: bandwidth must be greater than zero.`);
    if (!(l.delay >= 0)) errors.push(`Link ${l.id}: delay cannot be negative.`);
    if (!(l.buffer >= 1)) errors.push(`Link ${l.id}: buffer must be at least 1.`);
  }
  for (const f of sc.flows) {
    if (nodes.get(f.src)?.kind !== "host" || nodes.get(f.dst)?.kind !== "host") errors.push(`Flow ${f.id}: source and destination must be hosts.`);
    else if (f.src === f.dst) errors.push(`Flow ${f.id}: source and destination must differ.`);
    if (f.pattern.type === "schedule") {
      if (f.pattern.points.length === 0 || peakRate(f) <= 0) errors.push(`Flow ${f.id}: the schedule needs at least one point with a rate above zero.`);
    } else if (!(f.rate > 0)) errors.push(`Flow ${f.id}: rate must be greater than zero.`);
    if (f.pattern.type === "onoff" && !(f.pattern.on_mean > 0 && f.pattern.off_mean > 0)) errors.push(`Flow ${f.id}: on and off times must be greater than zero.`);
  }
  for (const e of sc.events) {
    const isLink = sc.links.some((l) => l.id === e.target);
    if (!isLink && nodes.get(e.target)?.kind !== "router") errors.push(`Failure at t=${e.t}: pick a link or router.`);
    if (!(e.t >= 0 && e.t <= sc.duration)) errors.push(`Failure on ${e.target}: time must be within the run.`);
  }
  const offered = offeredPackets(sc);
  if (offered > LIMITS.offered) errors.push(`Too much traffic for one run (about ${Math.round(offered).toLocaleString()} packets, limit ${LIMITS.offered.toLocaleString()}); lower the rates or the duration.`);
  return errors;
}

/** The scenario as sent to the nodes. Positions are kept so a run can be redrawn. */
export function toWire(sc: Scenario): Scenario {
  return {
    duration: sc.duration,
    nodes: sc.nodes.map((n) => (n.kind === "router" ? { ...n } : { id: n.id, kind: n.kind, x: n.x, y: n.y })),
    links: sc.links.map((l) => ({ ...l })),
    flows: sc.flows.map((f) => ({ ...f })),
    events: [...sc.events].sort((a, b) => a.t - b.t),
  };
}

export function parseScenario(raw: unknown): Scenario | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<Scenario>;
  if (!Array.isArray(s.nodes) || !Array.isArray(s.links) || typeof s.duration !== "number") return null;
  return {
    duration: s.duration,
    nodes: s.nodes.map((n, i) => ({ ...n, x: Number.isFinite(n.x) ? n.x : 100 + (i % 8) * 110, y: Number.isFinite(n.y) ? n.y : 100 + Math.floor(i / 8) * 110 })),
    links: s.links,
    flows: Array.isArray(s.flows) ? s.flows.map((f) => ({ ...f, pattern: f.pattern ?? { type: "constant" } })) : [],
    events: Array.isArray(s.events) ? s.events : [],
  };
}

// ---------------------------------------------------------------------------
// Sample networks
// ---------------------------------------------------------------------------

const host = (id: string, x: number, y: number): NetNode => ({ id, kind: "host", x, y });
const router = (id: string, x: number, y: number, service_rate = 120, buffer = 50): NetNode => ({ id, kind: "router", x, y, service_rate, buffer });
const link = (id: string, a: string, b: string, bandwidth = 100, delay = 0.005, buffer = 50): NetLink => ({ id, a, b, bandwidth, delay, buffer });

export const SAMPLES: Array<{ id: string; label: string; scenario: Scenario }> = [
  {
    id: "dumbbell",
    label: "Dumbbell with backup path",
    scenario: {
      duration: 300,
      nodes: [host("h1", 120, 170), host("h2", 120, 450), router("r1", 330, 310), router("r3", 500, 500, 80), router("r2", 670, 310), host("h3", 880, 170), host("h4", 880, 450)],
      links: [link("l1", "h1", "r1"), link("l2", "h2", "r1"), link("l3", "r1", "r2", 60, 0.01), link("l4", "r1", "r3", 60, 0.02), link("l5", "r3", "r2", 60, 0.02), link("l6", "r2", "h3"), link("l7", "r2", "h4")],
      flows: [
        { id: "f1", src: "h1", dst: "h3", rate: 20, pattern: { type: "constant" } },
        { id: "f2", src: "h2", dst: "h4", rate: 10, pattern: { type: "schedule", interpolate: "step", points: [{ t: 0, rate: 10 }, { t: 100, rate: 40 }, { t: 200, rate: 10 }] } },
        { id: "f3", src: "h1", dst: "h4", rate: 15, pattern: { type: "onoff", on_mean: 5, off_mean: 5 } },
      ],
      events: [{ t: 150, target: "l3", action: "down" }, { t: 220, target: "l3", action: "up" }],
    },
  },
  {
    id: "campus",
    label: "Campus: core, access, server",
    scenario: {
      duration: 240,
      nodes: [
        router("core1", 400, 240, 300, 80), router("core2", 600, 240, 300, 80),
        router("acc1", 200, 420, 120), router("acc2", 500, 440, 120), router("acc3", 800, 420, 120),
        host("srv", 500, 70), host("lab1", 110, 560), host("lab2", 290, 560), host("dorm1", 430, 580), host("dorm2", 570, 580), host("lib1", 710, 560), host("lib2", 890, 560),
      ],
      links: [
        link("up1", "srv", "core1", 300, 0.001), link("up2", "srv", "core2", 300, 0.001), link("core", "core1", "core2", 300, 0.001),
        link("a1c1", "acc1", "core1", 120, 0.002), link("a2c1", "acc2", "core1", 120, 0.002), link("a2c2", "acc2", "core2", 120, 0.002), link("a3c2", "acc3", "core2", 120, 0.002),
        link("e1", "lab1", "acc1"), link("e2", "lab2", "acc1"), link("e3", "dorm1", "acc2"), link("e4", "dorm2", "acc2"), link("e5", "lib1", "acc3"), link("e6", "lib2", "acc3"),
      ],
      flows: [
        { id: "lab1", src: "lab1", dst: "srv", rate: 25, pattern: { type: "schedule", interpolate: "linear", points: [{ t: 0, rate: 5 }, { t: 120, rate: 45 }, { t: 240, rate: 5 }] } },
        { id: "lab2", src: "lab2", dst: "srv", rate: 20, pattern: { type: "constant" } },
        { id: "dorm", src: "dorm1", dst: "srv", rate: 40, pattern: { type: "onoff", on_mean: 3, off_mean: 4 } },
        { id: "dorm2", src: "dorm2", dst: "lib2", rate: 10, pattern: { type: "constant" } },
        { id: "lib", src: "lib1", dst: "srv", rate: 15, pattern: { type: "constant" } },
        { id: "reply", src: "srv", dst: "lab2", rate: 30, pattern: { type: "constant" } },
      ],
      events: [{ t: 90, target: "core1", action: "down" }, { t: 150, target: "core1", action: "up" }],
    },
  },
  {
    id: "ring",
    label: "Ring backbone with a cut",
    scenario: {
      duration: 300,
      nodes: [
        router("A", 500, 110), router("B", 760, 220), router("C", 760, 440), router("D", 500, 550), router("E", 240, 440), router("F", 240, 220),
        host("nyc", 500, 20), host("lon", 920, 330), host("tok", 500, 640), host("syd", 80, 330),
      ],
      links: [
        link("AB", "A", "B", 80, 0.02), link("BC", "B", "C", 80, 0.02), link("CD", "C", "D", 80, 0.02), link("DE", "D", "E", 80, 0.02), link("EF", "E", "F", 80, 0.02), link("FA", "F", "A", 80, 0.02),
        link("nycA", "nyc", "A", 200, 0.001), link("lonBC", "lon", "B", 200, 0.001), link("tokD", "tok", "D", 200, 0.001), link("sydE", "syd", "E", 200, 0.001),
      ],
      flows: [
        { id: "nyc-tok", src: "nyc", dst: "tok", rate: 30, pattern: { type: "constant" } },
        { id: "lon-syd", src: "lon", dst: "syd", rate: 25, pattern: { type: "constant" } },
        { id: "tok-lon", src: "tok", dst: "lon", rate: 15, pattern: { type: "onoff", on_mean: 8, off_mean: 4 } },
      ],
      events: [{ t: 100, target: "CD", action: "down" }, { t: 200, target: "CD", action: "up" }],
    },
  },
];

export function cloneScenario(sc: Scenario): Scenario {
  return JSON.parse(JSON.stringify(sc)) as Scenario;
}

// ---------------------------------------------------------------------------
// Live stream (netsim.py --stream)
// ---------------------------------------------------------------------------

export interface FlowLive { sent: number; delivered: number; dropped: number; mean_delay: number | null }

export type NetStreamEvent =
  | { type: "meta"; seed: number; speed: number; duration: number; start?: number; routes: Record<string, string[]> }
  | { type: "seek"; t: number; down: string[]; routes: Record<string, string[]>; links: Record<string, { util: number; queue: number }>; routers: Record<string, { util: number; queue: number }>; flows: Record<string, FlowLive> }
  | { type: "send"; t: number; pkt: number; flow: string; at: string }
  | { type: "hop"; t: number; pkt: number; flow: string; link: string; from: string; to: string }
  | { type: "deliver"; t: number; pkt: number; flow: string; delay: number }
  | { type: "drop"; t: number; pkt: number; flow: string; at: string; reason: string }
  | { type: "failure"; t: number; target: string; action: "down" | "up"; routes: Record<string, string[]> }
  | { type: "stats"; t: number; links: Record<string, { util: number; queue: number }>; routers: Record<string, { util: number; queue: number }>; flows: Record<string, FlowLive> }
  | { type: "done"; t: number; metrics: unknown }
  | { type: "error"; message: string };

export interface MovingPacket { pkt: number; flow: string; from: string; to: string; start: number }
export interface DropMark { at: string; reason: string; start: number }

export interface NetLiveState {
  meta: Extract<NetStreamEvent, { type: "meta" }> | null;
  clock: number;
  moving: MovingPacket[];
  drops: DropMark[];
  links: Record<string, { util: number; queue: number }>;
  routers: Record<string, { util: number; queue: number }>;
  flows: Record<string, FlowLive>;
  down: string[];
  routes: Record<string, string[]>;
  throughput: Array<{ t: number; v: number }>;
  feed: string[];
  done: boolean;
  error: string | null;
}

export const initialLive: NetLiveState = {
  meta: null, clock: 0, moving: [], drops: [], links: {}, routers: {}, flows: {}, down: [], routes: {},
  throughput: [], feed: [], done: false, error: null,
};

export const HOP_MS = 450;
export const DROP_MS = 700;
const MAX_MOVING = 400;

const dropLabels: Record<string, string> = {
  link_buffer: "link buffer full", router_buffer: "router buffer full", link_down: "link down",
  router_down: "router down", no_route: "no route",
};

export function applyNetEvents(state: NetLiveState, events: NetStreamEvent[], now: number): NetLiveState {
  let s: NetLiveState = { ...state, moving: state.moving.filter((p) => now - p.start < HOP_MS), drops: state.drops.filter((d) => now - d.start < DROP_MS) };
  if (events.length === 0) return s.moving.length === state.moving.length && s.drops.length === state.drops.length ? state : s;
  const feed = [...s.feed];
  const log = (t: number, text: string) => feed.push(`${t.toFixed(2).padStart(8)}  ${text}`);
  for (const e of events) {
    switch (e.type) {
      case "meta":
        s = { ...initialLive, meta: e, routes: e.routes, clock: e.start ?? 0 };
        feed.length = 0;
        break;
      case "seek":
        s = { ...s, clock: e.t, down: e.down, routes: e.routes, links: e.links, routers: e.routers, flows: e.flows, throughput: [] };
        if (e.down.length) log(e.t, `jumped here · down: ${e.down.join(", ")}`);
        break;
      case "hop":
        s.moving.push({ pkt: e.pkt, flow: e.flow, from: e.from, to: e.to, start: now });
        s.clock = e.t;
        break;
      case "send":
      case "deliver":
        s.clock = e.t;
        break;
      case "drop":
        s.drops.push({ at: e.at, reason: e.reason, start: now });
        s.clock = e.t;
        break;
      case "failure": {
        s.down = e.action === "down" ? [...new Set([...s.down, e.target])] : s.down.filter((d) => d !== e.target);
        s.routes = e.routes;
        s.clock = e.t;
        const unreachable = Object.entries(e.routes).filter(([, path]) => path.length === 0).map(([f]) => f);
        log(e.t, `${e.target} ${e.action === "down" ? "FAILED" : "restored"} · routes recomputed${unreachable.length ? ` · no route for ${unreachable.join(", ")}` : ""}`);
        break;
      }
      case "stats": {
        const prev = s.flows;
        const delivered = Object.values(e.flows).reduce((sum, f) => sum + f.delivered, 0);
        const prevDelivered = Object.values(prev).reduce((sum, f) => sum + f.delivered, 0);
        const dt = e.t - s.clock || (s.meta ? s.meta.speed * 0.25 : 1);
        const lastT = s.throughput.length ? s.throughput[s.throughput.length - 1].t : 0;
        s.throughput = [...s.throughput, { t: e.t, v: Math.max(0, (delivered - prevDelivered) / Math.max(1e-9, e.t - lastT || dt)) }];
        for (const [fid, f] of Object.entries(e.flows)) {
          const before = prev[fid];
          if (before && f.dropped > before.dropped) log(e.t, `${fid}: ${f.dropped - before.dropped} dropped`);
        }
        s.links = e.links;
        s.routers = e.routers;
        s.flows = e.flows;
        s.clock = e.t;
        break;
      }
      case "done":
        s.done = true;
        s.clock = e.t;
        log(e.t, "run finished");
        break;
      case "error":
        s.error = e.message;
        s.done = true;
        break;
    }
  }
  if (s.moving.length > MAX_MOVING) s.moving = s.moving.slice(-MAX_MOVING);
  s.feed = feed.slice(-14);
  return s;
}

export function dropLabel(reason: string): string {
  return dropLabels[reason] ?? reason;
}

/** Playback speeds the live view can draw for this scenario (peak packets/s x speed <= limit). */
export function playbackSpeeds(sc: Scenario): number[] {
  const peak = sc.flows.reduce((sum, f) => sum + peakRate(f), 0);
  const max = peak > 0 ? LIMITS.streamRate / peak : 20;
  const options = [0.25, 0.5, 1, 2, 5, 10, 20].filter((v) => v <= max + 1e-9);
  return options.length ? options : [Math.floor(max * 100) / 100];
}
