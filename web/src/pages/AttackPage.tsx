import {
  Activity, Bug, CircleCheck, CloudLightning, Cpu, Crosshair, Database, Globe2,
  Layers, LoaderCircle, Pause, Play, RotateCcw, Server, Shield, ShieldAlert, TriangleAlert, X,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ApiError, createApiClient } from "../api/client";
import type { AttackReport, AttackStatus, MockScenario, PartitionPlan, RunCreated } from "../api/types";
import { AttackMap } from "../components/AttackMap";
import {
  ATTACK_ORDER, ATTACK_SCENARIOS, DEFAULT_DURATION, SAMPLE_STEP, attackRunFromMetrics, buildAttackRun,
  buildAttackScenario, compact, getScenario, normalizeConfig, percent, phaseFor, sampleAt,
  type AttackConfig, type AttackKind, type AttackNode, type AttackRun, type AttackSample,
  type NodeRole, type TargetState,
} from "../lib/attack";
import { startPolling } from "../lib/poll";

const SCENARIO_ICONS: Record<AttackKind, ReactNode> = {
  ddos: <CloudLightning size={18} />,
  synflood: <Crosshair size={18} />,
  worm: <Bug size={18} />,
  exfil: <Database size={18} />,
};

const severityLabel: Record<string, string> = {
  critical: "Critical",
  high: "High",
  stealth: "Stealth",
};

const targetCopy: Record<TargetState, string> = {
  secure: "All core services within SLO.",
  degraded: "Elevated queueing and latency.",
  critical: "SLO breached; requests failing.",
  offline: "Data core unreachable.",
};

const threatLabel = (threat: number) => {
  if (threat >= 88) return "Catastrophic";
  if (threat >= 68) return "Severe";
  if (threat >= 42) return "High";
  if (threat >= 20) return "Elevated";
  return "Guarded";
};

const roleLabel: Record<NodeRole, string> = {
  target: "Data core",
  service: "Core service",
  endpoint: "Workstation subnet",
  edge: "Edge / scrubbing",
  bot: "Bot cluster",
};

function nodeHealth(node: AttackNode, sample: AttackSample, kind: AttackKind): { label: string; tone: string } {
  const state = sample.nodes[node.id];
  if (!state) return { label: "No telemetry", tone: "muted" };
  if (state.compromise > 0.68) return { label: kind === "worm" || kind === "exfil" ? "Compromised" : "Hostile", tone: "bad" };
  if (state.load > 1.1) return { label: "Saturated", tone: "bad" };
  if (state.load > 0.84) return { label: "Critical", tone: "warn" };
  if (state.load > 0.62 || state.compromise > 0.2) return { label: "Degraded", tone: "warn" };
  return { label: "Nominal", tone: "good" };
}

function durationText(t: number): string {
  return `T+ ${t.toFixed(1)}s`;
}

function latencyText(ms: number): { value: string; unit: string } {
  if (!Number.isFinite(ms)) return { value: "--", unit: "" };
  if (ms >= 1_000) return { value: (ms / 1_000).toFixed(1), unit: "s" };
  return { value: Math.round(ms).toLocaleString(), unit: "ms" };
}

