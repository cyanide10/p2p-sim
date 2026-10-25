import { CircleCheck, CircleX, Copy, Hourglass, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient } from "../api/client";
import type { MetricComparison, MockScenario, NodeReport } from "../api/types";
import { ciScale, formatNumber, formatSeconds } from "../lib/report";

const PENDING_POLL_MS = 2000;
const SMALL_SAMPLE = 30;

const METRICS: Array<{ key: "mean_wait_time" | "mean_queue_length" | "utilization"; label: string; symbol: string }> = [
  { key: "mean_wait_time", label: "Mean time in system", symbol: "W" },
  { key: "mean_queue_length", label: "Mean number in system", symbol: "L" },
  { key: "utilization", label: "Server utilization", symbol: "ρ" },
];

function CiBar({ metric }: { metric: MetricComparison }) {
  const s = ciScale(metric);
  return (
    <div className="ci-bar" aria-hidden="true">
      <span className="ci-range" style={{ left: `${s.low}%`, width: `${s.high - s.low}%` }} />
      <span className="ci-mean" style={{ left: `${s.mean}%` }} />
      <span className={`ci-theory ${metric.theoretical_in_ci ? "" : "outside"}`} style={{ left: `${s.theory}%` }} />
    </div>
  );
}

function Check({ ok }: { ok: boolean }) {
  return ok ? <span className="text-healthy check"><CircleCheck size={14} />Yes</span> : <span className="text-unhealthy check"><CircleX size={14} />No</span>;
}

function Verdict({ verdict }: { verdict: NodeReport["verdict"] }) {
  if (verdict === "PASS") return <span className="verdict verdict-pass"><CircleCheck size={18} />PASS</span>;
  if (verdict === "FAIL") return <span className="verdict verdict-fail"><CircleX size={18} />FAIL</span>;
  return <span className="verdict verdict-pending"><Hourglass size={18} />PENDING</span>;
}

