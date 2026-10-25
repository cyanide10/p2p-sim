import type { MetricComparison } from "../api/types";

/** Positions in percent of a track that spans the CI and the theoretical value. */
export interface CiScale {
  low: number;
  high: number;
  mean: number;
  theory: number;
}

export function ciScale(metric: MetricComparison): CiScale {
  const lo = Math.min(metric.ci95_low, metric.theoretical);
  const hi = Math.max(metric.ci95_high, metric.theoretical);
  const span = hi - lo || Math.abs(hi) || 1;
  const start = lo - span * 0.15;
  const width = span * 1.3;
  const at = (value: number) => ((value - start) / width) * 100;
  return { low: at(metric.ci95_low), high: at(metric.ci95_high), mean: at(metric.mean), theory: at(metric.theoretical) };
}

export function formatNumber(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toFixed(digits);
}

export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "--";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${String(Math.round(seconds - minutes * 60)).padStart(2, "0")} s`;
}

/** Share of done tasks as a whole percentage, for progress bars. */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}
