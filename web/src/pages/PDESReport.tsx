import { Activity, Check, CircleX, Network, TriangleAlert } from "lucide-react";
import type { ApiClient } from "../api/client";
import type { PDESReport } from "../api/types";
import { CopyJsonButton } from "../components/CopyJsonButton";
import { NetworkPlayer } from "../components/NetworkPlayer";
import { EmptyState, Notice, PanelTitle, SectionTitle, StatStrip } from "../components/PagePrimitives";
import { PartitionMap } from "../components/PartitionMap";
import { PartitionTimingList } from "../components/PartitionTiming";
import { ReportHeader } from "../components/ReportHeader";
import { formatDuration, formatSpeedup } from "../lib/format";
import { flowSlot } from "../lib/network";
import { metricsLoad, partitionBreakdown, singleBand } from "../lib/pdes";
import { BandChart } from "./NetworkReport";

/** A single merged value, scaled and rounded, or a dash when the run produced none. */
const val = (value: number | null | undefined, scale = 1, digits = 2) =>
  value === null || value === undefined ? "--" : (value * scale).toFixed(digits);

export function PDESReportView({ report, runId, api }: { report: PDESReport; runId: string; api: ApiClient }) {
  const breakdown = partitionBreakdown(report.partitions);
  const metrics = report.metrics;
  const sc = report.scenario;
  const crossed = Object.values(report.cut_traffic ?? {}).reduce((sum, count) => sum + count, 0);
  const links = metrics ? [...sc.links].sort((a, b) => (metrics.links[b.id]?.utilization ?? 0) - (metrics.links[a.id]?.utilization ?? 0)) : [];
  const nodes = report.participants?.length ?? report.plan.parts;

  return (
    <section className="page-content" aria-labelledby="pdes-report-heading">
      <ReportHeader
        id="pdes-report-heading"
        eyebrow="PARTITIONED NETWORK REPORT"
        title="One copy, split across nodes"
        ledePrefix={`${nodes} nodes each simulated one region of the network · `}
        batchId={report.batch_id}
        coordinator={report.coordinator}
        seed={report.base_seed}
        actions={<>
          <a className="ghost-button" href="#/network"><Network size={15} />Network lab</a>
          <a className="ghost-button" href={`#/live/${encodeURIComponent(runId)}`}><Activity size={15} />Progress</a>
          <CopyJsonButton value={report} label="Copy as JSON" />
        </>}
      />
      {report.stale && <Notice kind="warning">Stored snapshot: the coordinator is unavailable.</Notice>}
      {report.state === "failed" && <Notice kind="error"><CircleX size={18} /><span><strong>Run failed{report.failed_node ? ` on ${report.failed_node}` : ""}.</strong> {report.error ?? "The coordinator reported a partition failure."}</span></Notice>}
      {report.results_identical === true && <div className="serial-match serial-ok"><Check size={18} /><span>Identical to running the whole network on one node: the split changed nothing but the time it took.</span></div>}
      {report.results_identical === false && <Notice kind="error"><TriangleAlert size={18} /><span><strong>The split results differ from the one-node run.</strong> First differing value: <code>{report.first_difference ?? "unknown"}</code></span></Notice>}

      <StatStrip variant="pdes" items={[
        { label: `Split over ${nodes} nodes`, value: formatDuration(report.partitioned_wall_seconds) },
        { label: "On one node", value: report.baseline_wall_seconds === undefined ? "Not run" : formatDuration(report.baseline_wall_seconds) },
        { label: "Speedup", value: report.speedup === undefined ? "--" : formatSpeedup(report.speedup) },
        { label: "Sync windows", value: <>{report.plan.windows.toLocaleString()} <small>of {(report.plan.lookahead * 1000).toPrecision(3)} ms</small></> },
      ]} />
      {report.speedup !== undefined && report.speedup < 1 && <Notice kind="info">
        Splitting was slower here: the nodes synchronized {report.plan.windows.toLocaleString()} times, and each window held little work.
        Split runs pay off on large networks whose regions are joined by slow links (try the Three-site WAN sample).
      </Notice>}

      <SectionTitle title="Who simulated what" note={crossed ? `${crossed.toLocaleString()} packets crossed between nodes` : "average load over the run"} />
      <PartitionMap scenario={sc} plan={report.plan} participants={report.participants}
        load={metrics ? metricsLoad(metrics) : undefined} cutTraffic={report.cut_traffic} />

      <SectionTitle title="Watch the traffic" note="replays this run's seed on one node · same seed, same packets" />
      <NetworkPlayer api={api} scenario={sc} copies={[{ label: `Seed ${report.base_seed}`, seed: report.base_seed }]} />

      {metrics ? <>
        <SectionTitle className="net-results-title" title="Results" note={`one run · ${metrics.duration.toLocaleString()} simulated seconds`} />
        <StatStrip variant="tiles" items={[
          { label: "Delivered", value: val(metrics.totals.throughput, 1, 1), small: " pkt/s" },
          { label: "Mean delay", value: val(metrics.totals.mean_delay, 1000, 0), small: " ms" },
          { label: "Packet loss", value: val(metrics.totals.loss_rate, 100, 2), small: "%" },
          { label: "Packets sent", value: (metrics.totals.sent ?? 0).toLocaleString() },
          { label: "Dropped", value: (metrics.totals.dropped ?? 0).toLocaleString() },
        ]} />

        <div className="traffic-charts">
          <div className="panel">
            <PanelTitle title="Traffic over time" note="packets/s" />
            <BandChart label="Delivered and dropped packets per second over simulated time" unit="pkt/s" binWidth={metrics.series.bin_width} duration={sc.duration} events={sc.events}
              legend={<ul className="chart-legend"><li><i className="legend-swatch" style={{ background: "var(--flow-0)" }} />Delivered</li><li><i className="legend-swatch" style={{ background: "var(--flow-1)" }} />Dropped</li><li><i className="legend-ref legend-event" />Failure / recovery</li></ul>}
              series={[{ name: "Delivered", color: "var(--flow-0)", band: singleBand(metrics.series.delivered_rate) }, { name: "Dropped", color: "var(--flow-1)", band: singleBand(metrics.series.dropped_rate) }]} />
          </div>
          <div className="panel">
            <PanelTitle title="Delay over time" note="ms, packets delivered in each interval" />
            <BandChart label="Mean packet delay over simulated time" unit="ms" scale={1000} binWidth={metrics.series.bin_width} duration={sc.duration} events={sc.events}
              series={[{ name: "Mean delay", color: "var(--flow-0)", band: singleBand(metrics.series.mean_delay) }]} />
          </div>
        </div>

        <SectionTitle title="Flows" note={sc.flows.length} />
        <div className="matrix-frame table-scroll">
          <table className="data-table net-report-table">
            <thead><tr><th scope="col">Flow</th><th scope="col">Route</th><th scope="col">Delivered (pkt/s)</th><th scope="col">Mean delay (ms)</th><th scope="col">p95 delay (ms)</th><th scope="col">Loss (%)</th></tr></thead>
            <tbody>{sc.flows.map((f, i) => {
              const m = metrics.flows[f.id] ?? {};
              return <tr key={f.id}><th scope="row"><i className="flow-swatch" style={{ background: flowSlot(i) }} />{f.id}</th><td>{f.src} → {f.dst}</td>
                <td>{val(m.throughput)}</td><td>{val(m.mean_delay, 1000, 1)}</td><td>{val(m.p95_delay, 1000, 1)}</td><td>{val(m.loss_rate, 100, 2)}</td></tr>;
            })}</tbody>
          </table>
        </div>

        <details className="pdes-detail-tables">
          <summary>Every link and router ({sc.links.length} links, {Object.keys(metrics.routers).length} routers)</summary>
          <div className="report-columns">
            <div>
              <SectionTitle title="Links" note="busiest first · dashed on the map = between nodes" />
              <div className="matrix-frame table-scroll">
                <table className="data-table net-report-table">
                  <thead><tr><th scope="col">Link</th><th scope="col">Load (%)</th><th scope="col">Drops</th><th scope="col">Avg queue</th><th scope="col">Crossed nodes</th></tr></thead>
                  <tbody>{links.map((l) => {
                    const m = metrics.links[l.id] ?? {};
                    return <tr key={l.id}><th scope="row">{l.id}<small> {l.a}–{l.b}</small></th><td>{val(m.utilization, 100, 1)}</td><td>{m.drops ?? "--"}</td><td>{val(m.mean_queue)}</td>
                      <td>{report.cut_traffic?.[l.id] ? report.cut_traffic[l.id].toLocaleString() : ""}</td></tr>;
                  })}</tbody>
                </table>
              </div>
            </div>
            <div>
              <SectionTitle title="Routers" />
              <div className="matrix-frame table-scroll">
                <table className="data-table net-report-table">
                  <thead><tr><th scope="col">Router</th><th scope="col">Node</th><th scope="col">Load (%)</th><th scope="col">Drops</th><th scope="col">Avg queue</th></tr></thead>
                  <tbody>{Object.entries(metrics.routers).map(([id, m]) => {
                    const part = report.plan.assignment[id];
                    return <tr key={id}><th scope="row">{id}</th><td>{report.participants?.[part] ?? (part === undefined ? "--" : `partition ${part + 1}`)}</td>
                      <td>{val(m.utilization, 100, 1)}</td><td>{m.drops ?? "--"}</td><td>{val(m.mean_queue)}</td></tr>;
                  })}</tbody>
                </table>
              </div>
            </div>
          </div>
        </details>
      </> : <EmptyState icon={<Network size={20} />} title="Metrics are not available"><span>The run failed before the partitions could merge their results.</span></EmptyState>}

      <SectionTitle title="Where the time went" note={`computing ${breakdown.totalCompute.toFixed(2)} s · waiting for other nodes ${breakdown.totalWait.toFixed(2)} s`} />
      <PartitionTimingList breakdown={breakdown} messagesDetail />
    </section>
  );
}
