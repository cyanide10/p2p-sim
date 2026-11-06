import {
  CircleCheck, Globe2, Pause, Play, RotateCcw, Server, Shield, ShieldAlert, TriangleAlert, X,
} from "lucide-react";
import { AttackMap } from "../AttackMap";
import { PanelTitle, StatStrip } from "../PagePrimitives";
import { StateBadge, type BadgeTone } from "../RunBits";
import { compact, percent, phaseFor, sampleAt, type AttackKind, type AttackNode, type AttackRun, type TargetState } from "../../lib/attack";

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

const roleLabel: Record<AttackNode["role"], string> = {
  target: "Data core",
  service: "Core service",
  endpoint: "Workstation subnet",
  edge: "Edge / scrubbing",
  bot: "Bot cluster",
};

function nodeHealth(node: AttackNode, sample: ReturnType<typeof sampleAt>, kind: AttackKind): { label: string; tone: BadgeTone } {
  const state = sample.nodes[node.id];
  if (!state) return { label: "No telemetry", tone: "neutral" };
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

interface Props {
  run: AttackRun;
  clock: number;
  playing: boolean;
  speed: number;
  selectedId: string | null;
  executionLabel: string;
  remoteRun: boolean;
  onSelect: (id: string | null) => void;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onRestart: () => void;
  onSpeed: (value: number) => void;
}

/** HUD, map, playback controls and the live posture/summary rail. */
export function AttackRuntime({
  run, clock, playing, speed, selectedId, executionLabel, remoteRun,
  onSelect, onSeek, onTogglePlay, onRestart, onSpeed,
}: Props) {
  const scenario = run.scenario;
  const sample = sampleAt(run, clock);
  const phase = phaseFor(scenario, clock / run.config.duration);
  const phaseIndex = scenario.phases.findIndex((item) => item.id === phase.id);
  const selectedNode = selectedId ? run.topology.nodes.find((node) => node.id === selectedId) ?? null : null;
  const selectedHealth = selectedNode ? nodeHealth(selectedNode, sample, scenario.id) : null;
  const visibleEvents = run.events.filter((event) => event.t <= clock + 0.001).slice(-7).reverse();
  const threat = Math.round(sample.threat);
  const latency = latencyText(sample.latencyMs);
  const impactValue = scenario.impactUnit === "%" ? sample.impact.toFixed(sample.impact < 10 ? 1 : 0) : sample.impact.toFixed(1);
  // A flood's "compromised" count is the attacking botnet, not the estate.
  const isFlood = scenario.id === "ddos" || scenario.id === "synflood";
  const exposureValue = isFlood ? sample.botsActive : sample.compromised;
  const exposurePct = Math.min(100, (exposureValue / run.config.scale) * 100);
  const targetTone: BadgeTone = sample.targetState === "secure" ? "good" : sample.targetState === "degraded" ? "warn" : "bad";

  return (
    <>
      <div className="attack-hud">
        <div className="attack-hud-live"><span className={playing ? "is-live" : ""} />{playing ? "SIMULATION RUNNING" : clock >= run.config.duration ? "CAMPAIGN COMPLETE" : "SIMULATION PAUSED"}<em className="attack-hud-source">{remoteRun ? executionLabel : "LOCAL MODEL"}</em></div>
        <div className="attack-hud-title"><span>{scenario.codename}</span><strong>{scenario.label}</strong></div>
        <div className="attack-hud-phase"><span>PHASE {phaseIndex + 1} / {scenario.phases.length}</span><strong>{phase.label}</strong></div>
        <div className="attack-hud-clock">{durationText(clock)}</div>
      </div>

      <div className="attack-console-body">
        <div className="attack-stage">
          <div className="attack-map-wrap">
            <AttackMap run={run} sample={sample} clock={clock} selectedId={selectedId} onSelect={onSelect} />
            {selectedNode && selectedHealth && (
              <aside className="attack-inspector" aria-label={`Inspector for ${selectedNode.label}`}>
                <button type="button" className="attack-inspector-close" aria-label="Close inspector" onClick={() => onSelect(null)}><X size={13} /></button>
                <p className="attack-inspector-role">{roleLabel[selectedNode.role]} · {selectedNode.region}</p>
                <div className="attack-inspector-head">
                  {selectedNode.role === "target" ? <ShieldAlert size={18} /> : selectedNode.role === "edge" ? <Shield size={18} /> : selectedNode.role === "bot" ? <Globe2 size={18} /> : <Server size={18} />}
                  <strong>{selectedNode.label}</strong>
                  <StateBadge className="attack-status" tone={selectedHealth.tone} label={selectedHealth.label} />
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
                onClick={() => onSeek(item.at * run.config.duration)}>
                <span className="attack-phase-line" />
                <span className="attack-phase-copy"><strong>{item.label}</strong><small>{Math.round(item.at * run.config.duration)}s</small></span>
              </button>
            ))}
          </div>

          <div className="attack-playback">
            <button type="button" className="attack-play" onClick={onTogglePlay} aria-label={playing ? "Pause campaign" : "Play campaign"}>
              {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            </button>
            <button type="button" className="attack-restart" onClick={onRestart} aria-label="Restart campaign"><RotateCcw size={15} /></button>
            <input className="attack-scrub" type="range" min={0} max={run.config.duration} step={0.5} value={clock}
              aria-label="Campaign time" onChange={(event) => onSeek(Number(event.target.value))} />
            <strong className="attack-playback-time">{clock.toFixed(1)} / {run.config.duration}s</strong>
            <label className="attack-speed"><span>Speed</span>
              <select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>
                {[1, 2, 4, 8].map((value) => <option key={value} value={value}>{value}×</option>)}
              </select>
            </label>
          </div>
        </div>

        <aside className="attack-rail">
          <section className="attack-posture">
            <PanelTitle title="Target posture" action={<StateBadge className="attack-status" tone={targetTone} label={sample.targetState} />} tone="soc" />
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

          <StatStrip variant="soc" items={[
            { label: scenario.impactLabel, value: impactValue, small: scenario.impactUnit, note: <em>current impact</em> },
            { label: "Latency", value: latency.value, small: latency.unit, note: <em>p95 service response</em> },
          ]} />

          <section className="attack-log">
            <PanelTitle title="Campaign log" note={`${run.events.filter((event) => event.t <= clock + 0.001).length} events`} tone="soc" />
            {visibleEvents.length === 0 ? (
              <p className="attack-empty">Campaign armed. Press play to begin.</p>
            ) : (
              <ol className="attack-event-list">
                {visibleEvents.map((event, index) => (
                  <li key={`${event.t}-${event.text}`}>
                    <button type="button" className={`attack-event level-${event.level}`} onClick={() => onSeek(event.t)}>
                      <span>{event.t.toFixed(1)}s</span>
                      <strong>{event.text}</strong>
                      {index === 0 && <i />}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="attack-rail-summary">
            <PanelTitle title="Campaign summary" note={`${run.samples.length} samples`} tone="soc" />
            <StatStrip variant="soc" items={[
              { label: "Peak load", value: `${run.summary.peakLoadRatio.toFixed(2)}×` },
              { label: "Peak impact", value: run.config.kind === "exfil" ? `${run.summary.peakImpact.toFixed(1)} GB` : `${run.summary.peakImpact.toFixed(0)}${scenario.impactUnit}` },
              { label: "Time over capacity", value: `${run.summary.timeAboveCapacity.toFixed(1)}s` },
              { label: isFlood ? "Peak botnet" : "Peak compromised", value: compact(run.summary.peakCompromised) },
              { label: "Peak blocking", value: `${run.summary.blockedPct.toFixed(0)}%` },
              { label: "Recovery from peak", value: run.summary.recoverySeconds === null ? "not reached" : `${run.summary.recoverySeconds.toFixed(1)}s` },
            ]} />
          </section>
        </aside>
      </div>
    </>
  );
}