function AttackLoadChart({ run, clock, onSeek }: { run: AttackRun; clock: number; onSeek: (t: number) => void }) {
  const width = 560;
  const height = 190;
  const pad = { top: 18, right: 18, bottom: 28, left: 38 };
  const data = useMemo(() => {
    const max = Math.max(run.config.capacity, ...run.samples.map((sample) => sample.attackLoad + sample.legitLoad)) * 1.08;
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const x = (t: number) => pad.left + (t / run.config.duration) * innerW;
    const y = (value: number) => pad.top + innerH - (value / max) * innerH;
    const attack = run.samples.map((sample) => `${x(sample.t).toFixed(2)},${y(sample.attackLoad).toFixed(2)}`).join(" ");
    const legit = run.samples.map((sample) => `${x(sample.t).toFixed(2)},${y(sample.legitLoad).toFixed(2)}`).join(" ");
    const area = `M ${x(0)} ${y(0)} L ${attack.replaceAll(" ", " L ")} L ${x(run.config.duration)} ${y(0)} Z`;
    return { max, innerW, innerH, x, y, attack, legit, area };
  }, [run]);

  const current = sampleAt(run, clock);
  const seek = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const viewX = (ratio * width - pad.left) / data.innerW;
    onSeek(Math.max(0, Math.min(1, viewX)) * run.config.duration);
  };

  return (
    <svg className="attack-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Attack load versus target capacity over the campaign"
      onPointerDown={seek}>
      <defs>
        <linearGradient id="attack-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={run.scenario.accent} stopOpacity="0.38" />
          <stop offset="100%" stopColor={run.scenario.accent} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const value = data.max * fraction;
        return (
          <g key={fraction}>
            <line className="attack-chart-grid" x1={pad.left} x2={width - pad.right} y1={data.y(value)} y2={data.y(value)} />
            <text className="attack-chart-axis" x={pad.left - 7} y={data.y(value) + 3} textAnchor="end">{compact(value)}</text>
          </g>
        );
      })}
      <path d={data.area} fill="url(#attack-area)" />
      <polyline className="attack-chart-line" points={data.attack} stroke={run.scenario.accent} />
      <polyline className="attack-chart-line attack-chart-legit" points={data.legit} />
      <line className="attack-chart-capacity" x1={pad.left} x2={width - pad.right} y1={data.y(run.config.capacity)} y2={data.y(run.config.capacity)} />
      <text className="attack-chart-capacity-label" x={width - pad.right} y={data.y(run.config.capacity) - 6} textAnchor="end">capacity</text>
      {run.events.map((event) => (
        <line key={`ev-${event.t}-${event.text}`} className={`attack-chart-event event-${event.level}`} x1={data.x(event.t)} x2={data.x(event.t)} y1={pad.top} y2={height - pad.bottom} />
      ))}
      <line className="attack-chart-now" x1={data.x(clock)} x2={data.x(clock)} y1={pad.top} y2={height - pad.bottom} />
      <circle className="attack-chart-dot" cx={data.x(clock)} cy={data.y(current.attackLoad)} r="3.4" fill={run.scenario.accent} />
      <text className="attack-chart-axis" x={pad.left} y={height - 7}>0s</text>
      <text className="attack-chart-axis" x={data.x(run.config.duration / 2)} y={height - 7} textAnchor="middle">{Math.round(run.config.duration / 2)}s</text>
      <text className="attack-chart-axis" x={width - pad.right} y={height - 7} textAnchor="end">{run.config.duration}s</text>
      <text className="attack-chart-axis" x={pad.left} y={12}>{run.scenario.attackLabel} · {run.scenario.unit}</text>
    </svg>
  );
}

function AttackImpactChart({ run, clock, onSeek }: { run: AttackRun; clock: number; onSeek: (t: number) => void }) {
  const width = 560;
  const height = 190;
  const pad = { top: 18, right: 18, bottom: 28, left: 38 };
  const data = useMemo(() => {
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const x = (t: number) => pad.left + (t / run.config.duration) * innerW;
    const y = (value: number) => pad.top + innerH - (Math.max(0, Math.min(100, value)) / 100) * innerH;
    const impact = run.samples.map((sample) => `${x(sample.t).toFixed(2)},${y(sample.impactPct).toFixed(2)}`).join(" ");
    const availability = run.samples.map((sample) => `${x(sample.t).toFixed(2)},${y(sample.availability).toFixed(2)}`).join(" ");
    const area = `M ${x(0)} ${y(0)} L ${impact.replaceAll(" ", " L ")} L ${x(run.config.duration)} ${y(0)} Z`;
    return { innerW, innerH, x, y, impact, availability, area };
  }, [run]);

  const current = sampleAt(run, clock);
  const seek = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const viewX = (ratio * width - pad.left) / data.innerW;
    onSeek(Math.max(0, Math.min(1, viewX)) * run.config.duration);
  };

  return (
    <svg className="attack-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Impact and availability over the campaign"
      onPointerDown={seek}>
      <defs>
        <linearGradient id="impact-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff5a4e" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#ff5a4e" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {[0, 25, 50, 75, 100].map((value) => (
        <g key={value}>
          <line className="attack-chart-grid" x1={pad.left} x2={width - pad.right} y1={data.y(value)} y2={data.y(value)} />
          <text className="attack-chart-axis" x={pad.left - 7} y={data.y(value) + 3} textAnchor="end">{value}%</text>
        </g>
      ))}
      <path d={data.area} fill="url(#impact-area)" />
      <polyline className="attack-chart-line" points={data.impact} stroke="#ff5a4e" />
      <polyline className="attack-chart-line attack-chart-availability" points={data.availability} />
      <line className="attack-chart-now" x1={data.x(clock)} x2={data.x(clock)} y1={pad.top} y2={height - pad.bottom} />
      <circle className="attack-chart-dot" cx={data.x(clock)} cy={data.y(current.impactPct)} r="3.4" fill="#ff5a4e" />
      <circle className="attack-chart-dot" cx={data.x(clock)} cy={data.y(current.availability)} r="2.8" fill="#54d6a4" />
      <text className="attack-chart-axis" x={pad.left} y={height - 7}>0s</text>
      <text className="attack-chart-axis" x={data.x(run.config.duration / 2)} y={height - 7} textAnchor="middle">{Math.round(run.config.duration / 2)}s</text>
      <text className="attack-chart-axis" x={width - pad.right} y={height - 7} textAnchor="end">{run.config.duration}s</text>
      <text className="attack-chart-axis" x={pad.left} y={12}>{run.scenario.impactLabel} · availability</text>
      <g className="attack-chart-legend" transform={`translate(${width - pad.right - 130}, 12)`}>
        <rect x="0" y="-6" width="12" height="2" fill="#ff5a4e" />
        <text x="17" y="0">impact</text>
        <rect x="66" y="-6" width="12" height="2" fill="#54d6a4" />
        <text x="83" y="0">uptime</text>
      </g>
    </svg>
  );
}

