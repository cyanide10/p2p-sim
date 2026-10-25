import type { MetricComparison } from "../api/types";

/** x-axis range for a dot-and-whisker chart: covers the CI, the mean and the tolerance band. */
export function chartDomain(metric: MetricComparison): [number, number] {
  const band = Math.abs(metric.theoretical) * (metric.tolerance_pct / 100);
  const low = Math.min(metric.ci95_low, metric.theoretical - band, metric.mean);
  const high = Math.max(metric.ci95_high, metric.theoretical + band, metric.mean);
  const pad = (high - low || Math.abs(metric.theoretical) || 1) * 0.12;
  return [low - pad, high + pad];
}

/** Round axis maximum and tick step: steps of 1, 2 or 5 × 10^k, about four ticks. */
export function niceScale(value: number): { max: number; step: number } {
  const target = Math.max(value, 1) / 4;
  const exp = 10 ** Math.floor(Math.log10(target));
  const step = ([1, 2, 5, 10].find((m) => m * exp >= target) ?? 10) * exp;
  return { max: Math.ceil(Math.max(value, 1) / step) * step, step };
}
