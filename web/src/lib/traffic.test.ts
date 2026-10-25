import { describe, expect, it } from "vitest";
import { niceScale } from "./chart";
import { applyEvents, createSseParser, generateTraffic, initialTraffic, LEAVE_MS, pruneLeaving, validateTraffic, type TrafficEvent } from "./traffic";

const params = { lambda: 0.8, mu: 1, duration: 300, speed: 10, seed: 11 };

describe("createSseParser", () => {
  it("reassembles events split across chunks", () => {
    const got: string[] = [];
    const push = createSseParser((data) => got.push(data));
    push('data: {"a":1}\n\nda');
    push('ta: {"b":2}\r\n\r\n: comment\n\n');
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("validateTraffic", () => {
  it("accepts defaults and enforces the node's bounds", () => {
    expect(validateTraffic(params)).toEqual([]);
    expect(validateTraffic({ ...params, lambda: 2 })).toHaveLength(1);
    expect(validateTraffic({ ...params, speed: 500 })).toHaveLength(1);
    expect(validateTraffic({ ...params, duration: 5000 })).toHaveLength(1);
    expect(validateTraffic({ ...params, seed: -1 })).toHaveLength(1);
  });
});

describe("generateTraffic (mock stream)", () => {
  it("produces a consistent, deterministic event sequence", () => {
    const events = generateTraffic(params);
    expect(events).toEqual(generateTraffic(params));
    expect(events[0].type).toBe("meta");
    const done = events[events.length - 1];
    expect(done.type).toBe("done");
    const times = events.slice(1).map((e) => ("t" in e ? e.t : 0));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    if (done.type === "done") {
      expect(done.arrived).toBe(events.filter((e) => e.type === "arrival").length);
      expect(done.served).toBe(events.filter((e) => e.type === "depart").length);
      expect(done.in_system).toBe(done.arrived - done.served);
    }
  });

  it("converges to M/M/1 theory over a long run", () => {
    const done = generateTraffic({ ...params, duration: 3600, seed: 3 }).at(-1)!;
    expect(done.type).toBe("done");
    if (done.type === "done") {
      expect(done.mean_delay!).toBeGreaterThan(3.5);
      expect(done.mean_delay!).toBeLessThan(6.5);
      expect(done.utilization).toBeCloseTo(0.8, 1);
    }
  });
});

describe("applyEvents", () => {
  const events: TrafficEvent[] = [
    { type: "meta", seed: 1, lambda: 0.8, mu: 1, duration: 100, speed: 10, rho: 0.8, theory: { rho: 0.8, W: 5, L: 4 } },
    { type: "arrival", t: 1, id: 1, in_system: 1 },
    { type: "start", t: 1, id: 1, wait: 0 },
    { type: "arrival", t: 2, id: 2, in_system: 2 },
    { type: "arrival", t: 3, id: 3, in_system: 3 },
    { type: "depart", t: 4, id: 1, delay: 3, in_system: 2 },
    { type: "start", t: 4, id: 2, wait: 2 },
  ];

  it("tracks the queue, the server and departures", () => {
    const s = applyEvents(initialTraffic, events, 7, 1000);
    expect(s.queue).toEqual([3]);
    expect(s.serving).toBe(2);
    expect(s.leaving).toEqual([1]);
    expect(s.delays).toEqual([{ t: 4, id: 1, delay: 3 }]);
    expect(s.clock).toBe(4);
    expect(s.packets[3].bornFrame).toBe(7);
    expect(s.feed.at(-1)).toContain("#2 into service");
  });

  it("drops departed packets after their exit animation", () => {
    const s = applyEvents(initialTraffic, events, 1, 1000);
    expect(pruneLeaving(s, 1000 + LEAVE_MS - 1).packets[1]).toBeDefined();
    const pruned = pruneLeaving(s, 1000 + LEAVE_MS);
    expect(pruned.packets[1]).toBeUndefined();
    expect(pruned.leaving).toEqual([]);
  });

  it("starts over on a new meta event and records errors", () => {
    const s = applyEvents(applyEvents(initialTraffic, events, 1, 0), [events[0]], 2, 0);
    expect(s.queue).toEqual([]);
    const failed = applyEvents(s, [{ type: "error", message: "boom" }], 3, 0);
    expect(failed.error).toBe("boom");
    expect(failed.done).toBe(true);
  });
});

describe("niceScale", () => {
  it("picks round steps", () => {
    expect(niceScale(25)).toEqual({ max: 30, step: 10 });
    expect(niceScale(13.5)).toEqual({ max: 15, step: 5 });
    expect(niceScale(7)).toEqual({ max: 8, step: 2 });
    expect(niceScale(0)).toEqual({ max: 1, step: 0.5 });
  });
});
