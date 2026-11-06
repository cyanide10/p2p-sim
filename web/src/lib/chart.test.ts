import { describe, expect, it } from "vitest";
import {
  clamp, lastAtOrBefore, linePath, linearScale, nearestIndex, seriesSummary,
  stepPath, tickLabel, tickValues, timeTicks,
} from "./chart";

describe("linearScale", () => {
  it("maps a domain onto a pixel range and back", () => {
    const scale = linearScale([0, 10], [40, 600]);
    expect(scale(0)).toBe(40);
    expect(scale(5)).toBe(320);
    expect(scale(10)).toBe(600);
    expect(scale.invert(320)).toBe(5);
  });

  it("collapses an empty domain instead of dividing by zero", () => {
    const scale = linearScale([3, 3], [10, 20]);
    expect(scale(3)).toBe(10);
    expect(scale.invert(20)).toBe(3);
  });
});

describe("tick generation", () => {
  it("emits inclusive zero-based ticks without floating-point drift", () => {
    expect(tickValues(1, 0.25)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(tickValues(0.5, 1)).toEqual([0]);
  });

  it("spreads time ticks across the full duration", () => {
    expect(timeTicks(300)).toEqual([0, 75, 150, 225, 300]);
    expect(timeTicks(0)).toEqual([0]);
  });

  it("formats whole and fractional tick labels", () => {
    expect(tickLabel(4)).toBe("4");
    expect(tickLabel(4.25)).toBe("4.3");
  });
});

describe("hover index lookup", () => {
  const points = [{ t: 0 }, { t: 1 }, { t: 2 }, { t: 3 }];

  it("finds the last sample at or before a time", () => {
    expect(lastAtOrBefore(points, -1)).toBe(-1);
    expect(lastAtOrBefore(points, 0)).toBe(0);
    expect(lastAtOrBefore(points, 1.5)).toBe(1);
    expect(lastAtOrBefore(points, 9)).toBe(3);
  });

  it("finds the nearest sample for tooltips", () => {
    expect(nearestIndex(points, -1)).toBe(0);
    expect(nearestIndex(points, 1.4)).toBe(1);
    expect(nearestIndex(points, 1.6)).toBe(2);
    expect(nearestIndex([], 1)).toBe(-1);
  });

  it("clamps pixel-derived values", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe("chart paths", () => {
  const x = (value: number) => value * 10;
  const y = (value: number) => 100 - value;

  it("builds a stepped path", () => {
    expect(stepPath([{ x: 0, y: 1 }, { x: 2, y: 3 }], x, y)).toBe("M0,99H20V97");
  });

  it("lifts the pen around null gaps", () => {
    expect(linePath([{ x: 0, y: 1 }, { x: 1, y: null }, { x: 2, y: 3 }], x, y)).toBe("M0,99M20,97");
  });
});

describe("seriesSummary", () => {
  it("summarises sample count, latest value and peak", () => {
    expect(seriesSummary("Delay", [2, 5, 3], (value) => value.toFixed(1))).toBe("Delay: 3 samples, latest 3.0, peak 5.0.");
  });

  it("handles empty and non-finite samples", () => {
    expect(seriesSummary("Delay", [])).toBe("Delay: no samples yet.");
    expect(seriesSummary("Delay", [Number.NaN])).toBe("Delay: no samples yet.");
  });
});
