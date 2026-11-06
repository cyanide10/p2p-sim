import { ArrowLeft, CircleDot, Download, FilePlus2, Link2, LoaderCircle, MousePointer2, Play, Plus, Server, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ApiError, createApiClient } from "../api/client";
import type { MockScenario } from "../api/types";
import type { PartitionPlan } from "../api/types";
import { NetworkNumberInput as NumInput } from "../components/NetworkNumberInput";
import { NetworkPdesPanel } from "../components/NetworkPdesPanel";
import { NetworkScheduleInput as ScheduleInput } from "../components/NetworkScheduleInput";
import { NetworkPlayer } from "../components/NetworkPlayer";
import { Notice, PageHeading } from "../components/PagePrimitives";
import { TopologyCanvas, type Selection, type Tool } from "../components/TopologyCanvas";
import {
  checkScenario, cloneScenario, flowSlot, generateGridScenario, nextId, offeredPackets, parseScenario,
  SAMPLES, toWire, type Flow, type FlowPattern, type GridOptions, type Scenario,
} from "../lib/network";
import { loadSavedNetwork, saveNetworkScenario } from "../lib/networkStorage";

const patternLabel: Record<FlowPattern["type"], string> = { constant: "Steady", schedule: "Rate schedule", onoff: "Bursty on/off" };

