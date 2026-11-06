import { Activity, Layers, LoaderCircle, Play, Server } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { PartitionPlan } from "../../api/types";
import { StateBadge, type BadgeTone } from "../RunBits";
import type { ExecutionMode, PoolNode, RemoteCampaign } from "./types";

const EXECUTION_MODES: Array<{ id: ExecutionMode; label: string; hint: string }> = [
  { id: "local", label: "Local model", hint: "Runs in this browser; available offline." },
  { id: "worker", label: "Node worker", hint: "One partition on a node; same result, computed remotely." },
  { id: "pdes", label: "PDES pool", hint: "Topology tokens split across healthy nodes in lock-step." },
];

interface Props {
  mode: ExecutionMode;
  pool: PoolNode[];
  coordinator: string;
  parts: number;
  baseline: boolean;
  plan: PartitionPlan | null;
  planning: boolean;
  submitting: boolean;
  remote: RemoteCampaign | null;
  effectiveParts: number;
  healthyCount: number;
  maxParts: number;
  onMode: (mode: ExecutionMode) => void;
  onCoordinator: (id: string) => void;
  onParts: (value: number) => void;
  onBaseline: (value: boolean) => void;
  onPreview: () => void;
  onRun: () => void;
}

/** Execution-mode picker and the collapsible placement/remote-job detail. */
export function AttackExecution({
  mode, pool, coordinator, parts, baseline, plan, planning, submitting, remote,
  effectiveParts, healthyCount, maxParts, onMode, onCoordinator, onParts, onBaseline, onPreview, onRun,
}: Props) {
  const report = remote?.report ?? null;
  const state = remote?.status?.state ?? null;
  const remoteActive = Boolean(remote && !report);
  const [detailOpen, setDetailOpen] = useState(true);

  useEffect(() => {
    if (remoteActive) setDetailOpen(false);
  }, [remoteActive]);

  const remoteTone: BadgeTone = state === "failed" ? "bad" : report ? "good" : "warn";
  const moveMode = (event: KeyboardEvent<HTMLButtonElement>, current: ExecutionMode) => {
    const index = EXECUTION_MODES.findIndex((item) => item.id === current);
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (index + 1) % EXECUTION_MODES.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (index - 1 + EXECUTION_MODES.length) % EXECUTION_MODES.length
        : event.key === "Home" ? 0
          : event.key === "End" ? EXECUTION_MODES.length - 1 : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = EXECUTION_MODES[nextIndex].id;
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
    onMode(next);
  };
  const total = report?.plan.windows ?? remote?.status?.windows_total ?? 0;
  const done = report ? total : remote?.status?.windows_done ?? 0;
  const simulated = report ? report.partitioned_wall_seconds : remote?.status?.simulated_time ?? 0;

  return (
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
            tabIndex={mode === item.id ? 0 : -1}
            className={`attack-exec-mode ${mode === item.id ? "is-active" : ""}`}
            onClick={() => onMode(item.id)}
            onKeyDown={(event) => moveMode(event, item.id)}>
            {item.id === "local" ? <Activity size={16} /> : item.id === "worker" ? <Server size={16} /> : <Layers size={16} />}
            <span><strong>{item.label}</strong><small>{item.hint}</small></span>
          </button>
        ))}
      </div>

      {mode !== "local" && (
        <div className="attack-exec-pool">
          <label className="attack-exec-field"><span>Coordinator</span>
            <select value={coordinator} onChange={(event) => onCoordinator(event.target.value)}>
              {pool.length === 0 && <option value="">No nodes discovered</option>}
              {pool.map((node) => <option key={node.id} value={node.id} disabled={!node.healthy}>{node.id}{node.healthy ? "" : " · down"}</option>)}
            </select>
          </label>
          {mode === "pdes" && (
            <label className="attack-exec-field"><span>Partitions</span>
              <select value={Math.min(parts, maxParts)} onChange={(event) => onParts(Number(event.target.value))}>
                {Array.from({ length: maxParts }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          )}
          {mode === "worker" && <span className="attack-exec-note">1 partition · {healthyCount} healthy {healthyCount === 1 ? "node" : "nodes"}</span>}
          {mode === "pdes" && (
            <label className="attack-exec-check">
              <input type="checkbox" checked={baseline} onChange={(event) => onBaseline(event.target.checked)} />
              <span>Serial baseline</span>
            </label>
          )}
          {mode === "pdes" && (
            <button type="button" className="ghost-button" onClick={onPreview} disabled={planning || !coordinator || maxParts < 1}>
              {planning ? <LoaderCircle size={14} className="button-spin" /> : <Layers size={14} />}Preview placement
            </button>
          )}
          <button type="button" className="primary-button" onClick={onRun} disabled={submitting || !coordinator}>
            {submitting ? <LoaderCircle size={14} className="button-spin" /> : <Play size={14} fill="currentColor" />}
            {mode === "worker" ? "Run on worker" : `Run on ${effectiveParts} partitions`}
          </button>
        </div>
      )}

      {(plan || remote) && (
        <details className="attack-exec-detail" open={detailOpen} onToggle={(event) => setDetailOpen(event.currentTarget.open)}>
          <summary>
            <span>Execution detail</span>
            <span className="attack-exec-detail-hint">
              {remote ? (
                <>
                  <StateBadge className="attack-status" tone={remoteTone} label={state === "failed" ? "failed" : report ? "complete" : state ?? "queued"} />
                  {`${done} / ${total || "?"} windows · T+ ${simulated.toFixed(1)}s`}
                </>
              ) : plan ? `${plan.parts} parts · ${plan.windows} windows` : ""}
            </span>
          </summary>

          {plan && (
            <div className="attack-exec-plan">
              <span><strong>{plan.parts}</strong> parts</span>
              <span><strong>{plan.windows}</strong> lock-step windows</span>
              <span><strong>{plan.lookahead.toFixed(1)}s</strong> lookahead</span>
              <span>tokens / part: {plan.load.join(" · ")}</span>
            </div>
          )}

          {remote && (
            <div className={`attack-exec-status ${report ? "is-done" : ""}`} role="status">
              <div className="attack-exec-status-head">
                <StateBadge
                  className="attack-status"
                  tone={remoteTone}
                  label={state === "failed" ? "failed" : report ? "complete" : state ?? "queued"}
                />
                <code>{remote.runId}</code>
                <span>{effectiveParts === 1 ? "1 worker" : `${effectiveParts} partitions`}</span>
              </div>
              <div className="attack-exec-progress">
                <i><b style={{ width: `${total ? Math.min(100, (done / total) * 100) : 4}%` }} /></i>
                <span>{done} / {total || "?"} windows · T+ {simulated.toFixed(1)}s</span>
              </div>
              <div className="attack-exec-workers">
                {Object.entries(report?.partitions ?? remote.status?.partitions ?? {}).map(([node, timing]) => (
                  <div key={node}>
                    <strong>{node}</strong>
                    <span>{timing.messages} msgs · {timing.compute_s.toFixed(2)}s compute · {timing.wait_s.toFixed(2)}s wait</span>
                  </div>
                ))}
              </div>
              {report && (
                <p className="attack-exec-result">
                  Merged {report.metrics?.samples.length ?? 0} campaign samples
                  {report.results_identical !== undefined && ` · baseline ${report.results_identical ? "identical" : "differs"}`}
                  {report.speedup !== undefined && ` · ${report.speedup.toFixed(2)}× vs serial`}
                  {report.failed_node && ` · failed on ${report.failed_node}`}
                </p>
              )}
            </div>
          )}
        </details>
      )}
    </section>
  );
}
