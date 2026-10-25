import { Dices, LoaderCircle, Play, Square, TriangleAlert } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "../api/client";
import { niceScale } from "../lib/chart";
import type { MockScenario } from "../api/types";
import {
  applyEvents, initialTraffic, pruneLeaving, validateTraffic,
  type DelayPoint, type Point, type TrafficEvent, type TrafficState,
} from "../lib/traffic";

type Status = "idle" | "connecting" | "streaming" | "finished" | "stopped" | "error";

const statusLabels: Record<Status, string> = {
  idle: "Idle", connecting: "Connecting", streaming: "Streaming", finished: "Finished", stopped: "Stopped", error: "Error",
};

const presets = [
  { label: "Light · ρ 0.5", lambda: 0.5, mu: 1 },
  { label: "Busy · ρ 0.9", lambda: 0.9, mu: 1 },
  { label: "Overloaded · ρ 1.2", lambda: 1.2, mu: 1 },
];

interface Draft { lambda: string; mu: string; speed: string; duration: string; seed: string }

const randomSeed = () => Math.floor(Math.random() * 1_000_000_000);

// ---------------------------------------------------------------------------
// Router diagram
// ---------------------------------------------------------------------------

interface Layout {
  width: number; source: number; server: number; sink: number; head: number; gap: number; slots: number; scale: number;
}
// The compact layout keeps text legible on phones by drawing fewer buffer slots.
const WIDE: Layout = { width: 1000, source: 70, server: 775, sink: 945, head: 690, gap: 34, slots: 15, scale: 1 };
const COMPACT: Layout = { width: 560, source: 46, server: 418, sink: 520, head: 338, gap: 34, slots: 6, scale: 1.15 };
const Y = 110;

function useNarrow(breakpoint = 640) {
  const [narrow, setNarrow] = useState(() => window.matchMedia(`(max-width: ${breakpoint}px)`).matches);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [breakpoint]);
  return narrow;
}

const RouterStage = memo(function RouterStage({ state, frame, lambda, mu, layout }: { state: TrafficState; frame: number; lambda: number; mu: number; layout: Layout }) {
  const L = layout;
  const SOURCE = { x: L.source, y: Y }, SERVER = { x: L.server, y: Y }, SINK = { x: L.sink, y: Y };
  const slot = (index: number) => ({ x: L.head - index * L.gap, y: Y });
  const bufferLeft = L.head - L.slots * L.gap + 14;
  const bufferMid = bufferLeft + (L.slots * L.gap + 4) / 2;
  const shapes: Array<{ id: number; x: number; y: number; kind: "queued" | "serving" | "leaving"; title: string }> = [];
  state.queue.slice(0, L.slots).forEach((id, index) => {
    const p = state.packets[id];
    if (!p) return;
    const at = p.bornFrame >= frame ? SOURCE : slot(index);
    shapes.push({ id, ...at, kind: "queued", title: `Packet #${id} · waiting since t = ${p.arrivedAt.toFixed(2)}` });
  });
  if (state.serving !== null && state.packets[state.serving]) {
    const p = state.packets[state.serving];
    const at = p.bornFrame >= frame ? SOURCE : SERVER;
    shapes.push({ id: p.id, ...at, kind: "serving", title: `Packet #${p.id} · in service, waited ${(p.wait ?? 0).toFixed(2)}` });
  }
  for (const id of state.leaving) {
    const p = state.packets[id];
    if (p) shapes.push({ id, ...SINK, kind: "leaving", title: `Packet #${id} · delivered, delay ${(p.delay ?? 0).toFixed(2)}` });
  }
  shapes.sort((a, b) => a.id - b.id); // stable DOM order keeps CSS transitions running
  const hidden = Math.max(0, state.queue.length - L.slots);
  const label = { fontSize: 15 * L.scale };
  const sub = { fontSize: 13 * L.scale };

  return (
    <svg className="router-stage" viewBox={`0 0 ${L.width} 200`} role="img"
      aria-label={`${state.queue.length} packets waiting in the buffer, ${state.serving === null ? "server idle" : "one packet in service"}`}>
      <line className="stage-wire" x1={L.source + 30} x2={bufferLeft} y1={Y} y2={Y} />
      <line className="stage-wire" x1={L.head + 20} x2={L.server - 40} y1={Y} y2={Y} />
      <line className="stage-wire" x1={L.server + 40} x2={L.sink - 20} y1={Y} y2={Y} />
      <rect className="stage-buffer" x={bufferLeft} y={82} width={L.slots * L.gap + 4} height={56} rx={8} />
      <circle className="stage-node" cx={L.source} cy={Y} r={30} />
      <circle className={`stage-node stage-server ${state.serving === null ? "" : "is-busy"}`} cx={L.server} cy={Y} r={38} />
      <circle className="stage-node" cx={L.sink} cy={Y} r={22} />
      <text className="stage-label" style={label} x={L.source} y={34} textAnchor="middle">Arrivals</text>
      <text className="stage-sub" style={sub} x={L.source} y={54} textAnchor="middle">λ = {lambda}</text>
      <text className="stage-label" style={label} x={bufferMid} y={34} textAnchor="middle">Buffer · FIFO</text>
      <text className="stage-sub" style={sub} x={bufferMid} y={54} textAnchor="middle">{state.queue.length} waiting</text>
      <text className="stage-label" style={label} x={L.server} y={34} textAnchor="middle">Server</text>
      <text className="stage-sub" style={sub} x={L.server} y={54} textAnchor="middle">μ = {mu}</text>
      <text className="stage-label" style={label} x={L.sink} y={34} textAnchor="middle">Out</text>
      <text className="stage-sub" style={sub} x={L.sink} y={54} textAnchor="middle">{state.stats?.served ?? 0}</text>
      {hidden > 0 && <text className="stage-overflow" style={sub} x={bufferMid} y={170} textAnchor="middle">+{hidden} more waiting</text>}
      {shapes.map((s) => (
        <g key={s.id} className={`packet packet-${s.kind}`} style={{ transform: `translate(${s.x}px, ${s.y}px)` }}>
          <title>{s.title}</title>
          <rect x={-11} y={-11} width={22} height={22} rx={5} />
        </g>
      ))}
    </svg>
  );
});

