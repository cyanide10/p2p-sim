import { useId } from "react";
import { AxisFrame } from "../charts/AxisFrame";
import { PanelTitle } from "../PagePrimitives";
import { compact, sampleAt, type AttackRun } from "../../lib/attack";
import { seriesSummary } from "../../lib/chart";

interface Props {
  run: AttackRun;
  clock: number;
  onSeek: (time: number) => void;
}

function AttackChart({ run, clock, onSeek, variant }: Props & { variant: "load" | "impact" }) {
  const gradientId = `attack-area-${useId().replace(/:/g, "")}`;
  const width = 560;
  const height = 190;
  const pad = { top: 18, right: 18, bottom: 28, left: 38 };
  const impact = variant === "impact";
  const yMax = impact ? 100 : Math.max(run.config.capacity, ...run.samples.map((sample) => sample.attackLoad + sample.legitLoad)) * 1.08;
  const yTicks = impact ? [0, 25, 50, 75, 100] : [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * yMax);
  const current = sampleAt(run, clock);
  const summary = impact
    ? `${seriesSummary("Impact", run.samples.map((sample) => sample.impactPct))} ${seriesSummary("Availability", run.samples.map((sample) => sample.availability))}`
    : seriesSummary("Attack load", run.samples.map((sample) => sample.attackLoad));
  const indexFor = (time: number) => Math.max(
    0,
    Math.min(run.samples.length - 1, Math.round((time / run.config.duration) * (run.samples.length - 1))),
  );
  const legend = impact ? (
    <>
      <span><i className="is-impact" />impact</span>
      <span><i className="is-uptime" />availability</span>
    </>
  ) : (
    <>
      <span><i style={{ background: run.scenario.accent }} />attack</span>
      <span><i className="is-legit" />legitimate</span>
      <span><i className="is-capacity" />capacity</span>
    </>
  );

  return (
    <section className="attack-chart-panel">
      <PanelTitle
        title={impact ? `${run.scenario.impactLabel} & availability` : "Offered load vs capacity"}
        note={impact ? "How far the estate falls below its service level, and how quickly it recovers." : "Attack traffic and legitimate baseline against the target's design limit."}
        tone="soc"
        className="attack-chart-title"
      />
      <AxisFrame
        width={width}
        height={height}
        pad={pad}
        xDomain={[0, run.config.duration]}
        xTicks={[0, run.config.duration / 2, run.config.duration]}
        yMax={yMax}
        yTicks={yTicks}
        xFormat={(value) => `${Math.round(value)}s`}
        yFormat={impact ? (value) => `${value}%` : (value) => compact(value)}
        className="attack-chart"
        gridClassName="attack-chart-grid"
        axisClassName="attack-chart-axis"
        ariaLabel={impact ? `Impact and availability over the campaign. ${summary}` : `Attack load versus target capacity over the campaign. ${summary}`}
        legend={legend}
        caption={<text className="attack-chart-axis" x={pad.left} y={12}>{impact ? `${run.scenario.impactLabel} · availability` : `${run.scenario.attackLabel} · ${run.scenario.unit}`}</text>}
        indexCount={run.samples.length}
        indexAtX={indexFor}
        onIndexChange={(index) => {
          if (index !== null) onSeek(run.samples[index].t);
        }}
        onSeek={onSeek}
      >
        {(geometry, hoverIndex) => {
          const points = (values: number[]) => values.map((value, index) => `${geometry.x(run.samples[index].t).toFixed(2)},${geometry.y(value).toFixed(2)}`).join(" ");
          const primary = impact ? run.samples.map((sample) => sample.impactPct) : run.samples.map((sample) => sample.attackLoad);
          const secondary = impact ? run.samples.map((sample) => sample.availability) : run.samples.map((sample) => sample.legitLoad);
          const baseline = `${geometry.x(0)},${geometry.y(0)}`;
          const end = `${geometry.x(run.config.duration)},${geometry.y(0)}`;
          const area = `M ${baseline} L ${points(primary).replaceAll(" ", " L ")} L ${end} Z`;
          const hovered = hoverIndex === null ? null : run.samples[hoverIndex];
          const xAt = hovered ? geometry.x(hovered.t) : 0;
          const yAt = hovered ? geometry.y(impact ? hovered.impactPct : hovered.attackLoad) : 0;
          return (
            <>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={impact ? "#ff5a4e" : run.scenario.accent} stopOpacity={impact ? "0.32" : "0.38"} />
                  <stop offset="100%" stopColor={impact ? "#ff5a4e" : run.scenario.accent} stopOpacity={impact ? "0.01" : "0.02"} />
                </linearGradient>
              </defs>
              <path d={area} fill={`url(#${gradientId})`} />
              <polyline className="attack-chart-line" points={points(primary)} stroke={impact ? "#ff5a4e" : run.scenario.accent} />
              <polyline className={`attack-chart-line ${impact ? "attack-chart-availability" : "attack-chart-legit"}`} points={points(secondary)} />
              {!impact && <>
                <line className="attack-chart-capacity" x1={geometry.plotLeft} x2={geometry.plotRight} y1={geometry.y(run.config.capacity)} y2={geometry.y(run.config.capacity)} />
                <text className="attack-chart-capacity-label" x={geometry.plotRight} y={geometry.y(run.config.capacity) - 6} textAnchor="end">capacity</text>
              </>}
              {run.events.map((event) => (
                <line key={`ev-${event.t}-${event.text}`} className={`attack-chart-event event-${event.level}`}
                  x1={geometry.x(event.t)} x2={geometry.x(event.t)} y1={geometry.plotTop} y2={geometry.plotBottom} />
              ))}
              <line className="attack-chart-now" x1={geometry.x(clock)} x2={geometry.x(clock)} y1={geometry.plotTop} y2={geometry.plotBottom} />
              <circle className="attack-chart-dot" cx={geometry.x(clock)} cy={geometry.y(impact ? current.impactPct : current.attackLoad)} r="3.4" fill={impact ? "#ff5a4e" : run.scenario.accent} />
              {impact && <circle className="attack-chart-dot" cx={geometry.x(clock)} cy={geometry.y(current.availability)} r="2.8" fill="#54d6a4" />}
              {hovered && <>
                <line className="chart-hover-line" x1={xAt} x2={xAt} y1={geometry.plotTop} y2={geometry.plotBottom} />
                <circle className="chart-hover-dot" cx={xAt} cy={yAt} r="4" />
                <g className="chart-hover-tooltip" transform={`translate(${Math.min(xAt + 8, geometry.plotRight - 132)}, ${geometry.plotTop + 4})`}>
                  <rect width="132" height="43" rx="4" />
                  <text x="8" y="16">t = {hovered.t.toFixed(1)}s</text>
                  <text x="8" y="33">{impact ? `${run.scenario.impactLabel}: ${hovered.impactPct.toFixed(1)}%` : `Load: ${compact(hovered.attackLoad)}`}</text>
                </g>
              </>}
            </>
          );
        }}
      </AxisFrame>
    </section>
  );
}

export function AttackCharts(props: Props) {
  return (
    <div className="attack-charts">
      <AttackChart {...props} variant="load" />
      <AttackChart {...props} variant="impact" />
    </div>
  );
}
