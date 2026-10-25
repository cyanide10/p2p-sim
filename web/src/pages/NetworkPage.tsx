import { ArrowLeft, CircleDot, Download, FilePlus2, Link2, LoaderCircle, MousePointer2, Play, Plus, Server, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createApiClient } from "../api/client";
import type { MockScenario } from "../api/types";
import { NetworkPlayer } from "../components/NetworkPlayer";
import { TopologyCanvas, type Selection, type Tool } from "../components/TopologyCanvas";
import {
  checkScenario, cloneScenario, flowSlot, nextId, offeredPackets, parseScenario,
  SAMPLES, toWire, type Flow, type FlowPattern, type Scenario,
} from "../lib/network";

const STORAGE_KEY = "p2p-sim-network";

function loadSaved(): Scenario {
  try {
    const saved = parseScenario(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
    if (saved) return saved;
  } catch { /* fall through to the sample */ }
  return cloneScenario(SAMPLES[0].scenario);
}

/** Number input that lets the user type freely and commits only valid numbers. */
function NumInput({ value, onChange, min = 0, step = "any", label, disabled }: { value: number; onChange: (v: number) => void; min?: number; step?: string; label: string; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { if (Number(text) !== value) setText(String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="net-field"><span>{label}</span>
      <input type="number" min={min} step={step} value={text} disabled={disabled} aria-invalid={!Number.isFinite(Number(text)) || Number(text) < min}
        onChange={(e) => { setText(e.target.value); const v = Number(e.target.value); if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= min) onChange(v); }} />
    </label>
  );
}

function scheduleText(points: Array<{ t: number; rate: number }>) {
  return points.map((p) => `${p.t}:${p.rate}`).join(", ");
}

function parseSchedule(text: string): Array<{ t: number; rate: number }> | null {
  const points = text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const [t, rate] = part.split(":").map((v) => Number(v.trim()));
    return { t, rate };
  });
  return points.length && points.every((p) => Number.isFinite(p.t) && p.t >= 0 && Number.isFinite(p.rate) && p.rate >= 0) ? points : null;
}

function ScheduleInput({ points, onChange }: { points: Array<{ t: number; rate: number }>; onChange: (p: Array<{ t: number; rate: number }>) => void }) {
  const [text, setText] = useState(scheduleText(points));
  const valid = parseSchedule(text) !== null;
  return (
    <label className="net-field net-field-wide"><span>Schedule (time:rate, …)</span>
      <input value={text} aria-invalid={!valid} placeholder="0:10, 60:40, 120:10"
        onChange={(e) => { setText(e.target.value); const parsed = parseSchedule(e.target.value); if (parsed) onChange(parsed); }} />
    </label>
  );
}

const patternLabel: Record<FlowPattern["type"], string> = { constant: "Steady", schedule: "Rate schedule", onoff: "Bursty on/off" };