export function NetworkPage({ scenario: mockScenario }: { scenario: MockScenario }) {
  const api = useMemo(() => createApiClient(mockScenario), [mockScenario]);
  const [sc, setSc] = useState<Scenario>(loadSavedNetwork);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<Selection>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [pool, setPool] = useState<Array<{ id: string; healthy: boolean }>>([]);
  const [liveNode, setLiveNode] = useState("");
  const [coordinator, setCoordinator] = useState("");
  const [copies, setCopies] = useState(30);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1_000_000));
  const [parts, setParts] = useState(1);
  const [baseline, setBaseline] = useState(true);
  const [partitionPlan, setPartitionPlan] = useState<PartitionPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [grid, setGrid] = useState<Omit<GridOptions, "seed">>({
    topology: "grid", rows: 4, columns: 4, hostsPerRouter: 1, flowCount: 16,
    flowRate: 8, bandwidth: 20, delay: 2, serviceRate: 100, buffer: 50, duration: 600,
  });
  const [view, setView] = useState<"edit" | "live">("edit");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const runInFlight = submitting || planning || partitionPlan !== null || view === "live";

  useEffect(() => {
    if (runInFlight) setAdvancedOpen(true);
  }, [runInFlight]);

  useEffect(() => {
    saveNetworkScenario(sc);
  }, [sc]);

  useEffect(() => {
    let active = true;
    Promise.all([api.getConfig(), api.getCluster()]).then(([config, cluster]) => {
      if (!active) return;
      const healthy = new Set(cluster.nodes.filter((n) => n.healthy).map((n) => n.id));
      const list = config.peers.map((p) => ({ id: p.id, healthy: healthy.has(p.id) }));
      setPool(list);
      setParts(Math.max(1, Math.min(healthy.size, sc.nodes.filter((node) => node.kind === "router").length || 1)));
      const first = list.find((n) => n.healthy)?.id ?? list[0]?.id ?? "";
      setLiveNode((v) => v || first);
      setCoordinator((v) => v || first);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api]);

  useEffect(() => { setPartitionPlan(null); }, [sc, parts, coordinator]);


  const errors = checkScenario(sc);
  const maxParts = Math.min(pool.filter((node) => node.healthy).length, sc.nodes.filter((node) => node.kind === "router").length);
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

  // Shortcuts only fire while the canvas itself has focus, so they never
  // steal Delete/Escape from form fields in the inspector or run bar.
  const onCanvasKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (view !== "edit") return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected) { e.preventDefault(); remove(selected); }
    if (e.key === "Escape") { setPendingLink(null); setSelected(null); }
  };

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
      setNotice({ kind: "error", text: busy ? `${coordinator} is already coordinating a run; pick another coordinator or wait.` : cause instanceof Error ? cause.message : "Could not start the run." });
    } finally {
      setSubmitting(false);
    }
  };

  const generate = () => {
    try {
      const generated = generateGridScenario({ ...grid, seed });
      setSc(generated);
      setParts(Math.max(1, Math.min(pool.filter((node) => node.healthy).length, generated.nodes.filter((node) => node.kind === "router").length)));
      setSelected(null);
      setNotice({ kind: "info", text: `Generated a ${grid.topology} with ${generated.nodes.length} nodes and ${generated.flows.length} seeded flows.` });
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : "Could not generate this topology." });
    }
  };

  const previewPartitions = async () => {
    if (errors.length || !coordinator || maxParts < 1 || parts > maxParts) return;
    setPlanning(true);
    setNotice(null);
    try {
      const plan = await api.planPDES(coordinator, toWire(sc), parts);
      setPartitionPlan(plan);
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : "Could not plan partitions." });
    } finally {
      setPlanning(false);
    }
  };

  const runPDES = async () => {
    if (!partitionPlan || errors.length || !coordinator) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const created = await api.createPDESRun(coordinator, toWire(sc), parts, seed, baseline);
      window.location.hash = `#/live/${encodeURIComponent(created.run_id)}`;
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : "Could not start the partitioned run." });
    } finally {
      setSubmitting(false);
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(toWire(sc), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "network.json";
    a.click();
    // Revoking synchronously can cancel the download before the browser starts it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      <PageHeading
        id="network-heading"
        eyebrow="NETWORK LAB"
        title="Network"
        lede="Draw a network, give it traffic that changes over time and failures, then watch it live or run many copies across your nodes."
      />

      {notice && <Notice kind={notice.kind} >{notice.kind === "error" ? <TriangleAlert size={15} /> : null}{notice.text}</Notice>}

      <div className="net-runbar">
        <div className="net-run-group">
          <strong>Run</strong>
          <label className="net-field"><span>Node</span>
            <select
              value={liveNode}
              onChange={(e) => { setLiveNode(e.target.value); setCoordinator(e.target.value); }}
              disabled={view === "live"}
            >
              {pool.map((n) => <option key={n.id} value={n.id} disabled={!n.healthy}>{n.id}{n.healthy ? "" : " · down"}</option>)}
            </select></label>
          <NumInput label="Copies" value={copies} onChange={(v) => setCopies(Math.round(v))} min={2} step="1" />
          <button type="button" className="primary-button net-btn" onClick={startLive} disabled={errors.length > 0 || !liveNode || view === "live"}><Play size={14} fill="currentColor" />Run</button>
          <button type="button" className="ghost-button net-btn" onClick={() => void runCluster()} disabled={errors.length > 0 || submitting || !coordinator}>
            {submitting ? <LoaderCircle size={14} className="button-spin" /> : <Play size={14} fill="currentColor" />}Run on all nodes
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
          <div
            className="net-canvas"
            ref={canvasRef}
            tabIndex={0}
            role="group"
            aria-label="Network editor canvas"
            onPointerDownCapture={() => canvasRef.current?.focus()}
            onKeyDown={onCanvasKeyDown}
          >
            <TopologyCanvas scenario={sc} mode="edit" tool={tool} selected={selected} pendingLink={pendingLink}
              partitionAssignment={partitionPlan?.assignment} cutLinks={partitionPlan?.cut_links}
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

      <NetworkPdesPanel
        grid={grid}
        onGrid={setGrid}
        parts={parts}
        onParts={setParts}
        seed={seed}
        onSeed={setSeed}
        advancedOpen={advancedOpen}
        onAdvancedOpen={setAdvancedOpen}
        baseline={baseline}
        onBaseline={setBaseline}
        healthyCount={pool.filter((node) => node.healthy).length}
        maxParts={maxParts}
        coordinator={coordinator}
        hasErrors={errors.length > 0}
        partitionPlan={partitionPlan}
        planning={planning}
        submitting={submitting}
        onGenerate={generate}
        onPreview={() => void previewPartitions()}
        onRun={() => void runPDES()}
      />
    </section>
  );
}
