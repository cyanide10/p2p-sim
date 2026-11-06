import { Dices, Play, Square, TriangleAlert } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "../api/client";
import { PanelTitle, Notice, PageHeading, StatStrip } from "../components/PagePrimitives";
import { LineChart } from "../components/charts/LineChart";
import { ProgressBar, StateBadge, type BadgeTone } from "../components/RunBits";
import { lastAtOrBefore, nearestIndex, niceScale, seriesSummary, timeTicks } from "../lib/chart";
import type { MockScenario } from "../api/types";
import {
  applyEvents, initialTraffic, pruneLeaving, validateTraffic,
  type DelayPoint, type Point, type TrafficEvent, type TrafficState,
} from "../lib/traffic";

type Status = "idle" | "connecting" | "streaming" | "finished" | "stopped" | "error";

const statusLabels: Record<Status, string> = {
  idle: "Idle", connecting: "Connecting", streaming: "Streaming", finished: "Finished", stopped: "Stopped", error: "Error",
};

const statusTone: Record<Status, BadgeTone> = {
  idle: "neutral", connecting: "active", streaming: "active",
  finished: "good", stopped: "neutral", error: "bad",
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

const RouterStage = memo(function RouterStage({ state, frame, layout }: { state: TrafficState; frame: number; layout: Layout }) {
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
      <text className="stage-label" style={label} x={bufferMid} y={34} textAnchor="middle">Buffer · FIFO</text>
      <text className="stage-sub" style={sub} x={bufferMid} y={54} textAnchor="middle">{state.queue.length} waiting</text>
      <text className="stage-label" style={label} x={L.server} y={34} textAnchor="middle">Server</text>
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
const plotW = W - PAD.left - PAD.right;

const InSystemChart = memo(function InSystemChart({ points, duration, theoryL }: { points: Point[]; duration: number; theoryL: number | null }) {
  const scale = niceScale(Math.max(5, ...points.map((p) => p.v), theoryL ? theoryL * 1.5 : 0));
  const summary = seriesSummary("Packets in system", points.map((point) => point.v));
  return (
    <LineChart
      width={W}
      height={H}
      pad={PAD}
      xDomain={[0, duration]}
      xTicks={timeTicks(duration)}
      yMax={scale.max}
      yStep={scale.step}
      className="live-chart"
      ariaLabel={`${summary}${theoryL ? ` Theory average ${theoryL}.` : ""}`}
      indexCount={points.length}
      indexAtX={(domainX) => lastAtOrBefore(points, domainX)}
      series={[{ points: points.map((point) => ({ x: point.t, y: point.v })), className: "chart-step", step: true }]}
      overlay={(geometry, hoverIndex) => {
        const hovered = hoverIndex === null ? null : points[hoverIndex] ?? null;
        return (
          <>
            {theoryL !== null && <>
              <line className="chart-ref" x1={geometry.plotLeft} x2={geometry.plotRight} y1={geometry.y(theoryL)} y2={geometry.y(theoryL)} />
              <text className="chart-ref-label" x={geometry.plotRight - 4} y={geometry.y(theoryL) - 5} textAnchor="end">theory L = {theoryL.toFixed(2)}</text>
            </>}
            {hovered && (
              <g className="chart-hover">
                <line x1={geometry.x(hovered.t)} x2={geometry.x(hovered.t)} y1={geometry.plotTop} y2={geometry.plotBottom} />
                <circle cx={geometry.x(hovered.t)} cy={geometry.y(hovered.v)} r={4} />
                <g transform={`translate(${Math.min(geometry.x(hovered.t) + 10, geometry.plotRight - 132)}, ${geometry.plotTop + 4})`}>
                  <rect width={132} height={42} rx={4} />
                  <text x={9} y={17}>t = {hovered.t.toFixed(1)}</text>
                  <text x={9} y={34}>{hovered.v} in system</text>
                </g>
              </g>
            )}
          </>
        );
      }}
    />
  );
});

const DelayChart = memo(function DelayChart({ delays, mean, duration, theoryW }: { delays: DelayPoint[]; mean: Point[]; duration: number; theoryW: number | null }) {
  const scale = niceScale(Math.max(theoryW ? theoryW * 1.5 : 5, ...delays.map((p) => p.delay)));
  const summary = seriesSummary("Packet delay", delays.map((point) => point.delay), (value) => value.toFixed(2));
  return (
    <LineChart
      width={W}
      height={H}
      pad={PAD}
      xDomain={[0, duration]}
      xTicks={timeTicks(duration)}
      yMax={scale.max}
      yStep={scale.step}
      className="live-chart"
      ariaLabel={`${summary}${mean.length ? ` Running mean ${mean[mean.length - 1].v.toFixed(2)}.` : ""}${theoryW ? ` Theory ${theoryW}.` : ""}`}
      indexCount={delays.length}
      indexAtX={(domainX, pixelX) => {
        if (!delays.length) return null;
        const index = nearestIndex(delays, domainX);
        if (index < 0) return null;
        const pointX = PAD.left + (delays[index].t / duration) * plotW;
        return Math.abs(pointX - pixelX) > 14 ? null : index;
      }}
      series={[{ points: mean.map((point) => ({ x: point.t, y: point.v })), className: "chart-mean-line" }]}
      overlay={(geometry, hoverIndex) => {
        const r = 3;
        const dots = delays.map((point) => `M${geometry.x(point.t) - r},${geometry.y(point.delay)}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`).join("");
        const nearest = hoverIndex === null ? null : delays[hoverIndex] ?? null;
        return (
          <>
            {theoryW !== null && <>
              <line className="chart-ref" x1={geometry.plotLeft} x2={geometry.plotRight} y1={geometry.y(theoryW)} y2={geometry.y(theoryW)} />
              <text className="chart-ref-label" x={geometry.plotRight - 4} y={geometry.y(theoryW) - 5} textAnchor="end">theory W = {theoryW.toFixed(2)}</text>
            </>}
            {dots && <path className="chart-dots" d={dots} />}
            {nearest && (
              <g className="chart-hover">
                <circle cx={geometry.x(nearest.t)} cy={geometry.y(nearest.delay)} r={6} />
                <g transform={`translate(${Math.min(geometry.x(nearest.t) + 12, geometry.plotRight - 172)}, ${geometry.plotTop + 4})`}>
                  <rect width={172} height={42} rx={4} />
                  <text x={9} y={17}>Packet #{nearest.id}</text>
                  <text x={9} y={34}>delay {nearest.delay.toFixed(2)} · t {nearest.t.toFixed(1)}</text>
                </g>
              </g>
            )}
          </>
        );
      }}
    />
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

  // Apply buffered events once per animation frame while a stream runs, then
  // until departing packets have finished animating; idle pages do not re-render.
  const rafRef = useRef(0);
  const leavingRef = useRef(false);
  const animate = () => {
    if (rafRef.current) return;
    const tick = () => {
      frameRef.current += 1;
      const events = buffer.current.splice(0);
      const now = performance.now();
      setState((s) => {
        const next = pruneLeaving(applyEvents(s, events, frameRef.current, now), now);
        leavingRef.current = next.leaving.length > 0;
        return next;
      });
      setFrame(frameRef.current);
      for (const e of events) {
        if (e.type === "error") setStatus("error");
        else if (e.type === "done") setStatus("finished");
        else if (statusRef.current === "connecting") setStatus("streaming");
      }
      const streaming = statusRef.current === "connecting" || statusRef.current === "streaming";
      rafRef.current = streaming || events.length > 0 || buffer.current.length > 0 || leavingRef.current ? requestAnimationFrame(tick) : 0;
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => {
    closeRef.current?.();
    cancelAnimationFrame(rafRef.current);
  }, []);

  const params = {
    lambda: Number(draft.lambda), mu: Number(draft.mu), speed: Number(draft.speed),
    duration: Number(draft.duration), seed: Number(draft.seed),
  };
  const errors = validateTraffic(params);
  const running = status === "connecting" || status === "streaming";
  const packetsPerSecond = params.lambda * params.speed;
  const runSeconds = params.duration / params.speed;

  const start = () => {
    if (errors.length || !node) return;
    closeRef.current?.();
    buffer.current = [];
    setState(initialTraffic);
    setStatus("connecting");
    statusRef.current = "connecting";
    closeRef.current = api.openTraffic({ node, ...params }, (event) => buffer.current.push(event));
    animate();
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

  return (
    <section className="page-content traffic-content" aria-labelledby="traffic-heading">
      <PageHeading
        id="traffic-heading"
        eyebrow="LIVE TRAFFIC"
        title="Traffic"
        lede="One router queue, simulated in real time on the node you pick. Every packet you see is an event from that node."
        actions={<StateBadge label={statusLabels[status]} tone={statusTone[status]} busy={running} />}
      />

      {loadError && <Notice kind="error">{loadError}</Notice>}
      {state.error && <Notice kind="error"><TriangleAlert size={15} />{state.error}</Notice>}

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
            Work arriving vs service rate · ρ ≥ 1 grows the queue
            {Number.isFinite(packetsPerSecond) && ` · ≈ ${packetsPerSecond.toFixed(1)} packets/s`}
            {Number.isFinite(runSeconds) && ` · runs ${Math.round(runSeconds)} s`}
          </span>
        </div>
        {errors.length > 0 && <div className="inline-warning traffic-errors"><TriangleAlert size={15} />{errors.join(" ")}</div>}
      </form>

      <div className="panel stage-panel">
        <PanelTitle title="Router" note={meta ? `node ${node} · seed ${meta.seed}` : mockEnabled ? "mock stream (computed in the browser)" : "waiting for a stream"} />
        <RouterStage state={state} frame={frame} layout={narrow ? COMPACT : WIDE} />
        <div className="sim-clock">
          <ProgressBar done={state.clock} total={duration} label="Simulated time" />
        </div>
      </div>

      <StatStrip variant="tiles" items={[
        { label: "Arrived", value: stats?.arrived ?? 0 },
        { label: "Delivered", value: stats?.served ?? 0 },
        { label: "In system now", value: state.queue.length + (state.serving === null ? 0 : 1) },
        { label: "Mean delay", value: stats?.mean_delay?.toFixed(2) ?? "--", small: theory ? ` theory ${theory.W.toFixed(2)}` : "" },
        { label: "Utilization", value: stats ? `${(stats.utilization * 100).toFixed(0)}%` : "--", small: theory ? ` theory ${(theory.rho * 100).toFixed(0)}%` : "" },
        { label: "Throughput", value: stats?.throughput.toFixed(2) ?? "--", small: meta ? ` offered ${meta.lambda}` : "" },
      ]} />

      <div className="traffic-charts">
        <div className="panel">
          <PanelTitle title="Packets in system" note="packets (buffer + server) vs simulated time" />
          <InSystemChart points={state.inSystem} duration={duration} theoryL={theory?.L ?? null} />
        </div>
        <div className="panel">
          <PanelTitle title="Packet delay" note="arrival to delivery, by delivery time" />
          <ul className="chart-legend" aria-label="Legend">
            <li><i className="legend-dot" />Each packet</li>
            <li><i className="legend-line" />Running mean</li>
            {theory && <li><i className="legend-ref" />Theory W</li>}
          </ul>
          <DelayChart delays={state.delays} mean={state.meanDelay} duration={duration} theoryW={theory?.W ?? null} />
        </div>
      </div>

      <div className="panel">
        <PanelTitle title="Event feed" note="latest packet events · t is simulated time" />
        {state.feed.length === 0
          ? <p className="metric-empty">Start the traffic to see packets arrive, wait and get delivered.</p>
          : <ol className="event-feed">{state.feed.slice().reverse().map((line, i) => <li key={`${state.feed.length}-${i}`}>{line}</li>)}</ol>}
      </div>
    </section>
  );
}
