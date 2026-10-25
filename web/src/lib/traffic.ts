import { seededRandom } from "./stats";

// Event stream of simulate.py --stream, relayed by the node and gateway.
export interface TrafficParams {
  node: string;
  lambda: number;
  mu: number;
  duration: number;
  speed: number;
  seed: number;
}

export interface TrafficStats {
  t: number;
  arrived: number;
  served: number;
  in_system: number;
  mean_delay: number | null;
  mean_in_system: number;
  utilization: number;
  throughput: number;
}

export type TrafficEvent =
  | { type: "meta"; seed: number; lambda: number; mu: number; duration: number; speed: number; rho: number; theory: { rho: number; W: number; L: number } | null }
  | { type: "arrival"; t: number; id: number; in_system: number }
  | { type: "start"; t: number; id: number; wait: number }
  | { type: "depart"; t: number; id: number; delay: number; in_system: number }
  | ({ type: "stats" } & TrafficStats)
  | ({ type: "done" } & TrafficStats)
  | { type: "error"; message: string };

// Bounds mirror simulate.py / the node.
export const MAX_RHO = 1.5;
export const MAX_DURATION = 3600;
export const MAX_PACKET_RATE = 200;

export function validateTraffic(p: Omit<TrafficParams, "node">): string[] {
  const errors: string[] = [];
  const positive = (v: number) => Number.isFinite(v) && v > 0;
  if (!positive(p.lambda)) errors.push("Arrival rate λ must be greater than zero.");
  if (!positive(p.mu)) errors.push("Service rate μ must be greater than zero.");
  if (positive(p.lambda) && positive(p.mu) && p.lambda / p.mu > MAX_RHO) errors.push(`Load ρ = λ/μ must be at most ${MAX_RHO}.`);
  if (!positive(p.duration) || p.duration > MAX_DURATION) errors.push(`Duration must be between 0 and ${MAX_DURATION}.`);
  if (!positive(p.speed)) errors.push("Speed must be greater than zero.");
  if (positive(p.lambda) && positive(p.speed) && p.lambda * p.speed > MAX_PACKET_RATE) {
    errors.push(`λ × speed must be at most ${MAX_PACKET_RATE} packets per second; lower the speed.`);
  }
  if (!Number.isSafeInteger(p.seed) || p.seed < 0) errors.push("Seed must be a nonnegative whole number.");
  return errors;
}

/** Splits a Server-Sent Events byte stream (as text chunks) into data payloads. */
export function createSseParser(onData: (data: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (data) onData(data);
      boundary = buffer.indexOf("\n\n");
    }
  };
}

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export interface Packet {
  id: number;
  arrivedAt: number;
  wait?: number;
  delay?: number;
  /** Frame in which the packet appeared; it is drawn at the source for that frame. */
  bornFrame: number;
  /** Wall-clock ms when it departed; departed packets fade out, then are dropped. */
  leftAt?: number;
}

export interface Point { t: number; v: number }
export interface DelayPoint { t: number; id: number; delay: number }

export interface TrafficState {
  meta: Extract<TrafficEvent, { type: "meta" }> | null;
  packets: Record<number, Packet>;
  queue: number[]; // waiting packet ids, head first
  serving: number | null;
  leaving: number[];
  inSystem: Point[];
  delays: DelayPoint[];
  meanDelay: Point[];
  stats: TrafficStats | null;
  clock: number;
  feed: string[];
  done: boolean;
  error: string | null;
}

export const initialTraffic: TrafficState = {
  meta: null, packets: {}, queue: [], serving: null, leaving: [], inSystem: [], delays: [], meanDelay: [],
  stats: null, clock: 0, feed: [], done: false, error: null,
};

const MAX_DELAYS = 4000;
const FEED_LENGTH = 12;
export const LEAVE_MS = 600;

const fmt = (t: number) => t.toFixed(2).padStart(8);

/** Applies a batch of events. frame and now (ms) drive the packet animations. */
export function applyEvents(state: TrafficState, events: TrafficEvent[], frame: number, now: number): TrafficState {
  if (events.length === 0) return state;
  const s: TrafficState = {
    ...state,
    packets: { ...state.packets },
    queue: [...state.queue],
    leaving: [...state.leaving],
    inSystem: [...state.inSystem],
    delays: [...state.delays],
    meanDelay: [...state.meanDelay],
    feed: [...state.feed],
  };
  const resolution = (s.meta?.duration ?? 300) / 1500;
  const pushInSystem = (t: number, v: number) => {
    const last = s.inSystem[s.inSystem.length - 1];
    if (last && t - last.t < resolution) s.inSystem[s.inSystem.length - 1] = { t: last.t, v: Math.max(last.v, v) };
    else s.inSystem.push({ t, v });
  };
  const log = (line: string) => s.feed.push(line);

  for (const e of events) {
    switch (e.type) {
      case "meta":
        return applyEvents({ ...initialTraffic, meta: e }, events.slice(events.indexOf(e) + 1), frame, now);
      case "arrival":
        s.packets[e.id] = { id: e.id, arrivedAt: e.t, bornFrame: frame };
        s.queue.push(e.id);
        s.clock = e.t;
        pushInSystem(e.t, e.in_system);
        log(`${fmt(e.t)}  #${e.id} arrived · ${e.in_system} in system`);
        break;
      case "start": {
        s.queue = s.queue.filter((id) => id !== e.id);
        s.serving = e.id;
        const p = s.packets[e.id];
        if (p) s.packets[e.id] = { ...p, wait: e.wait };
        s.clock = e.t;
        log(`${fmt(e.t)}  #${e.id} into service · waited ${e.wait.toFixed(2)}`);
        break;
      }
      case "depart": {
        if (s.serving === e.id) s.serving = null;
        s.queue = s.queue.filter((id) => id !== e.id);
        const p = s.packets[e.id];
        if (p) s.packets[e.id] = { ...p, delay: e.delay, leftAt: now };
        s.leaving.push(e.id);
        s.delays.push({ t: e.t, id: e.id, delay: e.delay });
        s.clock = e.t;
        pushInSystem(e.t, e.in_system);
        log(`${fmt(e.t)}  #${e.id} delivered · delay ${e.delay.toFixed(2)}`);
        break;
      }
      case "stats":
      case "done":
        s.stats = e;
        s.clock = e.t;
        if (e.mean_delay !== null) s.meanDelay.push({ t: e.t, v: e.mean_delay });
        if (e.type === "done") {
          s.done = true;
          log(`${fmt(e.t)}  finished · ${e.served} delivered, ${e.in_system} still queued`);
        }
        break;
      case "error":
        s.error = e.message;
        s.done = true;
        break;
    }
  }
  if (s.delays.length > MAX_DELAYS) s.delays = s.delays.slice(-MAX_DELAYS);
  if (s.feed.length > FEED_LENGTH) s.feed = s.feed.slice(-FEED_LENGTH);
  return s;
}

