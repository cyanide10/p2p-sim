import { Check, CircleX, Copy, Crosshair, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { AttackReport } from "../api/types";
import { AttackMap } from "../components/AttackMap";
import { EmptyState, Notice, PageHeading, SectionTitle } from "../components/PagePrimitives";
import {
  ATTACK_SCENARIOS, attackRunFromMetrics, compact, percent,
  type AttackConfig, type AttackSample,
} from "../lib/attack";
import { formatDuration, formatSpeedup } from "../lib/format";
import { partitionBreakdown } from "../lib/pdes";

function configFor(report: AttackReport): AttackConfig {
  const scenario = report.scenario;
  return {
    kind: scenario.kind,
    seed: scenario.seed,
    duration: scenario.duration,
    scale: scenario.scale,
    intensity: scenario.intensity,
    capacity: scenario.capacity,
    defense: scenario.defense,
  };
}

function peakOf(samples: AttackSample[]): AttackSample | null {
  let peak: AttackSample | null = null;
  for (const sample of samples) {
    if (!peak || sample.threat > peak.threat) peak = sample;
  }
  return peak;
}

function impactValue(report: AttackReport): { label: string; value: string } {
  const summary = report.metrics?.summary;
  const scenario = ATTACK_SCENARIOS[report.scenario.kind];
  if (!summary) return { label: scenario.impactLabel, value: "--" };
  if (report.scenario.kind === "exfil") {
    return { label: "Data exfiltrated", value: `${summary.exfiltratedGb.toFixed(1)} GB` };
  }
  return { label: scenario.impactLabel, value: percent(summary.peakImpact, summary.peakImpact < 10 ? 1 : 0) };
}

export function AttackReportView({ report, runId }: { report: AttackReport; runId: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scenario = ATTACK_SCENARIOS[report.scenario.kind];
  const config = configFor(report);
  const run = useMemo(
    () => (report.metrics ? attackRunFromMetrics(config, report.metrics) : null),
    // The report object is immutable for this page instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report],
  );
  const peak = run ? peakOf(run.samples) : null;
  const breakdown = partitionBreakdown(report.partitions);
  const summary = report.metrics?.summary;
  const impact = impactValue(report);
  const parts = new Map<number, string[]>();
  for (const [node, part] of Object.entries(report.plan.assignment)) {
    parts.set(part, [...(parts.get(part) ?? []), node]);
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setCopied("copied"); }
    catch { setCopied("failed"); }
    window.setTimeout(() => setCopied("idle"), 2000);
  };

  return (
    <section className="page-content" aria-labelledby="attack-report-heading">
      <PageHeading
        id="attack-report-heading"
        eyebrow={`THREAT CAMPAIGN REPORT · ${scenario.codename}`}
        title={scenario.label}
        lede={`${report.batch_id} · coordinated by ${report.coordinator} · seed ${report.base_seed}`}
        actions={<>
          <a className="ghost-button" href="#/attack"><Crosshair size={15} />Threat lab</a>
          <a className="ghost-button" href={`#/live/${encodeURIComponent(runId)}`}>Progress</a>
          <button className="ghost-button" type="button" onClick={() => void copy()}>
            <Copy size={15} />{copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy JSON"}
          </button>
        </>}
      />

      {report.stale && <Notice kind="warning">Stored snapshot: the coordinator is unavailable.</Notice>}
      {report.state === "failed" && (
        <Notice kind="error">
          <CircleX size={18} />
          <span><strong>Campaign failed{report.failed_node ? ` on ${report.failed_node}` : ""}.</strong> {report.error ?? "The coordinator reported a partition failure."}</span>
        </Notice>
      )}
      {report.results_identical === true && (
        <div className="serial-match serial-ok"><Check size={18} /><span>Serial and partitioned campaign samples are identical, seed for seed.</span></div>
      )}
      {report.results_identical === false && (
        <Notice kind="error">
          <TriangleAlert size={18} />
          <span><strong>Serial and partitioned campaigns differ.</strong> First differing sample: <code>{report.first_difference ?? "unknown"}</code></span>
        </Notice>
      )}

      <div className="pdes-summary-grid">
        <article><span>Peak threat</span><strong>{summary ? `${summary.peakThreat.toFixed(0)} / 100` : "--"}</strong></article>
        <article><span>Peak load ratio</span><strong>{summary ? `${summary.peakLoadRatio.toFixed(2)}×` : "--"}</strong></article>
        <article><span>{impact.label}</span><strong>{impact.value}</strong></article>
        <article><span>Time above capacity</span><strong>{summary ? formatDuration(summary.timeAboveCapacity) : "--"}</strong></article>
        <article><span>Recovery</span><strong>{summary ? (summary.recoverySeconds === null ? "Not reached" : formatDuration(summary.recoverySeconds)) : "--"}</strong></article>
        <article><span>Mitigation</span><strong>{summary ? percent(summary.blockedPct) : "--"}</strong></article>
      </div>

      <SectionTitle title="Execution" note={report.plan.parts === 1 ? "single worker" : `${report.plan.parts} partitions in lock-step`} />
      <div className="pdes-summary-grid">
        <article><span>Partitioned wall time</span><strong>{formatDuration(report.partitioned_wall_seconds)}</strong></article>
        <article><span>Serial baseline</span><strong>{report.baseline_wall_seconds === undefined ? "Not run" : formatDuration(report.baseline_wall_seconds)}</strong></article>
        <article><span>Speedup</span><strong>{report.speedup === undefined ? "--" : formatSpeedup(report.speedup)}</strong></article>
        <article><span>Lookahead / windows</span><strong>{report.plan.lookahead.toPrecision(4)} s · {report.plan.windows.toLocaleString()}</strong></article>
        <article><span>Campaign scale</span><strong>{compact(report.scenario.scale, 1)}</strong></article>
        <article><span>Defensive posture</span><strong>{report.scenario.defense}%</strong></article>
      </div>

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
        {!breakdown.rows.length && <p className="muted">Partition timing will appear after the first coordination window.</p>}
      </div>

      <SectionTitle title="Topology placement" note={`${report.scenario.nodes.length} tokens · ${report.plan.cut_links.length} cut links`} />
      <div className="attack-report-parts">
        {[...parts.entries()].sort(([a], [b]) => a - b).map(([part, nodes]) => (
          <div key={part}>
            <strong>Part {part}</strong>
            <span>{nodes.length} tokens</span>
            <p>{nodes.join(" · ")}</p>
          </div>
        ))}
      </div>

      {run && peak && (
        <>
          <SectionTitle title="Peak campaign snapshot" note={`t+${peak.t.toFixed(1)}s · ${peak.phase} · threat ${peak.threat.toFixed(0)}`} />
          <div className="attack-report-map">
            <AttackMap run={run} sample={peak} clock={peak.t} selectedId={selectedId} onSelect={setSelectedId} />
          </div>
        </>
      )}

      {report.metrics ? (
        <p className="pdes-plan-note">
          Merged {report.metrics.samples.length.toLocaleString()} campaign samples over {formatDuration(report.metrics.duration)}.
        </p>
      ) : (
        <EmptyState icon={<Crosshair size={20} />} title="Metrics are not available"><span>The run failed before the partitions could merge their samples.</span></EmptyState>
      )}
    </section>
  );
}
