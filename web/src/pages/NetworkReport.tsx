import { Activity, Check, CircleCheck, CircleX, Copy, Network, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { ApiClient } from "../api/client";
import type { Band, Estimate, NetworkReport } from "../api/types";
import { NetworkPlayer } from "../components/NetworkPlayer";
import { TopologyCanvas } from "../components/TopologyCanvas";
import { niceScale } from "../lib/chart";
import { formatDuration } from "../lib/format";
import { flowSlot, type Scenario } from "../lib/network";

const pm = (e: Estimate | null | undefined, scale = 1, digits = 2, unit = "") =>
  e ? `${(e.mean * scale).toFixed(digits)}${unit} ± ${(e.ci95_half_width * scale).toFixed(digits)}` : "--";

// ---------------------------------------------------------------------------
// Time-series chart: mean line with a 95% CI band per series, one y-axis.
// ---------------------------------------------------------------------------

const W = 640, H = 240, PAD = { left: 48, right: 14, top: 14, bottom: 28 };
const plotW = W - PAD.left - PAD.right, plotH = H - PAD.top - PAD.bottom;

interface SeriesDef { name: string; color: string; band: Band }

function BandChart({ series, binWidth, duration, events, unit, scale = 1, label }: {
  series: SeriesDef[]; binWidth: number; duration: number; events: Scenario["events"]; unit: string; scale?: number; label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const bins = Math.max(0, ...series.map((s) => s.band.mean.length));
  const values = series.flatMap((s) => s.band.high.filter((v): v is number => v !== null).map((v) => v * scale));
  const yScale = niceScale(Math.max(0, ...values) || 1);
  const x = (i: number) => PAD.left + ((i + 0.5) * binWidth / duration) * plotW;
  const y = (v: number) => PAD.top + plotH - (v * scale / yScale.max) * plotH;
  const path = (vals: Array<number | null>) => {
    let d = "";
    vals.forEach((v, i) => { if (v !== null) d += `${d && vals[i - 1] !== null ? "L" : "M"}${x(i)},${y(v)}`; });
    return d;
  };
  const area = (band: Band) => {
    const idx = band.mean.map((v, i) => (v !== null && band.low[i] !== null && band.high[i] !== null ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2) return "";
    return `M${idx.map((i) => `${x(i)},${y(band.high[i]!)}`).join("L")}L${[...idx].reverse().map((i) => `${x(i)},${y(Math.max(0, band.low[i]!))}`).join("L")}Z`;
  };
  const ticks: number[] = [];
  for (let v = 0; v <= yScale.max + 1e-9; v += yScale.step) ticks.push(v);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    const i = Math.floor(((sx - PAD.left) / plotW) * duration / binWidth);
    setHover(i >= 0 && i < bins ? i : null);
  };
  const fmt = (v: number | null) => (v === null ? "--" : (v * scale).toFixed(scale === 1 ? 1 : 0));
  return (
    <svg className="live-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <g className="chart-axes">
        {ticks.map((v) => <g key={v}><line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH - (v / yScale.max) * plotH} y2={PAD.top + plotH - (v / yScale.max) * plotH} />
          <text x={PAD.left - 8} y={PAD.top + plotH - (v / yScale.max) * plotH + 4} textAnchor="end">{Number.isInteger(v) ? v : v.toFixed(1)}</text></g>)}
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => <text key={f} x={PAD.left + f * plotW} y={H - 6} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}>{Math.round(f * duration)}</text>)}
      </g>
      {events.map((e, i) => {
        const ex = PAD.left + (e.t / duration) * plotW;
        return <g key={i} className="chart-event"><line x1={ex} x2={ex} y1={PAD.top} y2={PAD.top + plotH} /><text x={ex + 4} y={PAD.top + 12 + (i % 3) * 14}>{e.target} {e.action === "down" ? "down" : "up"}</text></g>;
      })}
      {series.map((s) => <path key={`${s.name}-band`} d={area(s.band)} style={{ fill: s.color }} className="chart-band-fill" />)}
      {series.map((s) => <path key={s.name} d={path(s.band.mean)} style={{ stroke: s.color }} className="chart-series" />)}
      {hover !== null && (
        <g className="chart-hover">
          <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />
          {series.map((s) => s.band.mean[hover] !== null && <circle key={s.name} cx={x(hover)} cy={y(s.band.mean[hover]!)} r={4} style={{ fill: s.color }} />)}
          <g transform={`translate(${Math.min(x(hover) + 10, W - PAD.right - 196)}, ${PAD.top + 4})`}>
            <rect width={196} height={22 + series.length * 17} rx={4} />
            <text x={9} y={17}>t = {(hover * binWidth).toFixed(0)}–{((hover + 1) * binWidth).toFixed(0)} s</text>
            {series.map((s, i) => <text key={s.name} x={9} y={34 + i * 17}>{s.name}: {fmt(s.band.mean[hover])} {unit}</text>)}
          </g>
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------

export function NetworkReportView({ report, runId, api }: { report: NetworkReport; runId: string; api: ApiClient }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const sc = report.scenario;
  const totals = report.totals;
  const flowIndex = Object.fromEntries(sc.flows.map((f, i) => [f.id, i]));
  const heat = Object.fromEntries(Object.entries(report.links).map(([id, m]) => [id, { value: m.utilization?.mean ?? 0, detail: `average load ${pm(m.utilization, 100, 1, "%")}` }]));
  const routerHeat = Object.fromEntries(Object.entries(report.routers).map(([id, m]) => [id, { value: m.utilization?.mean ?? 0, detail: `average load ${pm(m.utilization, 100, 1, "%")}` }]));
  const links = [...sc.links].sort((a, b) => (report.links[b.id]?.utilization?.mean ?? 0) - (report.links[a.id]?.utilization?.mean ?? 0));
  const peers = Object.entries(report.tasks_per_peer).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const maxPeer = Math.max(1, ...peers.map(([, c]) => c));
  const done = report.tasks.complete;
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setCopied("copied"); } catch { setCopied("failed"); }
    window.setTimeout(() => setCopied("idle"), 2000);
  };

  return (
    <section className="page-content" aria-labelledby="netreport-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">NETWORK REPORT</p>
          <h1 id="netreport-heading">Network results</h1>
          <p className="lede">{done} independent copies of the network, combined · {report.batch_id} · coordinated by {report.coordinator}</p>
        </div>
        <div className="heading-actions">
          <a className="ghost-button" href="#/network"><Network size={15} />Edit network</a>
          <a className="ghost-button" href={`#/live/${encodeURIComponent(runId)}`}><Activity size={15} />Progress</a>
          <button className="ghost-button" type="button" onClick={() => void copy()}>{copied === "copied" ? <Check size={15} /> : <Copy size={15} />}{copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy as JSON"}</button>
        </div>
      </div>

      {report.verdict === "PENDING" && <div className="notice notice-warning" role="status">{report.verdict_detail}</div>}
      {report.stale && <div className="notice notice-warning" role="status">Stored snapshot: the coordinator is unavailable.</div>}
      {done > 0 && done < 10 && <div className="notice notice-warning" role="status"><TriangleAlert size={15} /> Only {done} copies: confidence intervals are wide. Run 30 or more for tighter estimates.</div>}
      <div className={`verdict-card ${report.verdict === "FAIL" ? "verdict-fail" : report.verdict === "COMPLETE" ? "verdict-pass" : "verdict-pending"}`}>
        <div className="verdict-mark">{report.verdict === "FAIL" ? <CircleX size={30} /> : <CircleCheck size={30} />}</div>
        <div><p className="eyebrow">STATUS</p><strong className="verdict-word">{report.verdict === "COMPLETE" ? "Complete" : report.verdict === "FAIL" ? "Failed" : "Running"}</strong><p>{report.verdict_detail}. Values are means across copies ± 95% confidence interval.</p></div>
      </div>

      <div className="section-title"><h2>Watch the traffic</h2><span>replay any computed copy · same seed, same packets</span></div>
      <NetworkPlayer api={api} scenario={sc} copies={Array.from({ length: Math.min(report.replications_requested, 100) }, (_, i) => ({ label: `Copy ${i + 1} (seed ${report.base_seed + i})`, seed: report.base_seed + i }))} />

      <div className="section-title net-results-title"><h2>Combined results</h2><span>all {done} copies</span></div>
      <dl className="traffic-tiles">
        <div><dt>Delivered</dt><dd>{totals.throughput?.mean.toFixed(1) ?? "--"}<small> pkt/s ± {totals.throughput?.ci95_half_width.toFixed(1) ?? "--"}</small></dd></div>
        <div><dt>Mean delay</dt><dd>{totals.mean_delay ? (totals.mean_delay.mean * 1000).toFixed(0) : "--"}<small> ms ± {totals.mean_delay ? (totals.mean_delay.ci95_half_width * 1000).toFixed(0) : "--"}</small></dd></div>
        <div><dt>Packet loss</dt><dd>{totals.loss_rate ? (totals.loss_rate.mean * 100).toFixed(2) : "--"}<small>% ± {totals.loss_rate ? (totals.loss_rate.ci95_half_width * 100).toFixed(2) : "--"}</small></dd></div>
        <div><dt>Copies</dt><dd>{done}<small> / {report.replications_requested}</small></dd></div>
        <div><dt>Wall clock</dt><dd>{formatDuration(report.timing.distributed_wall_clock_seconds)}</dd></div>
        <div><dt>Parallelism</dt><dd>{report.timing.parallelism ? `${report.timing.parallelism.toFixed(2)}×` : "--"}<small> on {report.timing.distributed_peers} nodes</small></dd></div>
      </dl>

      <div className="panel">
        <div className="panel-title"><h2>Average load</h2><span>darker and thicker = busier · hover a link or router for its value</span></div>
        <div className="net-heat-legend" aria-hidden="true"><span>0%</span><i /><span>100%</span><span className="topo-congested-chip">⚠ ≥ 85%</span></div>
        <div className="net-canvas net-canvas-report"><TopologyCanvas scenario={sc} mode="heat" heat={heat} routerHeat={routerHeat} flowIndex={flowIndex} /></div>
      </div>

      <div className="traffic-charts">
        <div className="panel">
          <div className="panel-title"><h2>Traffic over time</h2><span>packets/s · line = mean, band = 95% CI</span></div>
          <ul className="chart-legend"><li><i className="legend-swatch" style={{ background: "var(--flow-0)" }} />Delivered</li><li><i className="legend-swatch" style={{ background: "var(--flow-1)" }} />Dropped</li><li><i className="legend-ref legend-event" />Failure / recovery</li></ul>
          <BandChart label="Delivered and dropped packets per second over simulated time" unit="pkt/s" binWidth={report.series.bin_width} duration={sc.duration} events={sc.events}
            series={[{ name: "Delivered", color: "var(--flow-0)", band: report.series.delivered_rate }, { name: "Dropped", color: "var(--flow-1)", band: report.series.dropped_rate }]} />
        </div>
        <div className="panel">
          <div className="panel-title"><h2>Delay over time</h2><span>ms, packets delivered in each interval</span></div>
          <BandChart label="Mean packet delay over simulated time" unit="ms" scale={1000} binWidth={report.series.bin_width} duration={sc.duration} events={sc.events}
            series={[{ name: "Mean delay", color: "var(--flow-0)", band: report.series.mean_delay }]} />
        </div>
      </div>

      <div className="section-title"><h2>Flows</h2><span>{sc.flows.length}</span></div>
      <div className="matrix-frame table-scroll">
        <table className="data-table net-report-table">
          <thead><tr><th scope="col">Flow</th><th scope="col">Route</th><th scope="col">Delivered (pkt/s)</th><th scope="col">Mean delay (ms)</th><th scope="col">p95 delay (ms)</th><th scope="col">Loss (%)</th></tr></thead>
          <tbody>{sc.flows.map((f, i) => {
            const m = report.flows[f.id] ?? {};
            return <tr key={f.id}><th scope="row"><i className="flow-swatch" style={{ background: flowSlot(i) }} />{f.id}</th><td>{f.src} → {f.dst}</td>
              <td>{pm(m.throughput, 1, 2)}</td><td>{pm(m.mean_delay, 1000, 1)}</td><td>{pm(m.p95_delay, 1000, 1)}</td><td>{pm(m.loss_rate, 100, 2)}</td></tr>;
          })}</tbody>
        </table>
      </div>

      <div className="report-columns">
        <div>
          <div className="section-title"><h2>Links</h2><span>busiest first</span></div>
          <div className="matrix-frame table-scroll">
            <table className="data-table net-report-table">
              <thead><tr><th scope="col">Link</th><th scope="col">Load (%)</th><th scope="col">Drops</th><th scope="col">Avg queue</th></tr></thead>
              <tbody>{links.map((l) => { const m = report.links[l.id] ?? {}; return <tr key={l.id}><th scope="row">{l.id}<small> {l.a}–{l.b}</small></th><td>{pm(m.utilization, 100, 1)}</td><td>{m.drops ? m.drops.mean.toFixed(1) : "--"}</td><td>{m.mean_queue ? m.mean_queue.mean.toFixed(2) : "--"}</td></tr>; })}</tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="section-title"><h2>Routers</h2></div>
          <div className="matrix-frame table-scroll">
            <table className="data-table net-report-table">
              <thead><tr><th scope="col">Router</th><th scope="col">Load (%)</th><th scope="col">Drops</th><th scope="col">Avg queue</th></tr></thead>
              <tbody>{Object.entries(report.routers).map(([id, m]) => <tr key={id}><th scope="row">{id}</th><td>{pm(m.utilization, 100, 1)}</td><td>{m.drops ? m.drops.mean.toFixed(1) : "--"}</td><td>{m.mean_queue ? m.mean_queue.mean.toFixed(2) : "--"}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="panel net-peers">
            <div className="panel-title"><h2>Work per node</h2><span>copies simulated</span></div>
            <ul className="peer-bars">{peers.map(([peer, count]) => <li key={peer}><span className="peer-name">{peer}</span><span className="peer-bar"><i style={{ width: `${(count / maxPeer) * 100}%` }} /></span><span className="peer-count">{count}</span></li>)}</ul>
            <p className="panel-note">{report.tasks.failed_attempts} failed attempt(s) retried elsewhere · {report.tasks.failed} permanently failed · seeds {report.base_seed}…{report.base_seed + report.replications_requested - 1}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