/** Drops packets whose exit animation has finished. */
export function pruneLeaving(state: TrafficState, now: number): TrafficState {
  const expired = state.leaving.filter((id) => now - (state.packets[id]?.leftAt ?? 0) >= LEAVE_MS);
  if (expired.length === 0) return state;
  const packets = { ...state.packets };
  for (const id of expired) delete packets[id];
  return { ...state, packets, leaving: state.leaving.filter((id) => !expired.includes(id)) };
}

// ---------------------------------------------------------------------------
// Mock stream: the same M/M/1 model, computed in the browser.
// ---------------------------------------------------------------------------

export function generateTraffic(p: Omit<TrafficParams, "node">): TrafficEvent[] {
  const random = seededRandom(p.seed);
  const exp = (rate: number) => -Math.log(1 - random()) / rate;
  const rho = p.lambda / p.mu;
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

  type Raw = { t: number; order: number; kind: "arrival" | "start" | "depart"; id: number; arrived: number; wait?: number };
  const raw: Raw[] = [];
  let t = 0;
  let serverFree = 0;
  for (let id = 1; ; id += 1) {
    t += exp(p.lambda);
    if (t > p.duration) break;
    const service = exp(p.mu);
    const start = Math.max(t, serverFree);
    serverFree = start + service;
    raw.push({ t, order: 0, kind: "arrival", id, arrived: t });
    if (start <= p.duration) raw.push({ t: start, order: 1, kind: "start", id, arrived: t, wait: start - t });
    if (serverFree <= p.duration) raw.push({ t: serverFree, order: -1, kind: "depart", id, arrived: t });
  }
  raw.sort((a, b) => a.t - b.t || a.order - b.order || a.id - b.id);

  const events: TrafficEvent[] = [{
    type: "meta", seed: p.seed, lambda: p.lambda, mu: p.mu, duration: p.duration, speed: p.speed, rho: r4(rho),
    theory: rho < 1 ? { rho: r4(rho), W: r4(1 / (p.mu - p.lambda)), L: r4(rho / (1 - rho)) } : null,
  }];
  let inSystem = 0, arrived = 0, served = 0, totalDelay = 0, areaIn = 0, areaBusy = 0, last = 0;
  const statsEvery = p.speed * 0.25;
  let nextStats = statsEvery;
  const advance = (to: number) => {
    areaIn += inSystem * (to - last);
    areaBusy += Math.min(inSystem, 1) * (to - last);
    last = to;
  };
  const stats = (at: number): TrafficStats => ({
    t: r4(at), arrived, served, in_system: inSystem,
    mean_delay: served ? r4(totalDelay / served) : null,
    mean_in_system: at > 0 ? r4(areaIn / at) : 0,
    utilization: at > 0 ? r4(areaBusy / at) : 0,
    throughput: at > 0 ? r4(served / at) : 0,
  });
  for (const e of raw) {
    while (nextStats < e.t) {
      advance(nextStats);
      events.push({ type: "stats", ...stats(nextStats) });
      nextStats += statsEvery;
    }
    advance(e.t);
    if (e.kind === "arrival") {
      inSystem += 1; arrived += 1;
      events.push({ type: "arrival", t: r4(e.t), id: e.id, in_system: inSystem });
    } else if (e.kind === "start") {
      events.push({ type: "start", t: r4(e.t), id: e.id, wait: r4(e.wait ?? 0) });
    } else {
      inSystem -= 1; served += 1; totalDelay += e.t - e.arrived;
      events.push({ type: "depart", t: r4(e.t), id: e.id, delay: r4(e.t - e.arrived), in_system: inSystem });
    }
  }
  while (nextStats < p.duration) {
    advance(nextStats);
    events.push({ type: "stats", ...stats(nextStats) });
    nextStats += statsEvery;
  }
  advance(p.duration);
  events.push({ type: "done", ...stats(p.duration) });
  return events;
}
