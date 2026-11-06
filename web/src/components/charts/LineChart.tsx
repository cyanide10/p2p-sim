import type { ReactNode } from "react";
import { linePath, stepPath } from "../../lib/chart";
import { AxisFrame, type AxisFrameProps, type AxisGeometry } from "./AxisFrame";

export interface LineSeries {
  points: Array<{ x: number; y: number | null }>;
  className?: string;
  stroke?: string;
  /** Step-after instead of straight segments. */
  step?: boolean;
  /** Fill the area between the line and the chart baseline. */
  areaFill?: string;
  areaClassName?: string;
}

export interface LineChartProps extends Omit<AxisFrameProps, "children"> {
  series: LineSeries[];
  /** Extra page-specific marks (reference lines, current-value dots, custom tooltips). */
  overlay?: (geometry: AxisGeometry, hoverIndex: number | null) => ReactNode;
}

function areaPath(series: LineSeries, geometry: AxisGeometry): string {
  const runs: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  for (const point of series.points) {
    if (point.y === null || !Number.isFinite(point.y)) {
      if (current.length > 1) runs.push(current);
      current = [];
      continue;
    }
    current.push({ x: point.x, y: point.y });
  }
  if (current.length > 1) runs.push(current);
  return runs.map((run) => {
    const top = run.map((point, index) => `${index === 0 ? "M" : "L"}${geometry.x(point.x)},${geometry.y(point.y)}`).join("");
    const bottom = [...run].reverse().map((point) => `L${geometry.x(point.x)},${geometry.y(0)}`).join("");
    return `${top}${bottom}Z`;
  }).join("");
}

/** Draw one or more line/area series on the shared AxisFrame scaffold. */
export function LineChart({ series, overlay, ...axisProps }: LineChartProps) {
  return (
    <AxisFrame {...axisProps}>
      {(geometry, hoverIndex) => (
        <>
          {series.map((item, index) => (
            item.areaFill && (
              <path key={`area-${index}`} d={areaPath(item, geometry)} fill={item.areaFill} className={item.areaClassName} />
            )
          ))}
          {series.map((item, index) => {
            const d = item.step
              ? stepPath(item.points.filter((point): point is { x: number; y: number } => point.y !== null), geometry.x, geometry.y)
              : linePath(item.points, geometry.x, geometry.y);
            return <path key={`line-${index}`} d={d} className={item.className} style={item.stroke ? { stroke: item.stroke } : undefined} />;
          })}
          {overlay?.(geometry, hoverIndex)}
        </>
      )}
    </AxisFrame>
  );
}
