import { describe, expect, it } from "vitest";
import { partitionBarWidths, partitionBreakdown, partitionClassForNode } from "./pdes";

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
