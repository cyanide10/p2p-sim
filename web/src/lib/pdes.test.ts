import { describe, expect, it } from "vitest";
import { metricsLoad, partitionBarWidths, partitionBreakdown, partitionClassForNode, partitionHeat, partitionOwners, singleBand, splitOutlook } from "./pdes";

describe("partitionBreakdown", () => {
  it("sorts partitions and computes totals and bar scale", () => {
    expect(partitionBreakdown({
      "part-2": { compute_s: 3, wait_s: 1, messages: 4, bytes: 400 },
      "part-1": { compute_s: 2, wait_s: 2, messages: 3, bytes: 300 },
    })).toEqual({
      rows: [
        { id: "part-1", compute: 2, wait: 2, messages: 3, bytes: 300 },
        { id: "part-2", compute: 3, wait: 1, messages: 4, bytes: 400 },
      ],
      totalCompute: 5,
      totalWait: 3,
      maxTotal: 4,
    });
  });
});

describe("partitionBarWidths", () => {
  it("scales compute and wait against the widest partition", () => {
    expect(partitionBarWidths(3, 1, 8)).toEqual({ compute: 37.5, wait: 12.5 });
  });

  it("falls back to a unit scale when no partition has timing yet", () => {
    expect(partitionBarWidths(0, 0, 0)).toEqual({ compute: 0, wait: 0 });
  });

  it("clamps negative timings to zero width", () => {
    expect(partitionBarWidths(-2, 4, 4)).toEqual({ compute: 0, wait: 100 });
  });
});

describe("partitionClassForNode", () => {
  it("maps plan assignments to the six-color preview palette", () => {
    expect(partitionClassForNode("r1", { r1: 0 })).toBe("partition-0");
    expect(partitionClassForNode("h9", { h9: 7 })).toBe("partition-1");
    expect(partitionClassForNode("missing", {})).toBe("");
  });
});

describe("partitioned run views", () => {
  const scenario = {
    duration: 10, events: [], flows: [],
    nodes: [
      { id: "r1", kind: "router" as const, x: 0, y: 0 }, { id: "r2", kind: "router" as const, x: 0, y: 0 },
      { id: "h1", kind: "host" as const, x: 0, y: 0 },
    ],
    links: [],
  };
  const plan = { ok: true, parts: 2, assignment: { r1: 0, h1: 0, r2: 1 }, cut_links: ["l1"], lookahead: 0.1, windows: 100, load: [1, 1] };

  it("names the node behind each partition and counts what it holds", () => {
    expect(partitionOwners(plan, scenario, ["node-1", "node-2"])).toEqual([
      { part: 0, node: "node-1", routers: 1, hosts: 1 },
      { part: 1, node: "node-2", routers: 1, hosts: 0 },
    ]);
    expect(partitionOwners(plan, scenario)[1].node).toBe("partition 2");
  });

  it("colours load and labels traffic across cut links", () => {
    const heat = partitionHeat({ links: { l1: { util: 0.5, queue: 3 } }, routers: { r1: { util: 0.25 } } }, { l1: 1200, l2: 4 });
    expect(heat.links.l1).toEqual({ value: 0.5, detail: "load 50% · 3 queued · 1,200 packets crossed between nodes" });
    expect(heat.links.l2.value).toBe(0);
    expect(heat.routers.r1.detail).toBe("load 25%");
  });

  it("turns one run's series and final metrics into chart and map inputs", () => {
    expect(singleBand([1, null, 3])).toEqual({ mean: [1, null, 3], low: [1, null, 3], high: [1, null, 3] });
    expect(metricsLoad({ links: { l1: { utilization: 0.4 } }, routers: { r1: { utilization: null } } }))
      .toEqual({ links: { l1: { util: 0.4, queue: 0 } }, routers: { r1: { util: 0, queue: 0 } } });
  });
});

describe("split outlook", () => {
  it("expects a slowdown when windows hold almost no work", () => {
    expect(splitOutlook(43_800, 69_231).kind).toBe("slower");
    expect(splitOutlook(129_600, 4_616).kind).toBe("even");
    expect(splitOutlook(129_600, 2_858)).toEqual({ kind: "faster", perWindow: 129_600 / 2_858 });
    expect(splitOutlook(100, 0).kind).toBe("slower");
  });
});