function RangeControl({
  label, value, display, min, max, step, onChange,
}: {
  label: string; value: number; display: string; min: number; max: number; step: number; onChange: (value: number) => void;
}) {
  return (
    <label className="attack-range">
      <span className="attack-range-head"><span>{label}</span><strong>{display}</strong></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

type ExecutionMode = "local" | "worker" | "pdes";

const EXECUTION_MODES: Array<{ id: ExecutionMode; label: string; hint: string }> = [
  { id: "local", label: "Local model", hint: "Runs in this browser; available offline." },
  { id: "worker", label: "Node worker", hint: "One partition on a node; same result, computed remotely." },
  { id: "pdes", label: "PDES pool", hint: "Topology tokens split across healthy nodes in lock-step." },
];

interface RemoteCampaign {
  runId: string;
  config: AttackConfig;
  status: AttackStatus | null;
  report: AttackReport | null;
}

// AttackPage intentionally has no mockEnabled prop: the scenario select lives on the Cluster
// page only, and the campaign model is computed locally (local mode) or driven through the
// shared api client (worker/pdes modes), so mock/live status copy never depends on it.
export function AttackPage({ scenario: mockScenario }: { scenario: MockScenario }) {
  const api = useMemo(() => createApiClient(mockScenario), [mockScenario]);
  const [kind, setKind] = useState<AttackKind>("ddos");
  const scenario = getScenario(kind);
  const [seed, setSeed] = useState(2026);
  const [scale, setScale] = useState(scenario.defaultScale);
  const [intensity, setIntensity] = useState(scenario.defaultIntensity);
  const [capacity, setCapacity] = useState(scenario.defaultCapacity);
  const [defense, setDefense] = useState(60);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(4);
  const [clock, setClock] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<ExecutionMode>("local");
  const [pool, setPool] = useState<Array<{ id: string; healthy: boolean }>>([]);
  const [coordinator, setCoordinator] = useState("");
  const [parts, setParts] = useState(1);
  const [baseline, setBaseline] = useState(true);
  const [plan, setPlan] = useState<PartitionPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [remote, setRemote] = useState<RemoteCampaign | null>(null);
  const [remoteRun, setRemoteRun] = useState<AttackRun | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  const localRun = useMemo(
    () => buildAttackRun({ kind, seed, duration: DEFAULT_DURATION, scale, intensity, capacity, defense }),
    [kind, seed, scale, intensity, capacity, defense],
  );
  const run = remoteRun ?? localRun;
  const effectiveParts = mode === "worker" ? 1 : parts;
  const healthyCount = pool.filter((node) => node.healthy).length;
  const maxParts = Math.max(1, healthyCount);
  const executionLabel = mode === "local" ? "Local model" : mode === "worker" ? "Node worker" : `PDES · ${effectiveParts} parts`;
  const sample = sampleAt(run, clock);
  const phase = phaseFor(scenario, clock / run.config.duration);
  const phaseIndex = scenario.phases.findIndex((item) => item.id === phase.id);
  const selectedNode = selectedId ? run.topology.nodes.find((node) => node.id === selectedId) ?? null : null;
  const selectedHealth = selectedNode ? nodeHealth(selectedNode, sample, kind) : null;
  const visibleEvents = run.events.filter((event) => event.t <= clock + 0.001).slice(-7).reverse();
  const threat = Math.round(sample.threat);
  const latency = latencyText(sample.latencyMs);
  const impactValue = scenario.impactUnit === "%" ? sample.impact.toFixed(sample.impact < 10 ? 1 : 0) : sample.impact.toFixed(1);
  // A flood's "compromised" count is the attacking botnet, not the estate.
  const isFlood = kind === "ddos" || kind === "synflood";
  const exposureValue = isFlood ? sample.botsActive : sample.compromised;
  const exposurePct = Math.min(100, (exposureValue / run.config.scale) * 100);

  const remoteRunId = remote?.runId ?? null;
  const remoteState = remote?.status?.state ?? null;
  const remoteReport = remote?.report ?? null;
  const remoteConfig = remote?.config ?? null;

  useEffect(() => {
    let active = true;
    Promise.all([api.getConfig(), api.getCluster()]).then(([config, cluster]) => {
      if (!active) return;
      const healthy = new Set(cluster.nodes.filter((node) => node.healthy).map((node) => node.id));
      const list = config.peers.map((peer) => ({ id: peer.id, healthy: healthy.has(peer.id) }));
      setPool(list);
      setCoordinator((current) => current || list.find((node) => node.healthy)?.id || list[0]?.id || "");
      setParts((current) => Math.max(1, Math.min(current, Math.max(1, healthy.size))));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    setParts((current) => Math.max(1, Math.min(current, maxParts)));
  }, [maxParts]);

  useEffect(() => {
    setPlan(null);
  }, [kind, seed, scale, intensity, capacity, defense, parts, coordinator, mode]);

  // Tuning the campaign makes an old pool result stale: fall back to recomputing
  // the local model until the next pool submission finishes.
  useEffect(() => {
    setRemote(null);
    setRemoteRun(null);
  }, [kind, seed, scale, intensity, capacity, defense]);

  useEffect(() => {
    if (!remoteRunId || remoteReport || remoteState === "failed") return;
    let active = true;
    const poll = async () => {
      try {
        const status = (await api.getStatus(remoteRunId)) as AttackStatus;
        if (!active) return;
        setRemote((current) => current && current.runId === remoteRunId ? { ...current, status } : current);
        if (status.state === "failed") {
          setNotice({ kind: "error", text: `Pool campaign failed: ${status.error ?? "unknown error"}. Showing the local model.` });
          return;
        }
        if (status.state === "complete") {
          const report = (await api.getReport(remoteRunId)) as AttackReport;
          if (!active) return;
          setRemote((current) => current && current.runId === remoteRunId ? { ...current, report } : current);
        }
      } catch (cause) {
        if (!active) return;
        setNotice({ kind: "error", text: `Lost the pool campaign: ${cause instanceof Error ? cause.message : "unknown error"}. Showing the local model.` });
      }
    };
    const stop = startPolling(poll, 1200);
    return () => { active = false; stop(); };
  }, [api, remoteRunId, remoteReport, remoteState]);

  useEffect(() => {
    if (!remoteReport?.metrics || !remoteConfig) return;
    setRemoteRun(attackRunFromMetrics(remoteConfig, remoteReport.metrics));
    setClock(0);
    setPlaying(true);
  }, [remoteReport, remoteConfig]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setClock((current) => Math.min(run.config.duration, current + 0.05 * speed));
    }, 50);
    return () => window.clearInterval(timer);
  }, [playing, speed, run.config.duration]);

  useEffect(() => {
    if (playing && clock >= run.config.duration) setPlaying(false);
  }, [clock, playing, run.config.duration]);

  const chooseKind = (next: AttackKind) => {
    const definition = ATTACK_SCENARIOS[next];
    setKind(next);
    setScale(definition.defaultScale);
    setIntensity(definition.defaultIntensity);
    setCapacity(definition.defaultCapacity);
    setDefense(60);
    setClock(0);
    setPlaying(true);
    setSelectedId(null);
  };

  const chooseMode = (next: ExecutionMode) => {
    setMode(next);
    setRemote(null);
    setRemoteRun(null);
    setPlan(null);
    setNotice(null);
  };

  const currentConfig = () => normalizeConfig({ kind, seed, duration: DEFAULT_DURATION, scale, intensity, capacity, defense });

  const previewPlan = async () => {
    if (!coordinator) return;
    setPlanning(true);
    setNotice(null);
    try {
      setPlan(await api.planAttack(coordinator, buildAttackScenario(currentConfig()), effectiveParts));
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : "Could not plan the attack partitions." });
    } finally {
      setPlanning(false);
    }
  };

  const runOnPool = async () => {
    if (!coordinator) {
      setNotice({ kind: "error", text: "Pick a healthy coordinator before starting a pool campaign." });
      return;
    }
    const config = currentConfig();
    setSubmitting(true);
    setNotice(null);
    try {
      const created: RunCreated = await api.createAttackRun(
        coordinator, buildAttackScenario(config), effectiveParts, config.seed, mode === "pdes" ? baseline : false,
      );
      setRemote({ runId: created.run_id, config, status: null, report: null });
      setRemoteRun(null);
      setNotice({
        kind: "info",
        text: `Started ${effectiveParts === 1 ? "a single-worker campaign" : `a ${effectiveParts}-partition PDES campaign`} on ${coordinator}. The local model keeps playing until it completes.`,
      });
    } catch (cause) {
      const message = cause instanceof ApiError || cause instanceof Error ? cause.message : "Could not start the campaign.";
      setNotice({ kind: "error", text: `${message} Continuing with the local model.` });
      setMode("local");
      setRemote(null);
    } finally {
      setSubmitting(false);
    }
  };

  const seek = (time: number) => {
    setClock(Math.max(0, Math.min(run.config.duration, time)));
    setPlaying(false);
  };

  const togglePlay = () => {
    if (clock >= run.config.duration) {
      setClock(0);
      setPlaying(true);
      return;
    }
    setPlaying((value) => !value);
  };

  const restart = () => {
    setClock(0);
    setPlaying(true);
  };

  const resetTuning = () => {
    setScale(scenario.defaultScale);
    setIntensity(scenario.defaultIntensity);
    setCapacity(scenario.defaultCapacity);
    setDefense(60);
    setClock(0);
    setPlaying(true);
  };

  const capacityStep = kind === "worm" ? 5 : kind === "ddos" ? 1 : 0.1;
  const scaleStep = 500;
  const targetTone = sample.targetState === "secure" ? "good" : sample.targetState === "degraded" ? "warn" : "bad";

  return (
    <section className="page-content attack-content" aria-labelledby="attack-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">THREAT OPERATIONS</p>
          <h1 id="attack-heading">Attack</h1>
          <p className="lede">Run a large-scale campaign against a live model of your estate, then trace the damage from first foothold to recovery.</p>
        </div>
        <div className="attack-head-tags">
          <span className="attack-head-tag"><Cpu size={13} />{executionLabel}</span>
          <span className="attack-head-tag">Seed {seed}</span>
        </div>
      </div>

      <div className="attack-scenarios" role="radiogroup" aria-label="Attack scenario">
        {ATTACK_ORDER.map((id) => {
          const definition = ATTACK_SCENARIOS[id];
          return (
            <button key={id} type="button" role="radio" aria-checked={kind === id}
              className={`attack-scenario ${kind === id ? "is-active" : ""}`}
              style={{ "--attack-accent": definition.accent } as CSSProperties}
              onClick={() => chooseKind(id)}>
              <span className="attack-scenario-icon">{SCENARIO_ICONS[id]}</span>
              <span className="attack-scenario-copy">
                <small>{definition.codename}</small>
                <strong>{definition.label}</strong>
                <em>{definition.tagline}</em>
              </span>
              <span className={`attack-severity severity-${definition.severity}`}>{severityLabel[definition.severity]}</span>
            </button>
          );
        })}
      </div>

      <p className="attack-brief">{scenario.description}</p>

      <div className="attack-tune">
        <RangeControl label={scenario.scaleLabel} value={scale} display={compact(scale, 1)} min={500} max={200_000} step={scaleStep} onChange={setScale} />
        <RangeControl label="Attack intensity" value={intensity} display={`${intensity.toFixed(0)} / 10`} min={1} max={10} step={1} onChange={setIntensity} />
        <RangeControl label={scenario.capacityLabel} value={capacity} display={`${compact(capacity, 1)} ${scenario.unit}`}
          min={capacityStep} max={scenario.defaultCapacity * 4} step={capacityStep} onChange={setCapacity} />
        <RangeControl label="Defensive posture" value={defense} display={`${defense}%`} min={0} max={100} step={5} onChange={setDefense} />
        <label className="attack-seed">
          <span>Campaign seed</span>
          <div>
            <input type="number" min={0} step={1} value={seed} onChange={(event) => setSeed(Math.max(0, Math.round(Number(event.target.value) || 0)))} />
            <button type="button" className="icon-button" title="New random seed" aria-label="New random seed" onClick={() => setSeed(Math.floor(Math.random() * 1_000_000))}>
              <RotateCcw size={15} />
            </button>
          </div>
        </label>
        <button type="button" className="ghost-button attack-reset" onClick={resetTuning}>Reset tuning</button>
      </div>

      <section className="attack-exec" aria-labelledby="attack-exec-heading">
        <div className="attack-exec-head">
          <div>
            <p className="eyebrow">EXECUTION</p>
            <h2 id="attack-exec-heading">Where the campaign runs</h2>
          </div>
          <p>Keep the deterministic browser model, offload the same campaign to one node worker, or split the topology across the PDES pool.</p>
        </div>

        <div className="attack-exec-modes" role="radiogroup" aria-label="Execution mode">
          {EXECUTION_MODES.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={mode === item.id}
              className={`attack-exec-mode ${mode === item.id ? "is-active" : ""}`}
              onClick={() => chooseMode(item.id)}>
              {item.id === "local" ? <Activity size={16} /> : item.id === "worker" ? <Server size={16} /> : <Layers size={16} />}
              <span><strong>{item.label}</strong><small>{item.hint}</small></span>
            </button>
          ))}
        </div>

        {mode !== "local" && (
          <div className="attack-exec-pool">
            <label className="attack-exec-field"><span>Coordinator</span>
              <select value={coordinator} onChange={(event) => setCoordinator(event.target.value)}>
                {pool.length === 0 && <option value="">No nodes discovered</option>}
                {pool.map((node) => <option key={node.id} value={node.id} disabled={!node.healthy}>{node.id}{node.healthy ? "" : " · down"}</option>)}
              </select>
            </label>
            {mode === "pdes" && (
              <label className="attack-exec-field"><span>Partitions</span>
                <select value={Math.min(parts, maxParts)} onChange={(event) => setParts(Number(event.target.value))}>
                  {Array.from({ length: maxParts }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            )}
            {mode === "worker" && <span className="attack-exec-note">1 partition · {healthyCount} healthy {healthyCount === 1 ? "node" : "nodes"}</span>}
            {mode === "pdes" && (
              <label className="attack-exec-check">
                <input type="checkbox" checked={baseline} onChange={(event) => setBaseline(event.target.checked)} />
                <span>Serial baseline</span>
              </label>
            )}
            {mode === "pdes" && (
              <button type="button" className="ghost-button" onClick={() => void previewPlan()} disabled={planning || !coordinator || maxParts < 1}>
                {planning ? <LoaderCircle size={14} className="button-spin" /> : <Layers size={14} />}Preview placement
              </button>
            )}
            <button type="button" className="primary-button" onClick={() => void runOnPool()} disabled={submitting || !coordinator}>
              {submitting ? <LoaderCircle size={14} className="button-spin" /> : <Play size={14} fill="currentColor" />}
              {mode === "worker" ? "Run on worker" : `Run on ${effectiveParts} partitions`}
            </button>
          </div>
        )}

        {plan && (
          <div className="attack-exec-plan" role="status">
            <span><strong>{plan.parts}</strong> parts</span>
            <span><strong>{plan.windows}</strong> lock-step windows</span>
            <span><strong>{plan.lookahead.toFixed(1)}s</strong> lookahead</span>
            <span>tokens / part: {plan.load.join(" · ")}</span>
          </div>
        )}

        {remote && (
          <div className={`attack-exec-status ${remoteReport ? "is-done" : ""}`} role="status">
            <div className="attack-exec-status-head">
              <span className={`attack-status tone-${remoteState === "failed" ? "bad" : remoteReport ? "good" : "warn"}`}>
                {remoteState === "failed" ? "failed" : remoteReport ? "complete" : remoteState ?? "queued"}
              </span>
              <code>{remote.runId}</code>
              <span>{effectiveParts === 1 ? "1 worker" : `${effectiveParts} partitions`}</span>
            </div>
            {(() => {
              const total = remoteReport?.plan.windows ?? remote.status?.windows_total ?? 0;
              const done = remoteReport ? total : remote.status?.windows_done ?? 0;
              return (
                <div className="attack-exec-progress">
                  <i><b style={{ width: `${total ? Math.min(100, (done / total) * 100) : 4}%` }} /></i>
                  <span>{done} / {total || "?"} windows · T+ {(remoteReport ? remoteReport.partitioned_wall_seconds : remote.status?.simulated_time ?? 0).toFixed(1)}s</span>
                </div>
              );
            })()}
            <div className="attack-exec-workers">
              {Object.entries(remoteReport?.partitions ?? remote.status?.partitions ?? {}).map(([node, timing]) => (
                <div key={node}>
                  <strong>{node}</strong>
                  <span>{timing.messages} msgs · {timing.compute_s.toFixed(2)}s compute · {timing.wait_s.toFixed(2)}s wait</span>
                </div>
              ))}
            </div>
            {remoteReport && (
              <p className="attack-exec-result">
                Merged {remoteReport.metrics?.samples.length ?? 0} campaign samples
                {remoteReport.results_identical !== undefined && ` · baseline ${remoteReport.results_identical ? "identical" : "differs"}`}
                {remoteReport.speedup !== undefined && ` · ${remoteReport.speedup.toFixed(2)}× vs serial`}
                {remoteReport.failed_node && ` · failed on ${remoteReport.failed_node}`}
              </p>
            )}
          </div>
        )}
      </section>

      {notice && (
        <div className={`notice ${notice.kind === "error" ? "notice-error" : "notice-info"}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.kind === "error" && <TriangleAlert size={15} />}{notice.text}
        </div>
      )}

      <div className="attack-console" style={{ "--attack-accent": scenario.accent } as CSSProperties}>
        <div className="attack-hud">
          <div className="attack-hud-live"><span className={playing ? "is-live" : ""} />{playing ? "SIMULATION RUNNING" : clock >= run.config.duration ? "CAMPAIGN COMPLETE" : "SIMULATION PAUSED"}<em className="attack-hud-source">{remoteRun ? executionLabel : "LOCAL MODEL"}</em></div>
          <div className="attack-hud-title"><span>{scenario.codename}</span><strong>{scenario.label}</strong></div>
          <div className="attack-hud-phase"><span>PHASE {phaseIndex + 1} / {scenario.phases.length}</span><strong>{phase.label}</strong></div>
          <div className="attack-hud-threat">
            <span>THREAT INDEX</span>
            <div className="attack-threat-meter"><i style={{ width: `${threat}%` }} /></div>
            <strong className={`tone-${threat >= 68 ? "bad" : threat >= 42 ? "warn" : "good"}`}>{threat} · {threatLabel(threat)}</strong>
          </div>
          <div className="attack-hud-clock">{durationText(clock)}</div>
        </div>

        <div className="attack-console-body">
          <div className="attack-stage">
            <div className="attack-map-wrap">
              <AttackMap run={run} sample={sample} clock={clock} selectedId={selectedId} onSelect={setSelectedId} />
              {selectedNode && selectedHealth && (
                <aside className="attack-inspector" aria-label={`Inspector for ${selectedNode.label}`}>
                  <button type="button" className="attack-inspector-close" aria-label="Close inspector" onClick={() => setSelectedId(null)}><X size={13} /></button>
                  <p className="attack-inspector-role">{roleLabel[selectedNode.role]} · {selectedNode.region}</p>
                  <div className="attack-inspector-head">
                    {selectedNode.role === "target" ? <ShieldAlert size={18} /> : selectedNode.role === "edge" ? <Shield size={18} /> : selectedNode.role === "bot" ? <Globe2 size={18} /> : <Server size={18} />}
                    <strong>{selectedNode.label}</strong>
                    <span className={`attack-status tone-${selectedHealth.tone}`}>{selectedHealth.label}</span>
                  </div>
                  <dl>
                    <div><dt>Represented units</dt><dd>{selectedNode.units.toLocaleString()}</dd></div>
                    <div><dt>Load</dt><dd>{Math.round((sample.nodes[selectedNode.id]?.load ?? 0) * 100)}%</dd></div>
                    <div><dt>Compromise</dt><dd>{Math.round((sample.nodes[selectedNode.id]?.compromise ?? 0) * 100)}%</dd></div>
                  </dl>
                </aside>
              )}
            </div>

            <div className="attack-phase-strip" aria-label="Campaign phases">
              {scenario.phases.map((item, index) => (
                <button key={item.id} type="button"
                  className={`attack-phase ${index === phaseIndex ? "is-active" : ""} ${index < phaseIndex ? "is-done" : ""}`}
                  onClick={() => seek(item.at * run.config.duration)}>
                  <span className="attack-phase-line" />
                  <span className="attack-phase-copy"><strong>{item.label}</strong><small>{Math.round(item.at * run.config.duration)}s</small></span>
                </button>
              ))}
            </div>

            <div className="attack-playback">
              <button type="button" className="attack-play" onClick={togglePlay} aria-label={playing ? "Pause campaign" : "Play campaign"}>
                {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
              </button>
              <button type="button" className="attack-restart" onClick={restart} aria-label="Restart campaign"><RotateCcw size={15} /></button>
              <input className="attack-scrub" type="range" min={0} max={run.config.duration} step={SAMPLE_STEP} value={clock}
                aria-label="Campaign time" onChange={(event) => seek(Number(event.target.value))} />
              <strong className="attack-playback-time">{clock.toFixed(1)} / {run.config.duration}s</strong>
              <label className="attack-speed"><span>Speed</span>
                <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                  {[1, 2, 4, 8].map((value) => <option key={value} value={value}>{value}×</option>)}
                </select>
              </label>
            </div>
          </div>

          <aside className="attack-rail">
            <section className="attack-posture">
              <div className="attack-rail-title"><span>TARGET POSTURE</span><span className={`attack-status tone-${targetTone}`}>{sample.targetState}</span></div>
              <div className="attack-target">
                <div className={`attack-target-mark tone-${targetTone}`}>{sample.targetState === "secure" ? <CircleCheck size={22} /> : <TriangleAlert size={22} />}</div>
                <div><strong>DC-CORE</strong><span>{targetCopy[sample.targetState]}</span></div>
              </div>
              <div className="attack-threat-big">
                <div className={`attack-threat-value tone-${threat >= 68 ? "bad" : threat >= 42 ? "warn" : "good"}`}>{threat}<small>/100</small></div>
                <div><span>Threat index</span><strong>{threatLabel(threat)}</strong><small>Combined load, impact and availability</small></div>
              </div>
              <div className="attack-bars">
                <div><span>Offered load <strong>{sample.loadRatio.toFixed(2)}×</strong></span><i><b className={sample.loadRatio > 1 ? "is-bad" : sample.loadRatio > 0.8 ? "is-warn" : ""} style={{ width: `${Math.min(100, sample.loadRatio * 100)}%` }} /></i></div>
                <div><span>Availability <strong>{percent(sample.availability, 1)}</strong></span><i><b className="is-good" style={{ width: `${sample.availability}%` }} /></i></div>
                <div><span>Containment <strong>{percent(sample.blocked)}</strong></span><i><b className="is-info" style={{ width: `${sample.blocked}%` }} /></i></div>
                <div>
                  <span>{isFlood ? "Botnet engaged" : "Estate compromised"} <strong>{percent(exposurePct, 1)}</strong></span>
                  <i><b className={isFlood ? "is-warn" : "is-bad"} style={{ width: `${exposurePct}%` }} /></i>
                </div>
              </div>
            </section>

            <div className="attack-metrics">
              <div><span>{scenario.attackLabel}</span><strong>{compact(sample.attackLoad)}<small>{scenario.unit}</small></strong><em>{sample.loadRatio.toFixed(2)}× capacity</em></div>
              <div><span>{scenario.impactLabel}</span><strong>{impactValue}<small>{scenario.impactUnit}</small></strong><em>current impact</em></div>
              <div><span>Availability</span><strong>{sample.availability.toFixed(1)}<small>%</small></strong><em>{sample.targetState === "secure" ? "within SLO" : "below SLO"}</em></div>
              <div><span>Latency</span><strong>{latency.value}<small>{latency.unit}</small></strong><em>p95 service response</em></div>
              <div><span>{isFlood ? "Botnet engaged" : "Compromised"}</span><strong>{compact(exposureValue)}<small>{isFlood ? "bots" : "hosts"}</small></strong><em>{isFlood ? `${percent(exposurePct, 0)} of botnet` : `${percent(exposurePct, 1)} of estate`}</em></div>
              <div><span>Attack blocked</span><strong>{sample.blocked.toFixed(0)}<small>%</small></strong><em>{defense === 0 ? "no defence enabled" : "active controls"}</em></div>
            </div>

            <section className="attack-log">
              <div className="attack-rail-title"><span>CAMPAIGN LOG</span><span>{run.events.filter((event) => event.t <= clock + 0.001).length} events</span></div>
              {visibleEvents.length === 0 ? (
                <p className="attack-empty">Campaign armed. Press play to begin.</p>
              ) : (
                <ol className="attack-event-list">
                  {visibleEvents.map((event, index) => (
                    <li key={`${event.t}-${event.text}`}>
                      <button type="button" className={`attack-event level-${event.level}`} onClick={() => seek(event.t)}>
                        <span>{event.t.toFixed(1)}s</span>
                        <strong>{event.text}</strong>
                        {index === 0 && <i />}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </aside>
        </div>

        <div className="attack-charts">
          <section className="attack-chart-panel">
            <div className="attack-chart-head">
              <div><h2>Offered load vs capacity</h2><p>Attack traffic and legitimate baseline against the target's design limit.</p></div>
              <div className="attack-chart-legend-row">
                <span><i style={{ background: scenario.accent }} />attack</span>
                <span><i className="is-legit" />legitimate</span>
                <span><i className="is-capacity" />capacity</span>
              </div>
            </div>
            <AttackLoadChart run={run} clock={clock} onSeek={seek} />
          </section>
          <section className="attack-chart-panel">
            <div className="attack-chart-head">
              <div><h2>{scenario.impactLabel} & availability</h2><p>How far the estate falls below its service level, and how quickly it recovers.</p></div>
              <div className="attack-chart-legend-row">
                <span><i className="is-impact" />impact</span>
                <span><i className="is-uptime" />uptime</span>
              </div>
            </div>
            <AttackImpactChart run={run} clock={clock} onSeek={seek} />
          </section>
        </div>

        <div className="attack-console-foot">
          <div className="attack-foot-stat"><span>Peak load</span><strong>{run.summary.peakLoadRatio.toFixed(2)}×</strong></div>
          <div className="attack-foot-stat"><span>Peak impact</span><strong>{run.config.kind === "exfil" ? `${run.summary.peakImpact.toFixed(1)} GB` : `${run.summary.peakImpact.toFixed(0)}${scenario.impactUnit}`}</strong></div>
          <div className="attack-foot-stat"><span>Time over capacity</span><strong>{run.summary.timeAboveCapacity.toFixed(1)}s</strong></div>
          <div className="attack-foot-stat"><span>{isFlood ? "Peak botnet" : "Peak compromised"}</span><strong>{compact(run.summary.peakCompromised)}</strong></div>
          <div className="attack-foot-stat"><span>Peak blocking</span><strong>{run.summary.blockedPct.toFixed(0)}%</strong></div>
          <div className="attack-foot-stat"><span>Recovery from peak</span><strong>{run.summary.recoverySeconds === null ? "not reached" : `${run.summary.recoverySeconds.toFixed(1)}s`}</strong></div>
        </div>
      </div>

      <p className="attack-footnote">
        <Activity size={14} />
        The threat lab is a deterministic campaign model: every seed produces the same incident, so you can scrub, pause and replay it. The node worker and PDES modes run that same model on the pool; if a pool run is unavailable, the local model keeps working offline.
      </p>
    </section>
  );
}
