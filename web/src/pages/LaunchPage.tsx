import { ArrowRight, Dices, LoaderCircle, Play, RotateCcw, Server, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient } from "../api/client";
import type { GatewayConfig, MockScenario, Peer, RunCreated, RunParameters, RunRecord } from "../api/types";
import { randomSeed, validateRun, type RunField } from "../lib/validation";

type NumericField = Exclude<keyof RunParameters, "serial_baseline" | "kind" | "scenario">;
type Draft = Record<NumericField, string> & { serial_baseline: boolean };

const fieldConfig: Array<{
  name: NumericField;
  label: string;
  description: string;
  min?: number;
  max?: number;
  step: string;
}> = [
  { name: "replications", label: "Replications", description: "Independent seeded trials", min: 2, max: 100000, step: "1" },
  { name: "lambda", label: "Arrival rate (λ)", description: "Arrivals per simulation time unit", min: 0, step: "any" },
  { name: "mu", label: "Service rate (μ)", description: "Services per simulation time unit", min: 0, step: "any" },
  { name: "sim_time", label: "Simulation time", description: "Total simulated time per trial", min: 0, step: "any" },
  { name: "warmup_time", label: "Warmup time", description: "Discarded before measurement", min: 0, step: "any" },
  { name: "tolerance_pct", label: "Theory tolerance (%)", description: "Maximum relative error for PASS", min: 0, step: "any" },
  { name: "base_seed", label: "Base seed", description: "Reproduce this run with the same seed", min: 0, step: "1" },
];

function toDraft(params: RunParameters): Draft {
  return {
    replications: String(params.replications),
    lambda: String(params.lambda),
    mu: String(params.mu),
    sim_time: String(params.sim_time),
    warmup_time: String(params.warmup_time),
    tolerance_pct: String(params.tolerance_pct),
    base_seed: String(params.base_seed),
    serial_baseline: params.serial_baseline,
  };
}

function toParams(draft: Draft): RunParameters {
  const numberValue = (value: string) => value.trim() === "" ? Number.NaN : Number(value);
  return {
    replications: numberValue(draft.replications),
    lambda: numberValue(draft.lambda),
    mu: numberValue(draft.mu),
    sim_time: numberValue(draft.sim_time),
    warmup_time: numberValue(draft.warmup_time),
    tolerance_pct: numberValue(draft.tolerance_pct),
    base_seed: numberValue(draft.base_seed),
    serial_baseline: draft.serial_baseline,
  };
}

function nextHealthyPeer(peers: Peer[], selected: string, healthyIds: Set<string>): Peer | undefined {
  const healthy = peers.filter((peer) => healthyIds.has(peer.id));
  if (healthy.length < 2) return undefined;
  const currentIndex = healthy.findIndex((peer) => peer.id === selected);
  return healthy[(currentIndex + 1 + healthy.length) % healthy.length];
}