// ---------------------------------------------------------------------------
// Charts (single y-axis each; x is simulated time over the whole run)
// ---------------------------------------------------------------------------

const W = 600, H = 230, PAD = { left: 40, right: 12, top: 12, bottom: 28 };
const plotW = W - PAD.left - PAD.right, plotH = H - PAD.top - PAD.bottom;

function Axes({ duration, scale }: { duration: number; scale: { max: number; step: number } }) {
  const yTicks: number[] = [];
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) yTicks.push(v);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * duration);
  const label = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return (
    <g className="chart-axes">
      {yTicks.map((v) => {
        const y = PAD.top + plotH - (v / scale.max) * plotH;
        return <g key={`y${v}`}><line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} /><text x={PAD.left - 8} y={y + 4} textAnchor="end">{label(v)}</text></g>;
      })}
      {xTicks.map((v, i) => <text key={`x${v}`} x={PAD.left + (v / duration) * plotW} y={H - 6} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}>{Math.round(v)}</text>)}
    </g>
  );
}

function useHover() {
  const [x, setX] = useState<number | null>(null);
  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const sx = ((event.clientX - box.left) / box.width) * W;
    setX(sx >= PAD.left && sx <= W - PAD.right ? sx : null);
  };
  return { x, onMove, onLeave: () => setX(null) };
}

/** Index of the last point with t <= target (points sorted by t). */
function lastAtOrBefore<T extends { t: number }>(points: T[], target: number): number {
  let lo = 0, hi = points.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= target) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

const InSystemChart = memo(function InSystemChart({ points, duration, theoryL }: { points: Point[]; duration: number; theoryL: number | null }) {
  const hover = useHover();
  const scale = niceScale(Math.max(5, ...points.map((p) => p.v), theoryL ? theoryL * 1.5 : 0));
  const sx = (t: number) => PAD.left + (t / duration) * plotW;
  const sy = (v: number) => PAD.top + plotH - (v / scale.max) * plotH;
  let d = "";
  points.forEach((p, i) => { d += i === 0 ? `M${sx(p.t)},${sy(p.v)}` : `H${sx(p.t)}V${sy(p.v)}`; });
  const hoverT = hover.x === null ? null : ((hover.x - PAD.left) / plotW) * duration;
  const idx = hoverT === null ? -1 : lastAtOrBefore(points, hoverT);
  const last = points[points.length - 1];
  return (
    <svg className="live-chart" viewBox={`0 0 ${W} ${H}`} onPointerMove={hover.onMove} onPointerLeave={hover.onLeave}
      role="img" aria-label={`Packets in system over time; currently ${last?.v ?? 0}${theoryL ? `, theory average ${theoryL}` : ""}`}>
      <Axes duration={duration} scale={scale} />
      {theoryL !== null && <>
        <line className="chart-ref" x1={PAD.left} x2={W - PAD.right} y1={sy(theoryL)} y2={sy(theoryL)} />
        <text className="chart-ref-label" x={W - PAD.right - 4} y={sy(theoryL) - 5} textAnchor="end">theory L = {theoryL.toFixed(2)}</text>
      </>}
      {d && <path className="chart-step" d={d} />}
      {hoverT !== null && idx >= 0 && hoverT <= (last?.t ?? 0) && (
        <g className="chart-hover">
          <line x1={hover.x!} x2={hover.x!} y1={PAD.top} y2={PAD.top + plotH} />
          <circle cx={hover.x!} cy={sy(points[idx].v)} r={4} />
          <g transform={`translate(${Math.min(hover.x! + 10, W - PAD.right - 132)}, ${PAD.top + 4})`}>
            <rect width={132} height={42} rx={4} />
            <text x={9} y={17}>t = {hoverT.toFixed(1)}</text>
            <text x={9} y={34}>{points[idx].v} in system</text>
          </g>
        </g>
      )}
    </svg>
  );
});

