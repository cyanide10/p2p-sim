import { Activity, Check, CircleCheck, CircleX, History, RotateCcw, TriangleAlert, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient } from "../api/client";
import type { MetricComparison, MockScenario, NetworkReport, NodeReport, RunRecord, RunReport } from "../api/types";
import { NetworkReportView } from "./NetworkReport";
import { PDESReportView } from "./PDESReport";
import { AttackReportView } from "./AttackReport";
import { MetricDotWhisker } from "../components/charts/DotWhisker";
import { CopyJsonButton } from "../components/CopyJsonButton";
import { EmptyState, LoadingState, Notice, PageHeading, PanelTitle, SectionTitle, StatStrip } from "../components/PagePrimitives";

function isNetworkReport(report: RunReport): report is NetworkReport {
  return "kind" in report && report.kind === "network";
}
import { formatDuration, formatNumber, formatPercent, formatSpeedup } from "../lib/format";

const SMALL_SAMPLE = 30;

function Check2({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={`check ${ok ? "check-ok" : "check-bad"}`}>{ok ? <Check size={13} /> : <CircleX size={13} />}{ok ? yes : no}</span>;
}

function MetricCard({ title, symbol, metric, informational }: { title: string; symbol: string; metric: MetricComparison | null; informational?: boolean }) {
  return (
    <article className="metric-card">
      <header>
        <div><h3>{title}</h3><span>vs theoretical {symbol}{informational ? " · informational" : ""}</span></div>
      </header>
      {metric ? (
        <>
          <MetricDotWhisker metric={metric} label={title} />
          <div className="metric-checks">
            <Check2 ok={metric.within_tolerance} yes="Within tolerance" no="Outside tolerance" />
            <Check2 ok={metric.theoretical_in_ci} yes="Theory in CI" no="Theory outside CI" />
          </div>
          <dl className="metric-numbers">
            <div><dt>Mean</dt><dd>{formatNumber(metric.mean)}</dd></div>
            <div><dt>Theoretical</dt><dd>{formatNumber(metric.theoretical)}</dd></div>
            <div><dt>95% CI</dt><dd>{formatNumber(metric.ci95_low)} – {formatNumber(metric.ci95_high)}</dd></div>
            <div><dt>Rel. error</dt><dd>{formatPercent(metric.rel_error_pct)} <small>/ {formatPercent(metric.tolerance_pct, 0)}</small></dd></div>
            <div><dt>Std. dev.</dt><dd>{formatNumber(metric.stddev)}</dd></div>
            <div><dt>n</dt><dd>{metric.n}</dd></div>
          </dl>
        </>
      ) : <p className="metric-empty">Needs at least two completed replications.</p>}
    </article>
  );
}

function SerialMatch({ report }: { report: NodeReport }) {
  const match = report.timing.serial_results_match_distributed;
  if (match === undefined) {
    return <div className="serial-match serial-none"><span>Serial check</span><strong>{report.timing.serial_note ?? "Not run"}</strong></div>;
  }
  return match
    ? <div className="serial-match serial-ok"><CircleCheck size={18} /><span>Serial and distributed results are identical, seed for seed.</span></div>
    : <div className="serial-match serial-bad" role="alert"><TriangleAlert size={20} /><span><strong>Serial results do not match distributed results.</strong> The same seeds produced different statistics, so results are not reproducible across nodes. Investigate before trusting this batch.</span></div>;
}

export function ReportPage({ runId, scenario }: { runId: string; scenario: MockScenario }) {
  const api = useMemo(() => createApiClient(scenario), [scenario]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [report, setReport] = useState<RunReport | null>(null);
  const [error, setError] = useState<{ message: string; status: number | null } | null>(null);

  useEffect(() => {
    let active = true;
    setRecord(null);
    setReport(null);
    setError(null);
    api.getRun(runId).then((nextRecord) => {
      if (active) setRecord(nextRecord);
    }).catch(() => undefined);
    api.getReport(runId).then((nextReport) => {
      if (active) setReport(nextReport);
    }).catch((cause: unknown) => {
      if (active) setError({
        message: cause instanceof Error ? cause.message : "Unable to load the report.",
        status: cause instanceof ApiError ? cause.status : null,
      });
    });
    return () => { active = false; };
  }, [api, runId]);

  if (error) {
    const lost = record?.state === "coordinator_lost";
    return (
      <section className="page-content">
        <EmptyState
          icon={lost ? <Unplug size={22} /> : <CircleX size={22} />}
          title={error.status === 404 ? "Run not found" : lost ? "No report: the coordinator was lost" : "Report unavailable"}
        >
          <span>{error.message}</span>
          {lost
            ? <a href={`#/launch?resubmit=${encodeURIComponent(runId)}`}><RotateCcw size={14} /> Resubmit with the same base seed</a>
            : <a href={`#/live/${encodeURIComponent(runId)}`}>Open live view</a>}
        </EmptyState>
      </section>
    );
  }
  if (!report) {
    return <section className="page-content"><LoadingState>Loading report</LoadingState></section>;
  }

  if (isNetworkReport(report)) {
    return <NetworkReportView report={report} runId={runId} api={api} />;
  }
  if ("kind" in report && report.kind === "pdes") {
    return <PDESReportView report={report} runId={runId} />;
  }
  if ("kind" in report && report.kind === "attack") {
    return <AttackReportView report={report} runId={runId} />;
  }
  const n = report.mean_wait_time?.n ?? report.tasks.complete;
  const peerCounts = Object.entries(report.tasks_per_peer).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const maxPeer = Math.max(1, ...peerCounts.map(([, count]) => count));
  const totalDone = peerCounts.reduce((sum, [, count]) => sum + count, 0);
  const verdictClass = report.verdict === "PASS" ? "verdict-pass" : report.verdict === "FAIL" ? "verdict-fail" : "verdict-pending";

  return (
    <section className="page-content" aria-labelledby="report-heading">
      <PageHeading
        id="report-heading"
        eyebrow="BATCH REPORT"
        title="Report"
        lede={`${report.batch_id} · coordinated by ${report.coordinator}`}
        actions={<>
          <a className="ghost-button" href={`#/live/${encodeURIComponent(runId)}`}><Activity size={15} />Live view</a>
          <CopyJsonButton value={report} label="Copy as JSON" />
        </>}
      />

      {report.stale && <Notice kind="warning" className="stale-notice"><History size={15} />Stored snapshot: the coordinator is unavailable, so this report may be out of date.</Notice>}
      {report.verdict === "PENDING" && <Notice kind="warning">The batch is still running. Statistics are provisional.</Notice>}
      {n < SMALL_SAMPLE && <Notice kind="warning"><TriangleAlert size={15} /> Only {n} replications completed. The normal-approximation 95% CI is only reliable for n ≥ {SMALL_SAMPLE}.</Notice>}

      <div className={`verdict-card ${verdictClass}`}>
        <div className="verdict-mark">{report.verdict === "PASS" ? <CircleCheck size={30} /> : report.verdict === "FAIL" ? <CircleX size={30} /> : <Activity size={30} />}</div>
        <div>
          <p className="eyebrow">VERDICT</p>
          <strong className="verdict-word">{report.verdict}</strong>
          <p>{report.verdict_detail}</p>
        </div>
      </div>

      <SectionTitle title="Metrics vs M/M/1 theory" note="Dot: mean · whisker: 95% CI · dashed line: theory · band: tolerance" />
      <div className="metric-grid">
        <MetricCard title="Mean time in system" symbol="W" metric={report.mean_wait_time} />
        <MetricCard title="Mean number in system" symbol="L" metric={report.mean_queue_length} />
        <MetricCard title="Utilization" symbol="ρ" metric={report.utilization} informational />
      </div>

      <div className="report-columns">
        <div className="panel">
          <PanelTitle title="Tasks per node" note="Completed results" />
          {peerCounts.length === 0 ? <p className="metric-empty">No completed results yet.</p> : (
            <ul className="peer-bars">
              {peerCounts.map(([peer, count]) => (
                <li key={peer}>
                  <span className="peer-name">{peer}</span>
                  <span className="peer-bar"><i style={{ width: `${(count / maxPeer) * 100}%` }} /></span>
                  <span className="peer-count">{count}<small> · {((count / totalDone) * 100).toFixed(0)}%</small></span>
                </li>
              ))}
            </ul>
          )}
          <p className="panel-note">{report.timing.distributed_peers} nodes in the pool · {report.tasks.failed_attempts} failed attempt(s) retried · {report.tasks.failed} permanently failed</p>
        </div>

        <div className="panel">
          <PanelTitle title="Timing" note="Distributed vs serial" />
          <div className="speedup"><span>Speedup</span><strong>{formatSpeedup(report.timing.speedup)}</strong></div>
          <dl className="timing-list">
            <div><dt>Distributed wall clock</dt><dd>{formatDuration(report.timing.distributed_wall_clock_seconds)}</dd></div>
            <div><dt>Serial wall clock{report.timing.serial_peer ? ` (${report.timing.serial_peer})` : ""}</dt><dd>{formatDuration(report.timing.serial_wall_clock_seconds)}</dd></div>
            <div><dt>Sum of replication runtimes</dt><dd>{formatDuration(report.timing.sum_replication_runtime_seconds)}</dd></div>
          </dl>
          <SerialMatch report={report} />
        </div>
      </div>

      {report.failed_tasks.length > 0 && (
        <>
          <SectionTitle title="Permanently failed tasks" note={report.failed_tasks.length} />
          <div className="matrix-frame">
            <table className="data-table">
              <thead><tr><th scope="col">Task</th><th scope="col">Seed</th><th scope="col">Attempts</th><th scope="col">Last error</th></tr></thead>
              <tbody>{report.failed_tasks.map((task) => <tr key={task.task_id}><td>{task.task_id}</td><td>{task.seed}</td><td>{task.attempts}</td><td>{task.error}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}

      <SectionTitle title="Parameters" />
      <StatStrip
        variant="meta"
        className="params-strip"
        items={[
          { label: "λ", value: report.params.lambda },
          { label: "μ", value: report.params.mu },
          { label: "ρ", value: formatNumber(report.theoretical.rho, 3) },
          { label: "Simulation time", value: report.params.sim_time },
          { label: "Warmup", value: report.params.warmup_time },
          { label: "Replications", value: report.replications_requested },
          { label: "Base seed", value: report.base_seed },
          { label: "Tolerance", value: formatPercent(report.tolerance_pct, 0) },
          { label: "Seed scheme", value: report.seed_scheme, wide: true },
          { label: "CI method", value: report.ci_method, wide: true },
        ]}
      />
    </section>
  );
}
