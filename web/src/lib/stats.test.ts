import { describe, expect, it } from "vitest";
import { chartDomain } from "./chart";
import { formatDuration, parseHash } from "./format";
import { compareToTheory, mean, relativeErrorPct, sampleStdDev, seededRandom, Z95 } from "./stats";

describe("stats", () => {
  it("computes mean and sample standard deviation", () => {
    expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    expect(sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 5);
    expect(sampleStdDev([1])).toBeNaN();
  });

  it("matches the node's comparison against theory", () => {
    const values = [4.8, 5.1, 5.0, 5.3, 4.9];
    const result = compareToTheory(values, 5, 10)!;
    const halfWidth = (Z95 * sampleStdDev(values)) / Math.sqrt(values.length);
    expect(result.n).toBe(5);
    expect(result.mean).toBeCloseTo(5.02);
    expect(result.ci95_half_width).toBeCloseTo(halfWidth);
    expect(result.rel_error_pct).toBeCloseTo(0.4);
    expect(result.within_tolerance).toBe(true);
    expect(result.theoretical_in_ci).toBe(true);
  });

  it("returns null below two samples, like the node", () => {
    expect(compareToTheory([5], 5, 10)).toBeNull();
  });

  it("handles a zero theoretical value", () => {
    expect(relativeErrorPct(0, 0)).toBe(0);
    expect(relativeErrorPct(1, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("produces repeatable seeded sequences", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const c = seededRandom(43);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(c()).not.toBe(first[0]);
    first.forEach((value) => expect(value).toBeGreaterThanOrEqual(0));
    first.forEach((value) => expect(value).toBeLessThan(1));
  });
});

describe("chartDomain", () => {
  it("covers the CI, the mean and the tolerance band", () => {
    const metric = compareToTheory([4.8, 5.1, 5.0, 5.3, 4.9], 5, 10)!;
    const [low, high] = chartDomain(metric);
    expect(low).toBeLessThan(Math.min(metric.ci95_low, 4.5));
    expect(high).toBeGreaterThan(Math.max(metric.ci95_high, 5.5));
  });
});

describe("format helpers", () => {
  it("parses hash routes with IDs and queries", () => {
    expect(parseHash("")).toMatchObject({ route: "cluster", id: null });
    expect(parseHash("#/live/abc%2Fdef")).toMatchObject({ route: "live", id: "abc/def" });
    const launch = parseHash("#/launch?resubmit=xyz");
    expect(launch.route).toBe("launch");
    expect(launch.query.get("resubmit")).toBe("xyz");
  });

  it("formats durations", () => {
    expect(formatDuration(3.214)).toBe("3.21 s");
    expect(formatDuration(75)).toBe("1m 15s");
    expect(formatDuration(null)).toBe("--");
  });
});
