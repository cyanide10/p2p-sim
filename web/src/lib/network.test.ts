import { describe, expect, it } from "vitest";
import { applyNetEvents, playbackSpeeds, checkScenario, cloneScenario, HOP_MS, initialLive, nextId, offeredPackets, parseScenario, SAMPLES, toWire, type NetStreamEvent } from "./network";

describe("samples", () => {
  it("are all valid", () => {
    for (const sample of SAMPLES) expect(checkScenario(sample.scenario), sample.id).toEqual([]);
  });
});

describe("checkScenario", () => {
  it("reports broken references and limits", () => {
    const sc = cloneScenario(SAMPLES[0].scenario);
    sc.flows.push({ id: "bad", src: "h1", dst: "r1", rate: 1, pattern: { type: "constant" } });
    sc.events.push({ t: 10, target: "h1", action: "down" });
    sc.flows[0].rate = 1000;
    const errors = checkScenario(sc).join(" ");
    expect(errors).toContain("must be hosts");
    expect(errors).toContain("pick a link or router");
    expect(errors).toContain("Too much traffic");
    expect(checkScenario({ ...sc, flows: [] }).join(" ")).toContain("at least one flow");
  });

  it("measures offered traffic at the schedule's peak", () => {
    const sc = cloneScenario(SAMPLES[0].scenario);
    expect(offeredPackets(sc)).toBe((20 + 40 + 15) * 300);
  });
});

describe("ids and wire format", () => {
  it("picks the first free id", () => {
    expect(nextId("r", ["r1", "r2", "r4"])).toBe("r3");
  });

  it("round-trips through JSON and fills in missing positions", () => {
    const wire = toWire(SAMPLES[1].scenario);
    expect(parseScenario(JSON.parse(JSON.stringify(wire)))).toEqual(wire);
    const parsed = parseScenario({ duration: 10, nodes: [{ id: "a", kind: "host" }], links: [] });
    expect(parsed?.nodes[0].x).toBeTypeOf("number");
    expect(parseScenario({ nodes: "x" })).toBeNull();
  });
});

describe("applyNetEvents", () => {
  const meta: NetStreamEvent = { type: "meta", seed: 1, speed: 2, duration: 100, routes: { f1: ["h1", "r1", "h2"] } };

  it("animates hops, records failures and per-flow stats", () => {
    let s = applyNetEvents(initialLive, [
      meta,
      { type: "hop", t: 1, pkt: 1, flow: "f1", link: "l1", from: "h1", to: "r1" },
      { type: "drop", t: 1.2, pkt: 2, flow: "f1", at: "l2", reason: "link_buffer" },
      { type: "failure", t: 2, target: "l2", action: "down", routes: { f1: [] } },
      { type: "stats", t: 2.5, links: { l1: { util: 0.5, queue: 1 } }, routers: {}, flows: { f1: { sent: 3, delivered: 1, dropped: 1, mean_delay: 0.2 } } },
    ], 1000);
    expect(s.moving).toHaveLength(1);
    expect(s.drops).toHaveLength(1);
    expect(s.down).toEqual(["l2"]);
    expect(s.routes.f1).toEqual([]);
    expect(s.links.l1.util).toBe(0.5);
    expect(s.flows.f1.delivered).toBe(1);
    expect(s.feed.join("\n")).toContain("l2 FAILED");
    expect(s.feed.join("\n")).toContain("no route for f1");

    s = applyNetEvents(s, [{ type: "failure", t: 3, target: "l2", action: "up", routes: { f1: ["h1", "r1", "h2"] } }], 1000 + HOP_MS);
    expect(s.down).toEqual([]);
    expect(s.moving).toHaveLength(0);
  });

  it("finishes on done and on error", () => {
    expect(applyNetEvents(initialLive, [meta, { type: "done", t: 100, metrics: {} }], 0).done).toBe(true);
    const failed = applyNetEvents(initialLive, [{ type: "error", message: "boom" }], 0);
    expect(failed.error).toBe("boom");
  });
});

describe("seek and playback speeds", () => {
  it("restores the state at the seek point", () => {
    const s = applyNetEvents(initialLive, [
      { type: "meta", seed: 1, speed: 1, duration: 100, start: 50, routes: { f: ["a", "b"] } },
      { type: "seek", t: 50, down: ["l3"], routes: { f: ["a", "c", "b"] }, links: { l1: { util: 0, queue: 4 } }, routers: {}, flows: { f: { sent: 10, delivered: 9, dropped: 1, mean_delay: 0.2 } } },
    ], 0);
    expect(s.clock).toBe(50);
    expect(s.down).toEqual(["l3"]);
    expect(s.routes.f).toEqual(["a", "c", "b"]);
    expect(s.flows.f.delivered).toBe(9);
  });

  it("offers only speeds the live view can draw", () => {
    const sc = cloneScenario(SAMPLES[0].scenario); // peak 75 packets/s
    expect(playbackSpeeds(sc)).toEqual([0.25, 0.5, 1, 2]);
    sc.flows.forEach((f) => { f.rate = 1000; f.pattern = { type: "constant" }; });
    expect(playbackSpeeds(sc)).toEqual([0.05]);
  });
});
