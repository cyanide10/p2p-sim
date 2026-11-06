import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { clamp, linearScale, tickLabel, tickValues } from "../../lib/chart";

export interface ChartPad {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_CHART_PAD: ChartPad = { top: 12, right: 12, bottom: 28, left: 40 };

export interface AxisGeometry {
  width: number;
  height: number;
  pad: ChartPad;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  plotW: number;
  plotH: number;
  /** Domain value → pixel. */
  x: (value: number) => number;
  /** Value → pixel (bottom-up). */
  y: (value: number) => number;
  /** Pixel → domain value. */
  invertX: (pixel: number) => number;
}

export interface AxisFrameProps {
  width: number;
  height: number;
  pad?: ChartPad;
  xDomain: [number, number];
  xTicks: number[];
  yMax: number;
  yStep?: number;
  yTicks?: number[];
  xFormat?: (value: number) => string;
  yFormat?: (value: number) => string;
  ariaLabel: string;
  className?: string;
  axisGroupClassName?: string;
  gridClassName?: string;
  axisClassName?: string;
  /** Extra top-left caption inside the plot (e.g. "attack load · req/s"). */
  caption?: ReactNode;
  /** HTML legend rendered above the SVG. */
  legend?: ReactNode;
  /** Map a domain x value to a sample index for hover/keyboard inspection. */
  indexAtX?: (domainX: number, pixelX: number) => number | null;
  /** Number of inspectable samples. Makes the plot keyboard-focusable. */
  indexCount?: number;
  /** Called whenever the hovered sample changes (pointer or keyboard). */
  onIndexChange?: (index: number | null) => void;
  /** Click / pointer-down seek. Receives a clamped domain value. */
  onSeek?: (domainX: number) => void;
  children: (geometry: AxisGeometry, hoverIndex: number | null) => ReactNode;
}

/**
 * Shared SVG chart scaffold: viewBox, plot geometry, gridlines, axis ticks,
 * pointer hover and keyboard sample inspection. Page-specific series are drawn
 * by the render-prop child using the provided scales.
 */
export function AxisFrame({
  width,
  height,
  pad = DEFAULT_CHART_PAD,
  xDomain,
  xTicks,
  yMax,
  yStep,
  yTicks,
  xFormat = tickLabel,
  yFormat = tickLabel,
  ariaLabel,
  className,
  axisGroupClassName = "chart-axes",
  gridClassName = "chart-grid",
  axisClassName,
  caption,
  legend,
  indexAtX,
  indexCount,
  onIndexChange,
  onSeek,
  children,
}: AxisFrameProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);

  const plotLeft = pad.left;
  const plotRight = width - pad.right;
  const plotTop = pad.top;
  const plotBottom = height - pad.bottom;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;
  const x = linearScale(xDomain, [plotLeft, plotRight]);
  const safeYMax = yMax > 0 ? yMax : 1;
  const y = linearScale([0, safeYMax], [plotBottom, plotTop]);
  const geometry: AxisGeometry = {
    width, height, pad, plotLeft, plotRight, plotTop, plotBottom, plotW, plotH, x, y, invertX: x.invert,
  };

  const yTickList = yTicks ?? tickValues(safeYMax, yStep ?? safeYMax / 4);
  const inspectable = Boolean(indexAtX && indexCount && indexCount > 0);

  const setIndex = (next: number | null) => {
    setHoverIndex(next);
    onIndexChange?.(next);
  };

  const indexFor = (event: PointerEvent<SVGSVGElement>) => {
    if (!indexAtX) return null;
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return null;
    const pixel = ((event.clientX - box.left) / box.width) * width;
    const domain = x.invert(clamp(pixel, plotLeft, plotRight));
    return indexAtX(domain, clamp(pixel, plotLeft, plotRight));
  };

  const move = (event: PointerEvent<SVGSVGElement>) => {
    if (!inspectable) return;
    setIndex(indexFor(event));
  };

  const leave = () => {
    if (!focused) setIndex(null);
  };

  const seek = (event: PointerEvent<SVGSVGElement>) => {
    if (!onSeek) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    const pixel = ((event.clientX - box.left) / box.width) * width;
    onSeek(clamp(x.invert(pixel), xDomain[0], xDomain[1]));
  };

  const key = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!inspectable) return;
    const count = indexCount!;
    const current = hoverIndex ?? 0;
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, current - 1);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(count - 1, current + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === "Escape") next = null;
    if (next === null) return;
    event.preventDefault();
    setIndex(next);
  };

  return (
    <div className="chart-frame">
      {legend !== undefined && <div className="chart-frame-legend">{legend}</div>}
      <svg
        className={className}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={inspectable ? `${ariaLabel} Use arrow keys to inspect samples.` : ariaLabel}
        tabIndex={inspectable ? 0 : undefined}
        onPointerMove={move}
        onPointerLeave={leave}
        onPointerDown={seek}
        onFocus={inspectable ? () => { setFocused(true); if (hoverIndex === null) setIndex(0); } : undefined}
        onBlur={inspectable ? () => { setFocused(false); setIndex(null); } : undefined}
        onKeyDown={inspectable ? key : undefined}
      >
        {caption !== undefined && <g className="chart-caption">{caption}</g>}
        <g className={axisGroupClassName}>
          {yTickList.map((value) => {
            const row = y(value);
            return (
              <g key={`y-${value}`}>
                <line className={gridClassName} x1={plotLeft} x2={plotRight} y1={row} y2={row} />
                <text className={axisClassName} x={plotLeft - 8} y={row + 4} textAnchor="end">{yFormat(value)}</text>
              </g>
            );
          })}
          {xTicks.map((value, index) => (
            <text
              key={`x-${value}`}
              className={axisClassName}
              x={x(value)}
              y={height - 6}
              textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}
            >
              {xFormat(value)}
            </text>
          ))}
        </g>
        {children(geometry, hoverIndex)}
      </svg>
    </div>
  );
}
