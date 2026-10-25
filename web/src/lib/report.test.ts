import { describe, expect, it } from "vitest";
import type { MetricComparison } from "../api/types";
import { ciScale, formatNumber, formatSeconds, progressPercent } from "./report";

function metric(low: number, high: number, theoretical: number): MetricComparison {
  return {
    n: 100,
    mean: (low + high) / 2,
    stddev: 1,
    ci95_low: low,
    ci95_high: high,
    ci95_half_width: (high - low) / 2,
    theoretical,
    rel_error_pct: 1,
    tolerance_pct: 10,
    within_tolerance: true,
    theoretical_in_ci: theoretical >= low && theoretical <= high,
  };
}

describe("ciScale", () => {
  it("places a theory inside the interval between its ends", () => {
    const s = ciScale(metric(4.8, 5.2, 5));
    expect(s.low).toBeLessThan(s.theory);
    expect(s.theory).toBeLessThan(s.high);
    expect(s.mean).toBeCloseTo(50, 5);
  });

  it("keeps an outside theory on the track", () => {
    const s = ciScale(metric(4.8, 5.2, 6));
    expect(s.theory).toBeGreaterThan(s.high);
    expect(s.theory).toBeLessThan(100);
    expect(s.low).toBeGreaterThan(0);
  });

  it("does not produce NaN for a zero-width interval", () => {
    const s = ciScale(metric(5, 5, 5));
    expect(Object.values(s).every(Number.isFinite)).toBe(true);
    const z = ciScale(metric(0, 0, 0));
    expect(Object.values(z).every(Number.isFinite)).toBe(true);
  });
});

describe("formatting", () => {
  it("formats seconds", () => {
    expect(formatSeconds(3.21)).toBe("3.2 s");
    expect(formatSeconds(125)).toBe("2 m 05 s");
    expect(formatSeconds(null)).toBe("--");
  });

  it("formats numbers and missing values", () => {
    expect(formatNumber(5.06234)).toBe("5.062");
    expect(formatNumber(Number.NaN)).toBe("--");
    expect(formatNumber(undefined)).toBe("--");
  });

  it("bounds progress", () => {
    expect(progressPercent(50, 100)).toBe(50);
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(120, 100)).toBe(100);
  });
});