export function LaunchPage({
  scenario,
  onStarted,
  resubmitRunId = null,
}: {
  scenario: MockScenario;
  onStarted: (run: RunCreated) => void;
  /** Prefill from this run (same parameters and base seed) on a different coordinator. */
  resubmitRunId?: string | null;
}) {
  const api = createApiClient(scenario);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [healthyIds, setHealthyIds] = useState<Set<string>>(new Set());
  const [coordinator, setCoordinator] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busyConflict, setBusyConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resubmitOf, setResubmitOf] = useState<RunRecord | null>(null);

  useEffect(() => {
    let active = true;
    const previous = resubmitRunId ? api.getRun(resubmitRunId) : Promise.resolve(null);
    Promise.all([api.getConfig(), api.getCluster(), previous]).then(([nextConfig, cluster, previousRun]) => {
      if (!active) return;
      setConfig(nextConfig);
      setResubmitOf(previousRun);
      const nextHealthyIds = new Set(cluster.nodes.filter((node) => node.healthy).map((node) => node.id));
      setHealthyIds(nextHealthyIds);
      // A resubmission avoids the original coordinator, which is presumed lost.
      const candidates = cluster.nodes.filter((node) => node.healthy && node.id !== previousRun?.coordinator);
      const initialCoordinator = candidates[0]?.id ?? cluster.nodes.find((node) => node.healthy)?.id ?? nextConfig.peers[0]?.id ?? "";
      setCoordinator(initialCoordinator);
      const params: RunParameters = previousRun ? { ...previousRun.params } : {
        ...nextConfig.defaults,
        base_seed: nextConfig.defaults.base_seed ?? randomSeed(nextConfig.defaults.replications),
      };
      setDraft(toDraft(params));
    }).catch((cause: unknown) => {
      if (active) setLoadError(cause instanceof Error ? cause.message : "Unable to load launch settings.");
    });
    return () => { active = false; };
  }, [scenario, resubmitRunId]);

  const params = useMemo(() => draft ? toParams(draft) : null, [draft]);
  const validation = useMemo(() => params ? validateRun(params) : null, [params]);
  const healthyPeer = healthyIds.has(coordinator);
  const alternatePeer = config ? nextHealthyPeer(config.peers, coordinator, healthyIds) : undefined;

  const setNumber = (name: NumericField, value: string) => {
    setDraft((current) => current ? { ...current, [name]: value } : current);
    setSubmitError(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!params || !validation || !config) return;
    setSubmitError(null);
    setBusyConflict(false);
    if (Object.keys(validation.errors).length > 0) return;
    if (!healthyPeer) {
      setSubmitError("Select a healthy coordinator before starting the run.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.createRun(coordinator, params);
      onStarted(result);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setBusyConflict(true);
        setSubmitError(cause.message);
      } else {
        setSubmitError(cause instanceof Error ? cause.message : "Unable to start the run.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loadError) {
    return <section className="page-content"><div className="notice notice-error" role="alert">{loadError}</div><a href="#/cluster">Return to Cluster</a></section>;
  }
  if (!config || !draft || !params || !validation) {
    return <section className="page-content"><div className="loading-state" role="status"><span className="spinner" />Loading run settings</div></section>;
  }

  const theoretical = validation.theoretical;
  return (
    <section className="page-content launch-content" aria-labelledby="launch-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">NEW SIMULATION</p>
          <h1 id="launch-heading">Launch run</h1>
          <p className="lede">Configure an independent replication batch and choose its coordinating node.</p>
        </div>
      </div>

      {resubmitOf && (
        <div className="notice notice-info" role="status">
          <RotateCcw size={15} /> Resubmitting batch {resubmitOf.batch_id} from {resubmitOf.coordinator} with the same parameters and base seed {resubmitOf.params.base_seed}. The same seed reproduces the same statistics.
        </div>
      )}
      {submitError && <div className={`notice ${busyConflict ? "notice-warning" : "notice-error"}`} role="alert">{submitError}</div>}
      {busyConflict && alternatePeer && (
        <div className="retry-strip">
          <span><TriangleAlert size={17} /> {alternatePeer.id} is healthy and available.</span>
          <button type="button" onClick={() => { setCoordinator(alternatePeer.id); setBusyConflict(false); setSubmitError(null); }}>Try {alternatePeer.id}<ArrowRight size={15} /></button>
        </div>
      )}

      <form className="launch-form" onSubmit={handleSubmit} noValidate>
        <div className="form-main">
          <section className="form-section">
            <div className="form-section-heading"><span className="section-index">01</span><div><h2>Coordinator</h2><p>One node owns this batch's live state.</p></div></div>
            <label className="field-label" htmlFor="coordinator">Run on</label>
            <div className="select-wrap"><Server size={16} /><select id="coordinator" value={coordinator} onChange={(event) => setCoordinator(event.target.value)}>
              {config.peers.map((peer) => <option key={peer.id} value={peer.id} disabled={!healthyIds.has(peer.id)}>{peer.id}{healthyIds.has(peer.id) ? " · healthy" : " · unreachable"}</option>)}
            </select></div>
            <p className="field-help">{config.peers.length} configured nodes · {healthyIds.size} currently healthy</p>
          </section>

          <section className="form-section">
            <div className="form-section-heading"><span className="section-index">02</span><div><h2>Queue model</h2><p>M/M/1 input rates and simulation horizon.</p></div></div>
            <div className="form-grid">
              {fieldConfig.filter((field) => field.name !== "replications" && field.name !== "tolerance_pct" && field.name !== "base_seed").map((field) => {
                const error = validation.errors[field.name as RunField];
                return <label className="number-field" key={field.name} htmlFor={field.name}>
                  <span className="field-label">{field.label}</span>
                  <input id={field.name} type="number" inputMode="decimal" min={field.min} step={field.step} value={draft[field.name]} aria-invalid={Boolean(error)} aria-describedby={error ? `${field.name}-error` : `${field.name}-help`} onChange={(event) => setNumber(field.name, event.target.value)} />
                  <span className="field-help" id={error ? `${field.name}-error` : `${field.name}-help`}>{error ?? field.description}</span>
                </label>;
              })}
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-heading"><span className="section-index">03</span><div><h2>Sampling</h2><p>Set replication count, tolerance, and reproducibility.</p></div></div>
            <div className="form-grid">
              {fieldConfig.filter((field) => field.name === "replications" || field.name === "tolerance_pct").map((field) => {
                const error = validation.errors[field.name];
                return <label className="number-field" key={field.name} htmlFor={field.name}>
                  <span className="field-label">{field.label}</span>
                  <input id={field.name} type="number" inputMode="numeric" min={field.min} max={field.max} step={field.step} value={draft[field.name]} aria-invalid={Boolean(error)} aria-describedby={error ? `${field.name}-error` : `${field.name}-help`} onChange={(event) => setNumber(field.name, event.target.value)} />
                  <span className="field-help" id={error ? `${field.name}-error` : `${field.name}-help`}>{error ?? field.description}</span>
                </label>;
              })}
              <label className="number-field seed-field" htmlFor="base_seed">
                <span className="field-label">Base seed</span>
                <div className="seed-input"><input id="base_seed" type="number" inputMode="numeric" min={0} step={1} value={draft.base_seed} aria-invalid={Boolean(validation.errors.base_seed)} aria-describedby={validation.errors.base_seed ? "base_seed-error" : "base_seed-help"} onChange={(event) => setNumber("base_seed", event.target.value)} /><button type="button" className="seed-button" title="Generate a random seed" aria-label="Generate a random seed" onClick={() => setNumber("base_seed", String(randomSeed(params.replications)))}><Dices size={16} /></button></div>
                <span className="field-help" id={validation.errors.base_seed ? "base_seed-error" : "base_seed-help"}>{validation.errors.base_seed ?? "Same seed and parameters reproduce this batch."}</span>
              </label>
            </div>
            {validation.warnings.map((warning) => <div className="inline-warning" key={warning}><TriangleAlert size={15} />{warning}</div>)}
            <label className="toggle-row"><input type="checkbox" checked={draft.serial_baseline} onChange={(event) => setDraft({ ...draft, serial_baseline: event.target.checked })} /><span className="toggle-copy"><strong>Run serial baseline</strong><small>Repeat the same seeds on the coordinator to measure speedup.</small></span></label>
          </section>
        </div>

        <aside className="run-aside" aria-label="Run summary">
          <p className="aside-label">QUEUE SNAPSHOT</p>
          <div className="rho-value"><span>Utilization ρ</span><strong className={validation.rho !== null && validation.rho >= 1 ? "rho-unstable" : ""}>{validation.rho === null ? "--" : validation.rho.toFixed(3)}</strong></div>
          {theoretical ? <div className="theory-values"><div><span>Expected time in system · W</span><strong>{theoretical.W.toFixed(3)}</strong></div><div><span>Expected items in system · L</span><strong>{theoretical.L.toFixed(3)}</strong></div></div> : <p className="aside-note">No stable M/M/1 steady state for these rates. Submission is blocked.</p>}
          <div className="aside-divider" />
          <div className="aside-detail"><span>Replications</span><strong>{params.replications || "--"}</strong></div>
          <div className="aside-detail"><span>Coordinator</span><strong>{coordinator || "--"}</strong></div>
          <button className="primary-button" type="submit" disabled={submitting || Object.keys(validation.errors).length > 0 || !healthyPeer}>
            {submitting ? <LoaderCircle size={17} className="button-spin" /> : <Play size={16} fill="currentColor" />}
            {submitting ? "Starting run" : "Start simulation"}
          </button>
          <p className="submit-note">The coordinator retains live batch state. If it is lost, resubmit with the same seed.</p>
        </aside>
      </form>
    </section>
  );
}