export function NetworkPage({ scenario: mockScenario }: { scenario: MockScenario; mockEnabled: boolean }) {
  const api = useMemo(() => createApiClient(mockScenario), [mockScenario]);
  const [sc, setSc] = useState<Scenario>(loadSaved);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<Selection>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [pool, setPool] = useState<Array<{ id: string; healthy: boolean }>>([]);
  const [liveNode, setLiveNode] = useState("");
  const [coordinator, setCoordinator] = useState("");
  const [copies, setCopies] = useState(30);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1_000_000));
  const [view, setView] = useState<"edit" | "live">("edit");
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sc)); } catch { /* storage unavailable */ }
  }, [sc]);

  useEffect(() => {
    let active = true;
    Promise.all([api.getConfig(), api.getCluster()]).then(([config, cluster]) => {
      if (!active) return;
      const healthy = new Set(cluster.nodes.filter((n) => n.healthy).map((n) => n.id));
      const list = config.peers.map((p) => ({ id: p.id, healthy: healthy.has(p.id) }));
      setPool(list);
      const first = list.find((n) => n.healthy)?.id ?? list[0]?.id ?? "";
      setLiveNode((v) => v || first);
      setCoordinator((v) => v || first);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api]);


  const errors = checkScenario(sc);
  const flowIndex = Object.fromEntries(sc.flows.map((f, i) => [f.id, i]));
  const hosts = sc.nodes.filter((n) => n.kind === "host");

  const update = (fn: (draft: Scenario) => void) => setSc((current) => { const draft = cloneScenario(current); fn(draft); return draft; });

  const place = (x: number, y: number) => {
    const kind = tool === "router" ? "router" : "host";
    const id = nextId(kind === "router" ? "r" : "h", sc.nodes.map((n) => n.id));
    update((d) => d.nodes.push(kind === "router" ? { id, kind, x, y, service_rate: 100, buffer: 50 } : { id, kind, x, y }));
    setSelected({ kind: "node", id });
  };

  const linkEnd = (id: string) => {
    if (!pendingLink) return setPendingLink(id);
    if (pendingLink === id) return setPendingLink(null);
    const exists = sc.links.some((l) => (l.a === pendingLink && l.b === id) || (l.a === id && l.b === pendingLink));
    if (!exists) {
      const lid = nextId("l", [...sc.links.map((l) => l.id), ...sc.nodes.map((n) => n.id)]);
      const a = pendingLink;
      update((d) => d.links.push({ id: lid, a, b: id, bandwidth: 100, delay: 0.005, buffer: 50 }));
      setSelected({ kind: "link", id: lid });
    }
    setPendingLink(null);
  };

  const remove = (sel: NonNullable<Selection>) => {
    update((d) => {
      if (sel.kind === "node") {
        const gone = new Set([sel.id, ...d.links.filter((l) => l.a === sel.id || l.b === sel.id).map((l) => l.id)]);
        d.nodes = d.nodes.filter((n) => n.id !== sel.id);
        d.links = d.links.filter((l) => !gone.has(l.id));
        d.flows = d.flows.filter((f) => f.src !== sel.id && f.dst !== sel.id);
        d.events = d.events.filter((e) => !gone.has(e.target));
      } else {
        d.links = d.links.filter((l) => l.id !== sel.id);
        d.events = d.events.filter((e) => e.target !== sel.id);
      }
    });
    setSelected(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view !== "edit" || (e.target as HTMLElement).closest("input, select, textarea")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) { e.preventDefault(); remove(selected); }
      if (e.key === "Escape") { setPendingLink(null); setSelected(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const addFlow = () => {
    if (hosts.length < 2) return setNotice({ kind: "error", text: "Add at least two hosts first." });
    const id = nextId("f", sc.flows.map((f) => f.id));
    update((d) => d.flows.push({ id, src: hosts[0].id, dst: hosts[hosts.length - 1].id, rate: 10, pattern: { type: "constant" } }));
  };
  const setFlow = (id: string, patch: Partial<Flow>) => update((d) => { const f = d.flows.find((x) => x.id === id); if (f) Object.assign(f, patch); });
  const setPattern = (flow: Flow, type: FlowPattern["type"]) => {
    const pattern: FlowPattern = type === "schedule" ? { type, interpolate: "step", points: [{ t: 0, rate: flow.rate }, { t: Math.round(sc.duration / 2), rate: flow.rate * 2 }] }
      : type === "onoff" ? { type, on_mean: 5, off_mean: 5 } : { type };
    setFlow(flow.id, { pattern });
  };
  const failTargets = [...sc.links.map((l) => l.id), ...sc.nodes.filter((n) => n.kind === "router").map((n) => n.id)];

  const startLive = () => {
    if (errors.length || !liveNode) return;
    setSelected(null);
    setNotice(null);
    setView("live");
  };

  const runCluster = async () => {
    if (errors.length || !coordinator) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const created = await api.createNetworkRun(coordinator, toWire(sc), copies, seed);
      window.location.hash = `#/live/${encodeURIComponent(created.run_id)}`;
    } catch (cause) {
      const busy = cause instanceof ApiError && cause.status === 409;
      setNotice({ kind: "error", text: busy ? `${coordinator} is already coordinating a network run; pick another coordinator or wait.` : cause instanceof Error ? cause.message : "Could not start the run." });
    } finally {
      setSubmitting(false);
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(toWire(sc), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "network.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseScenario(JSON.parse(await file.text()));
      if (!parsed) throw new Error("not a network scenario");
      setSc(parsed);
      setSelected(null);
      setNotice({ kind: "info", text: `Loaded ${file.name}.` });
    } catch (cause) {
      setNotice({ kind: "error", text: `Could not import ${file.name}: ${cause instanceof Error ? cause.message : "invalid file"}.` });
    }
  };

  const selNode = selected?.kind === "node" ? sc.nodes.find((n) => n.id === selected.id) : undefined;
  const selLink = selected?.kind === "link" ? sc.links.find((l) => l.id === selected.id) : undefined;
  const tools: Array<{ id: Tool; label: string; icon: React.ReactNode; hint: string }> = [
    { id: "select", label: "Select", icon: <MousePointer2 size={15} />, hint: "Click to select, drag to move" },
    { id: "router", label: "Router", icon: <CircleDot size={15} />, hint: "Click the canvas to place a router" },
    { id: "host", label: "Host", icon: <Server size={15} />, hint: "Click the canvas to place a host" },
    { id: "link", label: "Link", icon: <Link2 size={15} />, hint: pendingLink ? `Now click the node to connect to ${pendingLink}` : "Click two nodes to connect them" },
    { id: "delete", label: "Delete", icon: <Trash2 size={15} />, hint: "Click a node or link to delete it" },
  ];

  return (
    <section className="page-content network-content" aria-labelledby="network-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">NETWORK LAB</p>
          <h1 id="network-heading">Network</h1>
          <p className="lede">Draw a network, give it traffic that changes over time and failures, then watch it live or run many copies across your nodes.</p>
        </div>
      </div>

      {notice && <div className={`notice ${notice.kind === "error" ? "notice-error" : "notice-info"}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.kind === "error" && <TriangleAlert size={15} />}{notice.text}</div>}

      <div className="net-runbar">
        <div className="net-run-group">
          <strong>Watch live</strong>
          <label className="net-field"><span>Node</span>
            <select value={liveNode} onChange={(e) => setLiveNode(e.target.value)} disabled={view === "live"}>
              {pool.map((n) => <option key={n.id} value={n.id} disabled={!n.healthy}>{n.id}{n.healthy ? "" : " · down"}</option>)}
            </select></label>
          <button type="button" className="primary-button net-btn" onClick={startLive} disabled={errors.length > 0 || !liveNode || view === "live"}><Play size={14} fill="currentColor" />Watch live</button>
        </div>
        <div className="net-run-group">
          <strong>Run on all nodes</strong>
          <label className="net-field"><span>Coordinator</span>
            <select value={coordinator} onChange={(e) => setCoordinator(e.target.value)}>
              {pool.map((n) => <option key={n.id} value={n.id} disabled={!n.healthy}>{n.id}{n.healthy ? "" : " · down"}</option>)}
            </select></label>
          <NumInput label="Copies" value={copies} onChange={(v) => setCopies(Math.round(v))} min={2} step="1" />
          <NumInput label="Seed" value={seed} onChange={(v) => setSeed(Math.round(v))} step="1" />
          <button type="button" className="primary-button net-btn" onClick={() => void runCluster()} disabled={errors.length > 0 || submitting || !coordinator}>
            {submitting ? <LoaderCircle size={14} className="button-spin" /> : <Play size={14} fill="currentColor" />}Run {copies} copies
          </button>
        </div>
        <p className="net-run-hint">
          {sc.nodes.length} nodes · {sc.links.length} links · {sc.flows.length} flows · {sc.events.length} failures · ≈ {Math.round(offeredPackets(sc)).toLocaleString()} packets per copy
        </p>
        {errors.length > 0 && <ul className="net-errors">{errors.slice(0, 5).map((e) => <li key={e}><TriangleAlert size={13} />{e}</li>)}</ul>}
      </div>

      {view === "live" ? (
        <NetworkPlayer api={api} scenario={sc} copies={[{ label: `Seed ${seed}`, seed }]} autoPlay defaultNode={liveNode}
          leading={<button type="button" className="ghost-button" onClick={() => setView("edit")}><ArrowLeft size={14} />Editor</button>} />
      ) : (
      <div className="net-layout">
        <div className="net-stage">
          <div className="net-toolbar" role="toolbar" aria-label="Editing tools">
              {tools.map((t) => (
                <button key={t.id} type="button" className={tool === t.id ? "is-active" : ""} aria-pressed={tool === t.id} title={t.hint}
                  onClick={() => { setTool(t.id); setPendingLink(null); }}>{t.icon}{t.label}</button>
              ))}
              <span className="net-toolbar-sep" />
              <select aria-label="Load a sample network" value="" onChange={(e) => { const s = SAMPLES.find((x) => x.id === e.target.value); if (s) { setSc(cloneScenario(s.scenario)); setSelected(null); } }}>
                <option value="">Samples…</option>
                {SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <button type="button" title="Start an empty network" onClick={() => { setSc({ duration: 120, nodes: [], links: [], flows: [], events: [] }); setSelected(null); setTool("router"); }}><FilePlus2 size={15} />New</button>
              <button type="button" title="Download as JSON" onClick={exportJson}><Download size={15} />Export</button>
              <button type="button" title="Load a JSON file" onClick={() => fileRef.current?.click()}><Upload size={15} />Import</button>
              <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { void importJson(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
          <p className="net-tool-hint">{tools.find((t) => t.id === tool)?.hint}{tool === "select" && selected ? " · Delete key removes the selection" : ""}</p>
          <div className="net-canvas">
            <TopologyCanvas scenario={sc} mode="edit" tool={tool} selected={selected} pendingLink={pendingLink}
              onSelect={setSelected} onPlace={place} onMove={(id, x, y) => update((d) => { const n = d.nodes.find((v) => v.id === id); if (n) { n.x = x; n.y = y; } })}
              onLinkEnd={linkEnd} onDelete={remove} flowIndex={flowIndex} />
          </div>
        </div>

        <aside className="net-side">
            <>
              <section className="net-panel" aria-labelledby="inspect-heading">
                <h2 id="inspect-heading">{selNode ? `${selNode.kind === "router" ? "Router" : "Host"} ${selNode.id}` : selLink ? `Link ${selLink.id}` : "Selection"}</h2>
                {selNode?.kind === "router" && <div className="net-grid">
                  <NumInput label="Service rate (pkt/s)" value={selNode.service_rate ?? 100} onChange={(v) => update((d) => { const n = d.nodes.find((x) => x.id === selNode.id)!; n.service_rate = v; })} />
                  <NumInput label="Buffer (packets)" value={selNode.buffer ?? 50} min={1} step="1" onChange={(v) => update((d) => { const n = d.nodes.find((x) => x.id === selNode.id)!; n.buffer = Math.round(v); })} />
                </div>}
                {selNode?.kind === "host" && <p className="net-help">Hosts send and receive flows. They never forward other traffic. {sc.flows.filter((f) => f.src === selNode.id).length} flows start here.</p>}
                {selLink && <div className="net-grid">
                  <p className="net-help net-field-wide">{selLink.a} ↔ {selLink.b}</p>
                  <NumInput label="Bandwidth (pkt/s)" value={selLink.bandwidth} onChange={(v) => update((d) => { d.links.find((x) => x.id === selLink.id)!.bandwidth = v; })} />
                  <NumInput label="Delay (ms)" value={Math.round(selLink.delay * 10000) / 10} onChange={(v) => update((d) => { d.links.find((x) => x.id === selLink.id)!.delay = v / 1000; })} step="0.1" />
                  <NumInput label="Buffer (packets)" value={selLink.buffer} min={1} step="1" onChange={(v) => update((d) => { d.links.find((x) => x.id === selLink.id)!.buffer = Math.round(v); })} />
                </div>}
                {!selNode && !selLink && <p className="net-help">Select a router or link to edit it. Routers queue packets (finite buffer, drops when full); links have bandwidth, delay and their own buffer.</p>}
                {selected && <button type="button" className="ghost-button net-remove" onClick={() => remove(selected)}><Trash2 size={14} />Delete {selected.id}</button>}
              </section>

              <section className="net-panel" aria-labelledby="flows-heading">
                <div className="net-panel-head"><h2 id="flows-heading">Flows</h2><button type="button" className="ghost-button" onClick={addFlow}><Plus size={14} />Add flow</button></div>
                {sc.flows.length === 0 && <p className="net-help">A flow is traffic from one host to another.</p>}
                {sc.flows.map((f, i) => (
                  <div className="net-flow" key={f.id}>
                    <div className="net-flow-head"><i className="flow-swatch" style={{ background: flowSlot(i) }} /><strong>{f.id}</strong>
                      <button type="button" className="icon-button net-x" aria-label={`Remove flow ${f.id}`} onClick={() => update((d) => { d.flows = d.flows.filter((x) => x.id !== f.id); })}><X size={14} /></button></div>
                    <div className="net-grid">
                      <label className="net-field"><span>From</span><select value={f.src} onChange={(e) => setFlow(f.id, { src: e.target.value })}>{hosts.map((h) => <option key={h.id}>{h.id}</option>)}</select></label>
                      <label className="net-field"><span>To</span><select value={f.dst} onChange={(e) => setFlow(f.id, { dst: e.target.value })}>{hosts.map((h) => <option key={h.id}>{h.id}</option>)}</select></label>
                      <label className="net-field"><span>Traffic</span><select value={f.pattern.type} onChange={(e) => setPattern(f, e.target.value as FlowPattern["type"])}>
                        {Object.entries(patternLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                      {f.pattern.type !== "schedule" && <NumInput label={f.pattern.type === "onoff" ? "Rate when on (pkt/s)" : "Rate (pkt/s)"} value={f.rate} onChange={(v) => setFlow(f.id, { rate: v })} />}
                      {f.pattern.type === "onoff" && <>
                        <NumInput label="Mean on (s)" value={f.pattern.on_mean} onChange={(v) => setFlow(f.id, { pattern: { ...(f.pattern as Extract<FlowPattern, { type: "onoff" }>), on_mean: v } })} />
                        <NumInput label="Mean off (s)" value={f.pattern.off_mean} onChange={(v) => setFlow(f.id, { pattern: { ...(f.pattern as Extract<FlowPattern, { type: "onoff" }>), off_mean: v } })} />
                      </>}
                      {f.pattern.type === "schedule" && <>
                        <ScheduleInput key={`${f.id}-${f.pattern.points.length}`} points={f.pattern.points} onChange={(points) => setFlow(f.id, { rate: Math.max(...points.map((p) => p.rate)), pattern: { ...(f.pattern as Extract<FlowPattern, { type: "schedule" }>), points } })} />
                        <label className="net-field"><span>Between points</span><select value={f.pattern.interpolate} onChange={(e) => setFlow(f.id, { pattern: { ...(f.pattern as Extract<FlowPattern, { type: "schedule" }>), interpolate: e.target.value as "step" | "linear" } })}>
                          <option value="step">Step</option><option value="linear">Ramp</option></select></label>
                      </>}
                    </div>
                  </div>
                ))}
              </section>

              <section className="net-panel" aria-labelledby="fail-heading">
                <div className="net-panel-head"><h2 id="fail-heading">Failures</h2>
                  <button type="button" className="ghost-button" disabled={failTargets.length === 0} onClick={() => update((d) => d.events.push({ t: Math.round(d.duration / 3), target: failTargets[0], action: "down" }))}><Plus size={14} />Add</button></div>
                {sc.events.length === 0 && <p className="net-help">Take a link or router down at a given time, and bring it back later. Traffic is rerouted around it.</p>}
                {sc.events.map((e, i) => (
                  <div className="net-grid net-event" key={i}>
                    <NumInput label="At t (s)" value={e.t} onChange={(v) => update((d) => { d.events[i].t = v; })} />
                    <label className="net-field"><span>Element</span><select value={e.target} onChange={(ev) => update((d) => { d.events[i].target = ev.target.value; })}>{failTargets.map((t) => <option key={t}>{t}</option>)}</select></label>
                    <label className="net-field"><span>Goes</span><select value={e.action} onChange={(ev) => update((d) => { d.events[i].action = ev.target.value as "down" | "up"; })}><option value="down">down</option><option value="up">back up</option></select></label>
                    <button type="button" className="icon-button net-x" aria-label="Remove failure" onClick={() => update((d) => { d.events.splice(i, 1); })}><X size={14} /></button>
                  </div>
                ))}
              </section>

              <section className="net-panel" aria-labelledby="settings-heading">
                <h2 id="settings-heading">Run length</h2>
                <div className="net-grid"><NumInput label="Simulated duration (s)" value={sc.duration} onChange={(v) => update((d) => { d.duration = v; })} /></div>
              </section>
            </>
        </aside>
      </div>
      )}
    </section>
  );
}
