import { LoaderCircle, Pause, Play, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client";
import { applyNetEvents, flowSlot, initialLive, playbackSpeeds, toWire, type NetLiveState, type NetStreamEvent, type Scenario } from "../lib/network";
import { TopologyCanvas } from "./TopologyCanvas";

type Status = "idle" | "connecting" | "playing" | "paused" | "finished" | "error";

const statusText: Record<Status, string> = {
  idle: "Ready", connecting: "Starting", playing: "Playing", paused: "Paused", finished: "Finished", error: "Error",
};

interface Props {
  api: ApiClient;
  scenario: Scenario;
  /** Copies that can be replayed: seed per copy. One entry hides the copy picker. */
  copies: Array<{ label: string; seed: number }>;
  autoPlay?: boolean;
  defaultNode?: string;
  /** Extra controls rendered at the start of the control bar (e.g. "Back to editor"). */
  leading?: React.ReactNode;
}

/**
 * Plays one copy of a network run as an animation. A node simulates the copy
 * in real time and streams its packets; pausing stops the stream, and playing
 * or seeking restarts it at that simulated time. The seed fixes every packet,
 * so the same moment always looks the same.
 */
export function NetworkPlayer({ api, scenario, copies, autoPlay = false, defaultNode, leading }: Props) {
  const speeds = playbackSpeeds(scenario);
  const [pool, setPool] = useState<Array<{ id: string; healthy: boolean }>>([]);
  const [node, setNode] = useState(defaultNode ?? "");
  const [copy, setCopy] = useState(0);
  const [speed, setSpeed] = useState(() => (speeds.includes(1) ? 1 : speeds[speeds.length - 1]));
  const [status, setStatus] = useState<Status>("idle");
  const [live, setLive] = useState<NetLiveState>(initialLive);
  const [now, setNow] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const buffer = useRef<NetStreamEvent[]>([]);
  const closeRef = useRef<(() => void) | null>(null);
  const started = useRef(false);
  const flowIndex = Object.fromEntries(scenario.flows.map((f, i) => [f.id, i]));
  const duration = scenario.duration;
  const seed = copies[copy]?.seed ?? 0;

  useEffect(() => {
    let active = true;
    Promise.all([api.getConfig(), api.getCluster()]).then(([config, cluster]) => {
      if (!active) return;
      const healthy = new Set(cluster.nodes.filter((n) => n.healthy).map((n) => n.id));
      const list = config.peers.map((p) => ({ id: p.id, healthy: healthy.has(p.id) }));
      setPool(list);
      setNode((current) => (current && healthy.has(current) ? current : list.find((n) => n.healthy)?.id ?? list[0]?.id ?? ""));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api]);

  const play = (from: number, overrides: { speed?: number; seed?: number; node?: string } = {}) => {
    const target = overrides.node ?? node;
    if (!target) return;
    closeRef.current?.();
    buffer.current = [];
    setStatus("connecting");
    const start = Math.max(0, Math.min(from, duration - 0.01));
    closeRef.current = api.openNetworkTraffic(target, toWire(scenario), overrides.speed ?? speed, overrides.seed ?? seed, start, (e) => buffer.current.push(e));
  };
  const pause = () => {
    closeRef.current?.();
    closeRef.current = null;
    setStatus("paused");
  };

  useEffect(() => {
    if (autoPlay && node && !started.current) {
      started.current = true;
      play(0);
    }
  }, [autoPlay, node]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => closeRef.current?.(), []);

  // Apply streamed events once per frame. Paused: nothing moves.
  useEffect(() => {
    if (status !== "playing" && status !== "connecting") return;
    let raf = 0;
    const tick = () => {
      const events = buffer.current.splice(0);
      const t = performance.now();
      setLive((s) => applyNetEvents(s, events, t));
      setNow(t);
      for (const e of events) {
        if (e.type === "error") setStatus("error");
        else if (e.type === "done") setStatus("finished");
        else if (e.type !== "meta") setStatus((s) => (s === "connecting" ? "playing" : s));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  const running = status === "playing" || status === "connecting";
  const shownT = scrub ?? live.clock;
  const commitScrub = () => {
    if (scrub === null) return;
    const t = scrub;
    setScrub(null);
    play(t);
  };

  return (
    <div className="player">
      <div className="player-bar">
        {leading}
        {running
          ? <button type="button" className="primary-button player-btn" onClick={pause}><Pause size={14} fill="currentColor" />Pause</button>
          : status === "finished"
            ? <button type="button" className="primary-button player-btn" onClick={() => play(0)}><RotateCcw size={14} />Replay</button>
            : <button type="button" className="primary-button player-btn" disabled={!node} onClick={() => play(status === "paused" ? live.clock : 0)}><Play size={14} fill="currentColor" />{status === "paused" ? "Resume" : "Play"}</button>}
        <span className={`state-badge player-status player-${status}`}>{status === "connecting" && <LoaderCircle size={13} className="button-spin" />}{status === "connecting" && live.clock > 0 ? "Seeking" : statusText[status]}</span>
        <label className="player-slider">
          <span className="sr-only">Simulated time</span>
          <input type="range" min={0} max={duration} step={duration / 1000} value={shownT}
            onChange={(e) => setScrub(Number(e.target.value))} onPointerUp={commitScrub} onKeyUp={commitScrub} onBlur={commitScrub} />
        </label>
        <strong className="player-time">t = {shownT.toFixed(1)} / {duration} s</strong>
        <label className="net-field player-field"><span>Speed</span>
          <select value={speed} onChange={(e) => { const v = Number(e.target.value); setSpeed(v); if (running) play(live.clock, { speed: v }); }}>
            {speeds.map((v) => <option key={v} value={v}>{v}×</option>)}
          </select></label>
        {copies.length > 1 && <label className="net-field player-field"><span>Copy</span>
          <select value={copy} onChange={(e) => { const i = Number(e.target.value); setCopy(i); if (running || status === "finished" || status === "paused") play(0, { seed: copies[i].seed }); }}>
            {copies.map((c, i) => <option key={c.seed} value={i}>{c.label}</option>)}
          </select></label>}
        <label className="net-field player-field"><span>Computed on</span>
          <select value={node} onChange={(e) => { setNode(e.target.value); if (running) play(live.clock, { node: e.target.value }); }}>
            {pool.map((n) => <option key={n.id} value={n.id} disabled={!n.healthy}>{n.id}{n.healthy ? "" : " · down"}</option>)}
          </select></label>
      </div>
      {live.error && <div className="notice notice-error" role="alert"><TriangleAlert size={15} />{live.error}</div>}

      <div className="player-layout">
        <div className="net-canvas player-canvas">
          <TopologyCanvas scenario={scenario} mode="live" live={live} now={now} flowIndex={flowIndex} />
          {status === "idle" && <button type="button" className="player-overlay" onClick={() => play(0)} disabled={!node}><Play size={28} fill="currentColor" /><span>Play {copies.length > 1 ? copies[copy].label.toLowerCase() : "the traffic"}</span></button>}
        </div>
        <aside className="net-side">
          <section className="net-panel">
            <h2>Flows</h2>
            <div className="table-scroll">
              <table className="net-table">
                <thead><tr><th scope="col">Flow</th><th scope="col">Sent</th><th scope="col">Delivered</th><th scope="col">Dropped</th><th scope="col">Delay</th></tr></thead>
                <tbody>{scenario.flows.map((f, i) => {
                  const s = live.flows[f.id];
                  const noRoute = live.routes[f.id]?.length === 0;
                  return <tr key={f.id}><th scope="row"><i className="flow-swatch" style={{ background: flowSlot(i) }} />{f.id}{noRoute && <span className="net-noroute" title="No route to destination">no route</span>}</th>
                    <td>{s?.sent ?? 0}</td><td>{s?.delivered ?? 0}</td><td className={s?.dropped ? "count-bad" : ""}>{s?.dropped ?? 0}</td><td>{s?.mean_delay != null ? `${(s.mean_delay * 1000).toFixed(0)} ms` : "--"}</td></tr>;
                })}</tbody>
              </table>
            </div>
          </section>
          <section className="net-panel">
            <h2>Legend</h2>
            <ul className="net-legend">
              <li><i className="legend-dot" style={{ background: "var(--flow-0)" }} />Moving dot: a packet, colored by its flow</li>
              <li><i className="legend-load" />Link thickness and darkness: load right now</li>
              <li><span className="topo-congested-chip">⚠ 92%</span>Link nearly saturated (≥ 85%)</li>
              <li><span className="topo-queue-chip">7</span>Packets waiting in a router</li>
              <li><span className="topo-drop-chip">✕</span>Packet dropped there</li>
              <li><span className="topo-down-chip">✕ DOWN</span>Failed link or router</li>
            </ul>
          </section>
          <section className="net-panel">
            <h2>Events</h2>
            {live.feed.length === 0 ? <p className="net-help">Failures, reroutes and drops appear here.</p>
              : <ol className="event-feed">{live.feed.slice().reverse().map((line, i) => <li key={`${live.feed.length}-${i}`}>{line}</li>)}</ol>}
          </section>
        </aside>
      </div>
    </div>
  );
}
