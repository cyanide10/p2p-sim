import { Activity, Check, CircleX, Network, TriangleAlert } from "lucide-react";
import { CopyJsonButton } from "../components/CopyJsonButton";
import { ReportHeader } from "../components/ReportHeader";
import type { PDESMetrics, PDESReport } from "../api/types";
import { PartitionTimingList } from "../components/PartitionTiming";
import { TopologyCanvas } from "../components/TopologyCanvas";
import { EmptyState, Notice, SectionTitle, StatStrip } from "../components/PagePrimitives";
import { formatDuration, formatPdesMetricValue, formatSpeedup, pdesMetricLabel } from "../lib/format";
import { partitionBreakdown } from "../lib/pdes";

function MetricTable({ title, values }: { title: string; values: Record<string, Record<string, number | null>> }) {
  const ids = Object.keys(values);
  const columns = [...new Set(Object.values(values).flatMap((row) => Object.keys(row)))];
  const confidenceColumns = columns.filter((column) => column.startsWith("ci95_"));
  const metricColumns = columns.filter((column) => !column.startsWith("ci95_"));
  const orderedColumns = [...metricColumns, ...confidenceColumns];
  return (
    <section className="pdes-metric-section">
      <SectionTitle title={title} note={`${ids.length} items`} />
      {!ids.length ? <p className="muted">No merged values.</p> : <div className="table-scroll">
        <table className="net-table pdes-metric-table">
          <thead>
            <tr>
              <th scope="col" rowSpan={confidenceColumns.length ? 2 : 1}>ID</th>
              {metricColumns.map((column) => <th scope="col" key={column} rowSpan={confidenceColumns.length ? 2 : 1}>{pdesMetricLabel(column)}</th>)}
              {confidenceColumns.length > 0 && <th scope="colgroup" colSpan={confidenceColumns.length}>95% confidence interval</th>}
            </tr>
            {confidenceColumns.length > 0 && <tr>{confidenceColumns.map((column) => <th scope="col" key={column}>{pdesMetricLabel(column)}</th>)}</tr>}
          </thead>
          <tbody>{ids.map((id) => <tr key={id}><th scope="row">{id}</th>{orderedColumns.map((column) => (
            <td key={column} className={column.startsWith("ci95_") ? "pdes-ci-column" : undefined}>
              {formatPdesMetricValue(column, values[id][column])}
            </td>
          ))}</tr>)}</tbody>
        </table>
      </div>}
    </section>
  );
}

function MetricSummary({ metrics }: { metrics: PDESMetrics }) {
  const totals = metrics.totals;
  return <dl className="pdes-total-grid">
    {["sent", "delivered", "dropped", "loss_rate", "mean_delay", "throughput"].map((key) => {
      const value = totals[key];
      return <div key={key}><dt>{pdesMetricLabel(key)}</dt><dd>{formatPdesMetricValue(key, value)}</dd></div>;
    })}
  </dl>;
}

export function PDESReportView({ report, runId }: { report: PDESReport; runId: string }) {
  const breakdown = partitionBreakdown(report.partitions);
  const metrics = report.metrics;

  return (
    <section className="page-content" aria-labelledby="pdes-report-heading">
      <ReportHeader
        id="pdes-report-heading"
        eyebrow="PARTITIONED NETWORK REPORT"
        title="Merged results"
        batchId={report.batch_id}
        coordinator={report.coordinator}
        seed={report.base_seed}
        actions={<>
          <a className="ghost-button" href="#/network"><Network size={15} />Network lab</a>
          <a className="ghost-button" href={`#/live/${encodeURIComponent(runId)}`}><Activity size={15} />Progress</a>
          <CopyJsonButton value={report} />
        </>}
      />
      {report.stale && <Notice kind="warning">Stored snapshot: the coordinator is unavailable.</Notice>}
      {report.state === "failed" && <Notice kind="error"><CircleX size={18} /><span><strong>Run failed{report.failed_node ? ` on ${report.failed_node}` : ""}.</strong> {report.error ?? "The coordinator reported a partition failure."}</span></Notice>}
      {report.results_identical === true && <div className="serial-match serial-ok"><Check size={18} /><span>Serial and partitioned metrics are identical.</span></div>}
      {report.results_identical === false && <Notice kind="error"><TriangleAlert size={18} /><span><strong>Serial and partitioned results differ.</strong> First differing path: <code>{report.first_difference ?? "unknown"}</code></span></Notice>}

      <StatStrip variant="pdes" items={[
        { label: "Partitioned wall time", value: formatDuration(report.partitioned_wall_seconds) },
        { label: "Serial baseline", value: report.baseline_wall_seconds === undefined ? "Not run" : formatDuration(report.baseline_wall_seconds) },
        { label: "Speedup", value: report.speedup === undefined ? "--" : formatSpeedup(report.speedup) },
        { label: "Lookahead / windows", value: <>{report.plan.lookahead.toPrecision(4)} s · {report.plan.windows.toLocaleString()}</> },
      ]} />

      <SectionTitle title="Partition timing breakdown" note={`sum compute / barrier wait: ${breakdown.totalCompute.toFixed(2)} s / ${breakdown.totalWait.toFixed(2)} s`} />
      <PartitionTimingList breakdown={breakdown} messagesDetail />

      <SectionTitle title="Partition map" note={`${report.plan.parts} parts · ${report.plan.cut_links.length} cut links`} />
      <div className="pdes-topology-preview"><TopologyCanvas scenario={report.scenario} mode="partition"
        partitionAssignment={report.plan.assignment} cutLinks={report.plan.cut_links} /></div>
      {report.plan.cut_links.length > 0 && <p className="pdes-plan-note">Cut links: {report.plan.cut_links.join(", ")}</p>}

      {metrics ? <>
        <SectionTitle title="Aggregate network metrics" note={`merged over ${metrics.duration.toLocaleString()} simulated seconds`} />
        <MetricSummary metrics={metrics} />
        <MetricTable title="Flow metrics" values={metrics.flows} />
        <MetricTable title="Link metrics" values={metrics.links} />
        <MetricTable title="Router metrics" values={metrics.routers} />
      </> : <EmptyState icon={<Network size={20} />} title="Metrics are not available"><span>The run failed before the partitions could merge their results.</span></EmptyState>}
    </section>
  );
}
