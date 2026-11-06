import { CircleCheck, CircleHelp, CircleX, LoaderCircle, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import type { RunState, TaskCounts, TaskDetail } from "../api/types";

const stateLabels: Record<RunState, string> = {
  running: "Running",
  complete: "Complete",
  failed: "Failed",
  coordinator_lost: "Coordinator lost",
  unknown: "Unknown",
};

export type BadgeTone = "active" | "good" | "warn" | "bad" | "neutral";

const toneState: Record<BadgeTone, string> = {
  active: "running",
  good: "complete",
  warn: "warn",
  bad: "failed",
  neutral: "unknown",
};

/**
 * Shared status pill. Pass a RunState for run semantics and icon, or a label
 * plus tone for page-local transport states (worker/PDES streams, player).
 */
export function StateBadge({ state, label, tone = "neutral", busy, className }: {
  state?: RunState;
  label?: string;
  tone?: BadgeTone;
  busy?: boolean;
  className?: string;
}) {
  const icon = state === "running" || busy
    ? <LoaderCircle size={14} className="button-spin" />
    : state === "complete"
      ? <CircleCheck size={14} />
      : state === "coordinator_lost"
        ? <Unplug size={14} />
        : state === "failed"
          ? <CircleX size={14} />
          : state === "unknown"
            ? <CircleHelp size={14} />
            : null;
  const toneClass = state ? `state-${state}` : `state-${toneState[tone]}`;
  return (
    <span className={`state-badge ${toneClass}${className ? ` ${className}` : ""}`}>
      {icon}{label ?? (state ? stateLabels[state] : "")}
    </span>
  );
}

/**
 * Progress bar with counts inline. Batch runs pass task `counts` (complete,
 * in-flight and failed segments); window-based PDES/attack runs pass a single
 * `done` count for the current coordination window.
 */
export function ProgressBar({ counts, total, label, done: doneCount, detail, percentageDigits = 0 }: {
  counts?: TaskCounts;
  total: number;
  label: string;
  done?: number;
  detail?: ReactNode;
  percentageDigits?: number;
}) {
  const complete = doneCount ?? counts?.complete ?? 0;
  const pct = (value: number) => (total > 0 ? (value / total) * 100 : 0);
  const done = pct(complete);
  return (
    <div className="progress-block">
      <div className="progress-head">
        <span>{label}</span>
        <strong>
          {complete.toLocaleString()} / {total.toLocaleString()}<small> · {done.toFixed(percentageDigits)}%</small>
          {detail !== undefined && <small> · {detail}</small>}
        </strong>
      </div>
      <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={complete}>
        <span className="progress-complete" style={{ width: `${done}%` }} />
        {counts && <>
          <span className="progress-assigned" style={{ width: `${pct(counts.assigned)}%` }} />
          <span className="progress-failed" style={{ width: `${pct(counts.failed)}%` }} />
        </>}
      </div>
    </div>
  );
}

const MAX_GRID_CELLS = 2000;

export function TaskGrid({
  tasks,
  enabled,
  peers,
  mock,
}: {
  tasks: TaskDetail[] | undefined;
  enabled: boolean;
  peers: string[];
  mock: boolean;
}) {
  if (!enabled) return null;
  if (!tasks) {
    return (
      <div className="grid-placeholder">
        <CircleHelp size={18} />
        <div>
          <strong>Per-replication view needs node API support</strong>
          <span>Nodes currently report aggregate counts only, so individual task states, assigned nodes and retries are not available.</span>
        </div>
      </div>
    );
  }
  if (tasks.length > MAX_GRID_CELLS) {
    return <div className="grid-placeholder"><CircleHelp size={18} /><div><strong>Too many replications to draw</strong><span>The task grid is shown for batches of up to {MAX_GRID_CELLS.toLocaleString()} replications.</span></div></div>;
  }
  const peerIndex = new Map(peers.map((peer, index) => [peer, index]));
  const retried = tasks.filter((task) => task.attempts > 1).length;
  return (
    <div className="task-grid-wrap">
      <ul className="task-legend" aria-label="Task grid legend">
        {peers.map((peer, index) => <li key={peer}><i className={`peer-swatch peer-${index % 6}`} />{peer}</li>)}
        <li><i className="peer-swatch swatch-assigned" />In flight</li>
        <li><i className="peer-swatch swatch-pending" />Pending</li>
        <li><i className="peer-swatch swatch-failed" />Failed</li>
        <li><i className="peer-swatch swatch-retried" />Retried{retried > 0 ? ` (${retried})` : ""}</li>
      </ul>
      <div className="task-grid" role="img" aria-label={`${tasks.filter((task) => task.state === "complete").length} of ${tasks.length} replications complete`}>
        {tasks.map((task) => {
          const peerClass = task.peer_id !== undefined && peerIndex.has(task.peer_id) ? `peer-${peerIndex.get(task.peer_id)! % 6}` : "";
          const title = `${task.task_id} · ${task.state}${task.peer_id ? ` on ${task.peer_id}` : ""}${task.attempts > 1 ? ` · ${task.attempts} attempts` : ""}`;
          return <span key={task.task_id} title={title} className={`task-cell task-${task.state} ${task.state === "complete" ? peerClass : ""} ${task.attempts > 1 ? "task-retried" : ""}`} />;
        })}
      </div>
      {mock && <p className="grid-note">Per-task detail comes from the mock API. Real nodes do not supply it yet.</p>}
    </div>
  );
}
