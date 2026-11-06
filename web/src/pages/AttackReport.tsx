import { Check, CircleX, Crosshair, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { AttackReport } from "../api/types";
import { AttackMap } from "../components/AttackMap";
import { CopyJsonButton } from "../components/CopyJsonButton";
import { EmptyState, Notice, PageHeading, SectionTitle, StatStrip } from "../components/PagePrimitives";
import { PartitionTimingList } from "../components/PartitionTiming";
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
          <CopyJsonButton value={report} />
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

      <StatStrip variant="pdes" items={[
        { label: "Peak threat", value: summary ? `${summary.peakThreat.toFixed(0)} / 100` : "--" },
        { label: "Peak load ratio", value: summary ? `${summary.peakLoadRatio.toFixed(2)}×` : "--" },
        { label: impact.label, value: impact.value },
        { label: "Time above capacity", value: summary ? formatDuration(summary.timeAboveCapacity) : "--" },
        { label: "Recovery", value: summary ? (summary.recoverySeconds === null ? "Not reached" : formatDuration(summary.recoverySeconds)) : "--" },
        { label: "Mitigation", value: summary ? percent(summary.blockedPct) : "--" },
      ]} />

      <SectionTitle title="Execution" note={report.plan.parts === 1 ? "single worker" : `${report.plan.parts} partitions in lock-step`} />
      <StatStrip variant="pdes" items={[
        { label: "Partitioned wall time", value: formatDuration(report.partitioned_wall_seconds) },
        { label: "Serial baseline", value: report.baseline_wall_seconds === undefined ? "Not run" : formatDuration(report.baseline_wall_seconds) },
        { label: "Speedup", value: report.speedup === undefined ? "--" : formatSpeedup(report.speedup) },
        { label: "Lookahead / windows", value: <>{report.plan.lookahead.toPrecision(4)} s · {report.plan.windows.toLocaleString()}</> },
        { label: "Campaign scale", value: compact(report.scenario.scale, 1) },
        { label: "Defensive posture", value: <>{report.scenario.defense}%</> },
      ]} />

      <SectionTitle title="Partition timing breakdown" note={`sum compute / barrier wait: ${breakdown.totalCompute.toFixed(2)} s / ${breakdown.totalWait.toFixed(2)} s`} />
      <PartitionTimingList breakdown={breakdown} messagesDetail />

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