const DelayChart = memo(function DelayChart({ delays, mean, duration, theoryW }: { delays: DelayPoint[]; mean: Point[]; duration: number; theoryW: number | null }) {
  const hover = useHover();
  const scale = niceScale(Math.max(theoryW ? theoryW * 1.5 : 5, ...delays.map((p) => p.delay)));
  const sx = (t: number) => PAD.left + (t / duration) * plotW;
  const sy = (v: number) => PAD.top + plotH - (v / scale.max) * plotH;
  const r = 3;
  const dots = delays.map((p) => `M${sx(p.t) - r},${sy(p.delay)}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`).join("");
  const meanPath = mean.map((p, i) => `${i ? "L" : "M"}${sx(p.t)},${sy(p.v)}`).join("");
  const hoverT = hover.x === null ? null : ((hover.x - PAD.left) / plotW) * duration;
  let nearest: DelayPoint | null = null;
  if (hoverT !== null && delays.length) {
    const i = lastAtOrBefore(delays, hoverT);
    const candidates = [delays[i], delays[i + 1]].filter(Boolean);
    nearest = candidates.sort((a, b) => Math.abs(a.t - hoverT) - Math.abs(b.t - hoverT))[0] ?? null;
    if (nearest && Math.abs(sx(nearest.t) - hover.x!) > 14) nearest = null;
  }
  return (
    <svg className="live-chart" viewBox={`0 0 ${W} ${H}`} onPointerMove={hover.onMove} onPointerLeave={hover.onLeave}
      role="img" aria-label={`Delay of ${delays.length} delivered packets${mean.length ? `; running mean ${mean[mean.length - 1].v.toFixed(2)}` : ""}${theoryW ? `, theory ${theoryW}` : ""}`}>
      <Axes duration={duration} scale={scale} />
      {theoryW !== null && <>
        <line className="chart-ref" x1={PAD.left} x2={W - PAD.right} y1={sy(theoryW)} y2={sy(theoryW)} />
        <text className="chart-ref-label" x={W - PAD.right - 4} y={sy(theoryW) - 5} textAnchor="end">theory W = {theoryW.toFixed(2)}</text>
      </>}
      {dots && <path className="chart-dots" d={dots} />}
      {meanPath && <path className="chart-mean-line" d={meanPath} />}
      {nearest && (
        <g className="chart-hover">
          <circle cx={sx(nearest.t)} cy={sy(nearest.delay)} r={6} />
          <g transform={`translate(${Math.min(sx(nearest.t) + 12, W - PAD.right - 172)}, ${PAD.top + 4})`}>
            <rect width={172} height={42} rx={4} />
            <text x={9} y={17}>Packet #{nearest.id}</text>
            <text x={9} y={34}>delay {nearest.delay.toFixed(2)} · t {nearest.t.toFixed(1)}</text>
          </g>
        </g>
      )}
    </svg>
  );
});

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function TrafficPage({ scenario, mockEnabled }: { scenario: MockScenario; mockEnabled: boolean }) {
  const api = useMemo(() => createApiClient(scenario), [scenario]);
  const [nodes, setNodes] = useState<Array<{ id: string; healthy: boolean }>>([]);
  const [node, setNode] = useState("");
  const [draft, setDraft] = useState<Draft>({ lambda: "0.9", mu: "1", speed: "8", duration: "300", seed: String(randomSeed()) });
  const [status, setStatus] = useState<Status>("idle");
  const [state, setState] = useState<TrafficState>(initialTraffic);
  const [frame, setFrame] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const narrow = useNarrow();

  const buffer = useRef<TrafficEvent[]>([]);
  const frameRef = useRef(0);
  const closeRef = useRef<(() => void) | null>(null);
  const statusRef = useRef<Status>("idle");
  statusRef.current = status;

  useEffect(() => {
    let active = true;
    Promise.all([api.getConfig(), api.getCluster()]).then(([config, cluster]) => {
      if (!active) return;
      const healthy = new Set(cluster.nodes.filter((n) => n.healthy).map((n) => n.id));
      const list = config.peers.map((p) => ({ id: p.id, healthy: healthy.has(p.id) }));
      setNodes(list);
      setNode((current) => current || list.find((n) => n.healthy)?.id || list[0]?.id || "");
    }).catch((cause: unknown) => active && setLoadError(cause instanceof Error ? cause.message : "Unable to load nodes."));
    return () => { active = false; };
  }, [api]);

  // Apply buffered events once per animation frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      frameRef.current += 1;
      const events = buffer.current.splice(0);
      const now = performance.now();
      setState((s) => pruneLeaving(applyEvents(s, events, frameRef.current, now), now));
      setFrame(frameRef.current);
      for (const e of events) {
        if (e.type === "error") setStatus("error");
        else if (e.type === "done") setStatus("finished");
        else if (statusRef.current === "connecting") setStatus("streaming");
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => () => closeRef.current?.(), []);

  const params = {
    lambda: Number(draft.lambda), mu: Number(draft.mu), speed: Number(draft.speed),
    duration: Number(draft.duration), seed: Number(draft.seed),
  };
  const errors = validateTraffic(params);
  const running = status === "connecting" || status === "streaming";
  const rho = params.mu > 0 ? params.lambda / params.mu : NaN;

  const start = () => {
    if (errors.length || !node) return;
    closeRef.current?.();
    buffer.current = [];
    setState(initialTraffic);
    setStatus("connecting");
    closeRef.current = api.openTraffic({ node, ...params }, (event) => buffer.current.push(event));
  };
  const stop = () => {
    closeRef.current?.();
    closeRef.current = null;
    setStatus("stopped");
  };
  const set = (key: keyof Draft, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const meta = state.meta;
  const duration = meta?.duration ?? params.duration;
  const theory = meta?.theory ?? null;
  const stats = state.stats;
  const progress = duration > 0 ? Math.min(1, state.clock / duration) : 0;

  return (
    <section className="page-content traffic-content" aria-labelledby="traffic-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">LIVE TRAFFIC</p>
          <h1 id="traffic-heading">Packet traffic</h1>
          <p className="lede">One router queue, simulated in real time on the node you pick. Every packet you see is an event from that node.</p>
        </div>
        <div className="heading-actions"><span className={`state-badge traffic-${status}`}>{running && <LoaderCircle size={14} className="button-spin" />}{statusLabels[status]}</span></div>
      </div>

      {loadError && <div className="notice notice-error" role="alert">{loadError}</div>}
      {state.error && <div className="notice notice-error" role="alert"><TriangleAlert size={15} />{state.error}</div>}

      <form className="traffic-controls" onSubmit={(e) => { e.preventDefault(); if (running) stop(); else start(); }}>
        <label className="number-field"><span className="field-label">Node</span>
          <select className="traffic-select" value={node} onChange={(e) => setNode(e.target.value)} disabled={running}>
            {nodes.map((n) => <option key={n.id} value={n.id} disabled={!n.healthy}>{n.id}{n.healthy ? "" : " · unreachable"}</option>)}
          </select>
        </label>
        <label className="number-field"><span className="field-label">Arrival rate λ</span><input type="number" step="any" min={0} value={draft.lambda} disabled={running} onChange={(e) => set("lambda", e.target.value)} /></label>
        <label className="number-field"><span className="field-label">Service rate μ</span><input type="number" step="any" min={0} value={draft.mu} disabled={running} onChange={(e) => set("mu", e.target.value)} /></label>
        <label className="number-field"><span className="field-label">Speed (time units/s)</span><input type="number" step="any" min={0} value={draft.speed} disabled={running} onChange={(e) => set("speed", e.target.value)} /></label>
        <label className="number-field"><span className="field-label">Duration</span><input type="number" step="any" min={0} value={draft.duration} disabled={running} onChange={(e) => set("duration", e.target.value)} /></label>
        <label className="number-field"><span className="field-label">Seed</span>
          <span className="seed-input"><input type="number" step={1} min={0} value={draft.seed} disabled={running} onChange={(e) => set("seed", e.target.value)} />
            <button type="button" className="seed-button" aria-label="Random seed" title="Random seed" disabled={running} onClick={() => set("seed", String(randomSeed()))}><Dices size={16} /></button></span>
        </label>
        <button className={`primary-button traffic-start ${running ? "is-stop" : ""}`} type="submit" disabled={!running && (errors.length > 0 || !node)}>
          {running ? <Square size={14} fill="currentColor" /> : <Play size={15} fill="currentColor" />}{running ? "Stop" : "Start traffic"}
        </button>
        <div className="traffic-presets" role="group" aria-label="Load presets">
          {presets.map((p) => <button type="button" key={p.label} disabled={running} onClick={() => setDraft((d) => ({ ...d, lambda: String(p.lambda), mu: String(p.mu) }))}>{p.label}</button>)}
          <span className="traffic-hint">
            ρ = {Number.isFinite(rho) ? rho.toFixed(2) : "--"} · ≈ {Number.isFinite(params.lambda * params.speed) ? (params.lambda * params.speed).toFixed(1) : "--"} packets/s · runs {Number.isFinite(params.duration / params.speed) ? Math.round(params.duration / params.speed) : "--"} s
            {rho >= 1 && rho <= 1.5 ? " · overloaded: the queue will keep growing" : ""}
          </span>
        </div>
        {errors.length > 0 && <div className="inline-warning traffic-errors"><TriangleAlert size={15} />{errors.join(" ")}</div>}
      </form>

      <div className="panel stage-panel">
        <div className="panel-title"><h2>Router</h2><span>{meta ? `node ${node} · seed ${meta.seed}` : mockEnabled ? "mock stream (computed in the browser)" : "waiting for a stream"}</span></div>
        <RouterStage state={state} frame={frame} lambda={params.lambda} mu={params.mu} layout={narrow ? COMPACT : WIDE} />
        <div className="sim-clock">
          <span>Simulated time</span>
          <div className="progress-track" role="progressbar" aria-label="Simulated time" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Math.round(state.clock)}><span className="progress-complete" style={{ width: `${progress * 100}%` }} /></div>
          <strong>{state.clock.toFixed(1)} / {duration}</strong>
        </div>
      </div>

      <dl className="traffic-tiles">
        <div><dt>Arrived</dt><dd>{stats?.arrived ?? 0}</dd></div>
        <div><dt>Delivered</dt><dd>{stats?.served ?? 0}</dd></div>
        <div><dt>In system now</dt><dd>{state.queue.length + (state.serving === null ? 0 : 1)}</dd></div>
        <div><dt>Mean delay</dt><dd>{stats?.mean_delay?.toFixed(2) ?? "--"}<small>{theory ? ` theory ${theory.W.toFixed(2)}` : ""}</small></dd></div>
        <div><dt>Utilization</dt><dd>{stats ? `${(stats.utilization * 100).toFixed(0)}%` : "--"}<small>{theory ? ` theory ${(theory.rho * 100).toFixed(0)}%` : ""}</small></dd></div>
        <div><dt>Throughput</dt><dd>{stats?.throughput.toFixed(2) ?? "--"}<small>{meta ? ` offered ${meta.lambda}` : ""}</small></dd></div>
      </dl>

      <div className="traffic-charts">
        <div className="panel">
          <div className="panel-title"><h2>Packets in system</h2><span>packets (buffer + server) vs simulated time</span></div>
          <InSystemChart points={state.inSystem} duration={duration} theoryL={theory?.L ?? null} />
        </div>
        <div className="panel">
          <div className="panel-title"><h2>Packet delay</h2><span>arrival to delivery, by delivery time</span></div>
          <ul className="chart-legend" aria-label="Legend">
            <li><i className="legend-dot" />Each packet</li>
            <li><i className="legend-line" />Running mean</li>
            {theory && <li><i className="legend-ref" />Theory W</li>}
          </ul>
          <DelayChart delays={state.delays} mean={state.meanDelay} duration={duration} theoryW={theory?.W ?? null} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-title"><h2>Event feed</h2><span>latest packet events · t is simulated time</span></div>
        {state.feed.length === 0
          ? <p className="metric-empty">Start the traffic to see packets arrive, wait and get delivered.</p>
          : <ol className="event-feed">{state.feed.slice().reverse().map((line, i) => <li key={`${state.feed.length}-${i}`}>{line}</li>)}</ol>}
      </div>
    </section>
  );
}
