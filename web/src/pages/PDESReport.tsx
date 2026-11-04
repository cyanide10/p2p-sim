import { Activity, Check, CircleX, Copy, Network, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { PDESMetrics, PDESReport } from "../api/types";
import { TopologyCanvas } from "../components/TopologyCanvas";
import { EmptyState, Notice, PageHeading, SectionTitle, StatStrip } from "../components/PagePrimitives";
import { formatDuration, formatSpeedup } from "../lib/format";
import { partitionBreakdown } from "../lib/pdes";

function MetricTable({ title, values }: { title: string; values: Record<string, Record<string, number | null>> }) {
  const ids = Object.keys(values);
  const columns = [...new Set(Object.values(values).flatMap((row) => Object.keys(row)))];
  return (
    <section className="pdes-metric-section">
      <SectionTitle title={title} note={`${ids.length} items`} />
      {!ids.length ? <p className="muted">No merged values.</p> : <div className="table-scroll">
        <table className="net-table pdes-metric-table"><thead><tr><th scope="col">ID</th>{columns.map((column) => <th scope="col" key={column}>{column.replaceAll("_", " ")}</th>)}</tr></thead>
          <tbody>{ids.map((id) => <tr key={id}><th scope="row">{id}</th>{columns.map((column) => {
            const value = values[id][column];
            return <td key={column}>{value === null || value === undefined ? "--" : Number.isInteger(value) ? value.toLocaleString() : value.toPrecision(5)}</td>;
          })}</tr>)}</tbody>
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
      return <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{value === null || value === undefined ? "--" : key.endsWith("_rate") ? `${(value * 100).toFixed(2)}%` : Number.isInteger(value) ? value.toLocaleString() : value.toPrecision(5)}</dd></div>;
    })}
  </dl>;
}

export function PDESReportView({ report, runId }: { report: PDESReport; runId: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const breakdown = partitionBreakdown(report.partitions);
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setCopied("copied"); }
    catch { setCopied("failed"); }
    window.setTimeout(() => setCopied("idle"), 2000);
  };
  const metrics = report.metrics;

  return (
    <section className="page-content" aria-labelledby="pdes-report-heading">
      <PageHeading
        id="pdes-report-heading"
        eyebrow="PARTITIONED NETWORK REPORT"
        title="Merged results"
        lede={`${report.batch_id} · coordinated by ${report.coordinator} · seed ${report.base_seed}`}
        actions={<>
          <a className="ghost-button" href="#/network"><Network size={15} />Network lab</a>
          <a className="ghost-button" href={`#/live/${encodeURIComponent(runId)}`}><Activity size={15} />Progress</a>
          <button className="ghost-button" type="button" onClick={() => void copy()}><Copy size={15} />{copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy JSON"}</button>
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
      <div className="partition-timing-list">
        {breakdown.rows.map((row, index) => {
          const scale = breakdown.maxTotal || 1;
          return <div className="partition-timing-row" key={row.id}>
            <strong>{row.id}</strong>
            <div className="partition-time-track" aria-label={`${row.id}: ${row.compute.toFixed(3)} seconds compute, ${row.wait.toFixed(3)} seconds wait`}>
              <span className={`partition-time-compute peer-${index % 6}`} style={{ width: `${(row.compute / scale) * 100}%` }} />
              <span className="partition-time-wait" style={{ width: `${(row.wait / scale) * 100}%` }} />
            </div>
            <span>{row.compute.toFixed(2)}s / {row.wait.toFixed(2)}s · {row.messages.toLocaleString()} msgs · {(row.bytes / 1024).toFixed(1)} KiB</span>
          </div>;
        })}
      </div>

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
