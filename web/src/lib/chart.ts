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

export interface LinearScale {
  (value: number): number;
  /** Convert a pixel back into a domain value (used by hover and click handlers). */
  invert(pixel: number): number;
}

/** Map a numeric domain onto a pixel range. Empty domains collapse to the range start. */
export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const domainSpan = domain[1] - domain[0];
  const safeDomainSpan = domainSpan || 1;
  const rangeSpan = range[1] - range[0] || 1;
  const scale = ((value: number) => range[0] + ((value - domain[0]) / safeDomainSpan) * rangeSpan) as LinearScale;
  scale.invert = (pixel: number) => domain[0] + ((pixel - range[0]) / rangeSpan) * domainSpan;
  return scale;
}

/** Inclusive zero-based ticks up to `max`, avoiding floating-point drift. */
export function tickValues(max: number, step: number): number[] {
  if (!Number.isFinite(max) || !Number.isFinite(step) || step <= 0 || max < 0) return [];
  const count = Math.floor((max + step * 1e-9) / step);
  return Array.from({ length: count + 1 }, (_, index) => Number((index * step).toFixed(10)));
}

/** Evenly spaced ticks across [0, duration], including both ends. */
export function timeTicks(duration: number, count = 5): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || count < 2) return [0];
  return Array.from({ length: count }, (_, index) => (index / (count - 1)) * duration);
}

/** Index of the last point with t <= target (points sorted by t). -1 when target precedes them all. */
export function lastAtOrBefore<T extends { t: number }>(points: T[], target: number): number {
  let lo = 0, hi = points.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= target) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** Closest point to target, or -1 for an empty series. */
export function nearestIndex<T extends { t: number }>(points: T[], target: number): number {
  if (!points.length) return -1;
  const before = lastAtOrBefore(points, target);
  if (before < 0) return 0;
  if (before >= points.length - 1) return before;
  return Math.abs(points[before].t - target) <= Math.abs(points[before + 1].t - target) ? before : before + 1;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Short accessible summary: sample count, latest value and peak. */
export function seriesSummary(
  label: string,
  values: number[],
  format: (value: number) => string = (value) => String(value),
): string {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return `${label}: no samples yet.`;
  const latest = finite[finite.length - 1];
  const peak = Math.max(...finite);
  return `${label}: ${finite.length} samples, latest ${format(latest)}, peak ${format(peak)}.`;
}

const labelNumber = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/** Default axis tick label: integers stay whole, decimals get one place. */
export function tickLabel(value: number): string {
  return labelNumber(value);
}

/** Line path through the provided points, lifting the pen around null gaps. */
export function linePath(
  points: Array<{ x: number; y: number | null }>,
  x: (value: number) => number,
  y: (value: number) => number,
): string {
  let path = "";
  let penDown = false;
  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y)) { penDown = false; continue; }
    path += `${penDown ? "L" : "M"}${x(point.x)},${y(point.y)}`;
    penDown = true;
  }
  return path;
}

/** Step-after path (horizontal, then vertical) used by the live in-system chart. */
export function stepPath(
  points: Array<{ x: number; y: number }>,
  x: (value: number) => number,
  y: (value: number) => number,
): string {
  return points.map((point, index) => (
    index === 0
      ? `M${x(point.x)},${y(point.y)}`
      : `H${x(point.x)}V${y(point.y)}`
  )).join("");
}