export function ReportPage({ runId, scenario }: { runId: string; scenario: MockScenario }) {
  const api = useMemo(() => createApiClient(scenario), [scenario]);
  const [report, setReport] = useState<NodeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await api.getReport(runId);
        if (!active) return;
        setReport(next);
        setError(null);
        if (next.verdict === "PENDING") timer = window.setTimeout(load, PENDING_POLL_MS);
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setMissing(cause.message);
          return;
        }
        setError(cause instanceof Error ? cause.message : "Unable to load the report.");
        timer = window.setTimeout(load, PENDING_POLL_MS);
      }
    };
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, runId]);

  const copyJson = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("The browser blocked clipboard access.");
    }
  };

  if (missing) {
    return <section className="page-content"><div className="empty-state"><CircleX size={22} /><strong>Report unavailable</strong><span>{missing}</span><a href="#/launch">Launch a new run</a></div></section>;
  }
  if (!report) {
    return (
      <section className="page-content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="loading-state" role="status"><span className="spinner" />Loading report</div>
      </section>
    );
  }

  const { timing } = report;
  const smallSample = METRICS.some(({ key }) => {
    const metric = report[key];
    return metric !== null && metric.n < SMALL_SAMPLE;
  });
  const peerEntries = Object.entries(report.tasks_per_peer).sort(([a], [b]) => a.localeCompare(b));
  const maxTasks = Math.max(1, ...peerEntries.map(([, count]) => count));

  return (
    <section className="page-content" aria-labelledby="report-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">BATCH REPORT</p>
          <h1 id="report-heading">Results</h1>
          <p className="lede mono">{report.batch_id} · coordinated by {report.coordinator}</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" type="button" onClick={() => void copyJson()}><Copy size={15} />{copied ? "Copied" : "Copy JSON"}</button>
        </div>
      </div>

      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {report.stale && <div className="notice notice-warning" role="status">The coordinator is not answering; this is the copy of the report the gateway stored.</div>}
      {timing.serial_results_match_distributed === false && (
        <div className="notice notice-error" role="alert">
          <strong>Serial baseline does not match the distributed results.</strong> The same seeds produced different numbers on one node, so the replications are not reproducible. The speedup figure cannot be trusted.
        </div>
      )}
      {smallSample && <div className="notice notice-warning" role="status"><TriangleAlert size={14} /> Fewer than {SMALL_SAMPLE} replications completed. The normal-approximation confidence intervals are unreliable at this size, so treat the verdict as weak evidence.</div>}

      <div className="verdict-panel">
        <Verdict verdict={report.verdict} />
        <p>{report.verdict_detail}</p>
      </div>

      <div className="summary-strip">
        <div className="summary-stat"><span>λ / μ</span><strong>{report.params.lambda} / {report.params.mu}</strong></div>
        <div className="summary-stat"><span>Replications</span><strong>{report.tasks.complete}<small> / {report.replications_requested}</small></strong></div>
        <div className="summary-stat"><span>Base seed</span><strong className="mono">{report.base_seed}</strong></div>
        <div className="summary-stat"><span>Tolerance</span><strong>±{report.tolerance_pct}%</strong></div>
      </div>

      <div className="section-title"><h2>Simulation vs. theory</h2><span>{report.ci_method}</span></div>
      <div className="matrix-frame">
        <table className="metric-table">
          <thead>
            <tr><th scope="col">Metric</th><th scope="col">Mean</th><th scope="col">95% CI</th><th scope="col">Theory</th><th scope="col">Rel. error</th><th scope="col">Within tolerance</th><th scope="col">Theory in CI</th><th scope="col" className="ci-col">Interval</th></tr>
          </thead>
          <tbody>
            {METRICS.map(({ key, label, symbol }) => {
              const metric = report[key];
              if (!metric) return <tr key={key}><th scope="row">{symbol} <small>{label}</small></th><td colSpan={7} className="muted">No completed replications yet</td></tr>;
              return (
                <tr key={key}>
                  <th scope="row"><span className="metric-symbol">{symbol}</span> <small>{label}</small></th>
                  <td className="mono">{formatNumber(metric.mean, 4)}</td>
                  <td className="mono">[{formatNumber(metric.ci95_low, 4)}, {formatNumber(metric.ci95_high, 4)}]</td>
                  <td className="mono">{formatNumber(metric.theoretical, 4)}</td>
                  <td className="mono">{formatNumber(metric.rel_error_pct, 2)}%</td>
                  <td><Check ok={metric.within_tolerance} /></td>
                  <td><Check ok={metric.theoretical_in_ci} /></td>
                  <td className="ci-col"><CiBar metric={metric} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="legend"><span className="legend-range" />95% CI <span className="legend-mean" />Mean <span className="legend-theory" />Theory</p>

      <div className="report-columns">
        <section>
          <div className="section-title"><h2>Work per node</h2><span>{report.tasks.complete} complete · {report.tasks.failed} failed</span></div>
          <div className="peer-bars">
            {peerEntries.map(([peer, count]) => (
              <div className="peer-bar" key={peer}>
                <span>{peer}</span>
                <div className="progress-track"><span className="progress-fill" style={{ width: `${(count / maxTasks) * 100}%` }} /></div>
                <strong>{count}</strong>
              </div>
            ))}
            {peerEntries.length === 0 && <p className="muted">No tasks completed yet.</p>}
          </div>
          {report.failed_tasks.length > 0 && (
            <details className="failed-tasks">
              <summary>{report.failed_tasks.length} failed task{report.failed_tasks.length === 1 ? "" : "s"}</summary>
              <ul>{report.failed_tasks.map((task) => <li key={task.task_id}><span className="mono">{task.task_id}</span> seed {task.seed}, {task.attempts} attempts: {task.error}</li>)}</ul>
            </details>
          )}
        </section>

        <section>
          <div className="section-title"><h2>Timing</h2><span>{timing.distributed_peers} peers</span></div>
          <dl className="timing-list">
            <div><dt>Distributed wall clock</dt><dd>{formatSeconds(timing.distributed_wall_clock_seconds)}</dd></div>
            <div><dt>Sum of replication runtimes</dt><dd>{formatSeconds(timing.sum_replication_runtime_seconds)}</dd></div>
            <div><dt>Serial wall clock{timing.serial_peer ? ` (${timing.serial_peer})` : ""}</dt><dd>{formatSeconds(timing.serial_wall_clock_seconds)}</dd></div>
            <div><dt>Speedup</dt><dd className="speedup">{timing.speedup === null ? "--" : `${timing.speedup.toFixed(2)}×`}</dd></div>
            {timing.serial_results_match_distributed !== undefined && (
              <div><dt>Serial results match</dt><dd><Check ok={timing.serial_results_match_distributed} /></dd></div>
            )}
          </dl>
          {timing.serial_note && <p className="muted small">{timing.serial_note}</p>}
        </section>
      </div>
    </section>
  );
}
