import type { MetricComparison } from "../../api/types";
import { chartDomain } from "../../lib/chart";
import { formatNumber } from "../../lib/format";

/**
 * Horizontal dot-and-whisker for one metric: tolerance band, theoretical
 * marker, mean dot and 95% CI whiskers. Shared by the batch report cards.
 */
export function MetricDotWhisker({ metric, label, width = 320 }: { metric: MetricComparison; label: string; width?: number }) {
  const [low, high] = chartDomain(metric);
  const x = (value: number) => 10 + ((value - low) / (high - low)) * (width - 20);
  const band = Math.abs(metric.theoretical) * (metric.tolerance_pct / 100);
  const summary = `${label}: mean ${formatNumber(metric.mean)}, 95% CI ${formatNumber(metric.ci95_low)} to ${formatNumber(metric.ci95_high)}, theoretical ${formatNumber(metric.theoretical)} ${metric.theoretical_in_ci ? "inside" : "outside"} the interval.`;
  return (
    <svg className="metric-chart" viewBox={`0 0 ${width} 58`} role="img" aria-label={summary}>
      <rect className="chart-band" x={x(metric.theoretical - band)} y={6} width={Math.max(1, x(metric.theoretical + band) - x(metric.theoretical - band))} height={30} rx={2} />
      <line className="chart-axis" x1={10} x2={width - 10} y1={21} y2={21} />
      <line className="chart-theory" x1={x(metric.theoretical)} x2={x(metric.theoretical)} y1={3} y2={39} />
      <line className="chart-ci" x1={x(metric.ci95_low)} x2={x(metric.ci95_high)} y1={21} y2={21} />
      <line className="chart-ci" x1={x(metric.ci95_low)} x2={x(metric.ci95_low)} y1={14} y2={28} />
      <line className="chart-ci" x1={x(metric.ci95_high)} x2={x(metric.ci95_high)} y1={14} y2={28} />
      <circle className="chart-mean" cx={x(metric.mean)} cy={21} r={5} />
      <text className="chart-label" x={10} y={54}>{formatNumber(low, 3)}</text>
      <text className="chart-label chart-label-theory" x={x(metric.theoretical)} y={54} textAnchor="middle">theory {formatNumber(metric.theoretical, 3)}</text>
      <text className="chart-label" x={width - 10} y={54} textAnchor="end">{formatNumber(high, 3)}</text>
    </svg>
  );
}
