import type { MetricComparison } from "../api/types";

// Mirrors node/internal/stats so mock reports match real node output.
export const Z95 = 1.959963984540054;
export const CI_METHOD = "normal approximation: mean ± 1.96·s/√n (valid for n ≥ 30)";

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sampleStdDev(values: number[]): number {
  if (values.length < 2) return Number.NaN;
  const m = mean(values);
  const squares = values.reduce((sum, value) => sum + (value - m) ** 2, 0);
  return Math.sqrt(squares / (values.length - 1));
}

export function relativeErrorPct(simulated: number, theoretical: number): number {
  if (theoretical === 0) return simulated === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (Math.abs(simulated - theoretical) / Math.abs(theoretical)) * 100;
}

/** Returns null below two samples, matching the node's null metric fields. */
export function compareToTheory(values: number[], theoretical: number, tolerancePct: number): MetricComparison | null {
  if (values.length < 2) return null;
  const m = mean(values);
  const s = sampleStdDev(values);
  const halfWidth = (Z95 * s) / Math.sqrt(values.length);
  const relError = relativeErrorPct(m, theoretical);
  return {
    n: values.length,
    mean: m,
    stddev: s,
    ci95_low: m - halfWidth,
    ci95_high: m + halfWidth,
    ci95_half_width: halfWidth,
    theoretical,
    rel_error_pct: relError,
    tolerance_pct: tolerancePct,
    within_tolerance: relError <= tolerancePct,
    theoretical_in_ci: theoretical >= m - halfWidth && theoretical <= m + halfWidth,
  };
}

/** Deterministic 32-bit PRNG (mulberry32); used so mock results depend only on the seed. */
export function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) ^ Math.floor(seed / 0x1_0000_0000);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Standard normal sample via Box-Muller. */
export function normalSample(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
