import { Activity, CircleX, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient } from "../api/client";
import type { MockScenario, NodeStatus, RunRecord, TaskCounts } from "../api/types";
import { formatSeconds, progressPercent } from "../lib/report";

const BACKOFF_MS = [1000, 2000, 4000, 5000];
const POLL_MS = 500;

const PHASE_LABEL: Record<NodeStatus["phase"], string> = {
  distributed: "Distributed run",
  serial_baseline: "Serial baseline",
  complete: "Complete",
};

function ProgressBlock({ title, counts, total }: { title: string; counts: TaskCounts; total: number }) {
  const done = counts.complete + counts.failed;
  const percent = progressPercent(done, total);
  return (
    <section className="progress-panel" aria-label={title}>
      <div className="progress-head">
        <h2>{title}</h2>
        <strong>{percent}%</strong>
      </div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={`${title}: ${done} of ${total} tasks finished`}>
        <span className="progress-fill" style={{ width: `${percent}%` }} />
        {counts.failed > 0 && <span className="progress-failed" style={{ width: `${progressPercent(counts.failed, total)}%` }} />}
      </div>
      <dl className="count-grid">
        <div><dt>Pending</dt><dd>{counts.pending}</dd></div>
        <div><dt>Assigned</dt><dd>{counts.assigned}</dd></div>
        <div><dt>Complete</dt><dd>{counts.complete}</dd></div>
        <div><dt>Failed</dt><dd className={counts.failed > 0 ? "text-unhealthy" : ""}>{counts.failed}</dd></div>
        <div><dt>Retried attempts</dt><dd>{counts.failed_attempts}</dd></div>
      </dl>
    </section>
  );
}

export function LivePage({ runId, scenario }: { runId: string; scenario: MockScenario }) {
  const api = useMemo(() => createApiClient(scenario), [scenario]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let failures = 0;
    const toReport = () => window.location.replace(`#/report/${encodeURIComponent(runId)}`);

    const poll = async () => {
      let rec: RunRecord;
      try {
        rec = await api.getRun(runId);
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setMissing(true);
          return;
        }
        failures += 1;
        setError(cause instanceof Error ? cause.message : "Unable to reach the gateway.");
        timer = window.setTimeout(poll, BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]);
        return;
      }
      if (!active) return;
      setRecord(rec);
      if (rec.state === "complete") return toReport();
      if (rec.state === "coordinator_lost") {
        setStatus(rec.status);
        setError(null);
        return;
      }
      try {
        const next = await api.getStatus(runId);
        if (!active) return;
        setStatus(next);
        setError(null);
        failures = 0;
        if (next.state === "complete") return toReport();
        timer = window.setTimeout(poll, POLL_MS);
      } catch (cause) {
        if (!active) return;
        failures += 1;
        setError(cause instanceof Error ? cause.message : "Unable to read batch status.");
        timer = window.setTimeout(poll, BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]);
      }
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, runId]);

  if (missing) {
    return <section className="page-content"><div className="empty-state"><CircleX size={22} /><strong>Run not found</strong><span>The gateway has no record of this run. Its history is kept in memory and is cleared when the gateway restarts.</span><a href="#/launch">Launch a new run</a></div></section>;
  }
  if (!record) {
    return <section className="page-content"><div className="loading-state" role="status"><span className="spinner" />Loading run</div></section>;
  }

  const lost = record.state === "coordinator_lost";
  return (
    <section className="page-content" aria-labelledby="live-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">LIVE BATCH</p>
          <h1 id="live-heading">{lost ? "Coordinator lost" : "Batch running"}</h1>
          <p className="lede mono">{record.batch_id}</p>
        </div>
        {!lost && <span className="state-badge state-running"><Activity size={14} />Running</span>}
        {lost && <span className="state-badge state-lost"><CircleX size={14} />Lost</span>}
      </div>

      {lost && (
        <div className="notice notice-error" role="alert">
          <strong>{record.coordinator} no longer holds this batch.</strong> Batch state lives only on its coordinator, so this run cannot finish.
          Resubmit it on another node with base seed <strong className="mono">{record.params.base_seed}</strong>; the same seed reproduces the same results.{" "}
          <a href="#/launch" className="inline-link"><RotateCcw size={13} />Go to Launch</a>
        </div>
      )}
      {!lost && error && <div className="notice notice-warning" role="status"><TriangleAlert size={14} /> {error} Retrying.</div>}
      {!lost && status?.stale && <div className="notice notice-warning" role="status">The coordinator is not answering; showing the last status the gateway saw.</div>}

      <div className="summary-strip">
        <div className="summary-stat"><span>Coordinator</span><strong>{record.coordinator}</strong></div>
        <div className="summary-stat"><span>Base seed</span><strong className="mono">{record.params.base_seed}</strong></div>
        <div className="summary-stat"><span>Elapsed</span><strong>{formatSeconds(status?.elapsed_seconds)}</strong></div>
        <div className="summary-stat"><span>Phase</span><strong>{status ? PHASE_LABEL[status.phase] : "--"}</strong></div>
      </div>

      {status ? (
        <div className="progress-stack">
          <ProgressBlock title="Replications across the pool" counts={status} total={status.replications} />
          {status.serial_baseline && <ProgressBlock title={`Serial baseline on ${record.coordinator}`} counts={status.serial_baseline} total={status.replications} />}
        </div>
      ) : (
        !lost && <div className="loading-state" role="status"><span className="spinner" />Waiting for the first status</div>
      )}
    </section>
  );
}
