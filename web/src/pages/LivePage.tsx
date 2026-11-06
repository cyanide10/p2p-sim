import { ArrowRight, RotateCcw, Unplug, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient, type ApiClient } from "../api/client";
import type { AttackReport, AttackStatus, GatewayConfig, MockScenario, PDESReport, PDESStatus, RunRecord, RunState, RunStatus } from "../api/types";
import { isAttackScenario, isNetworkScenario } from "../api/types";
import { NetworkPlayer } from "../components/NetworkPlayer";
import { PartitionTimingList } from "../components/PartitionTiming";
import { ProgressBar, StateBadge, TaskGrid } from "../components/RunBits";
import { EmptyState, LoadingState, Notice, PageHeading, SectionTitle, StatStrip } from "../components/PagePrimitives";
import { formatDuration } from "../lib/format";
import { partitionBreakdown } from "../lib/pdes";
import { TopologyCanvas } from "../components/TopologyCanvas";

const POLL_MS = 500;

/** The copies of a run that the player can replay: seed = base_seed + index. */
export function copyList(baseSeed: number, replications: number) {
  return Array.from({ length: Math.min(replications, 100) }, (_, i) => ({ label: `Copy ${i + 1} (seed ${baseSeed + i})`, seed: baseSeed + i }));
}
const MAX_BACKOFF_MS = 8000;

export function LivePage({ runId, scenario, mockEnabled }: { runId: string; scenario: MockScenario; mockEnabled: boolean }) {
  const api = useMemo(() => createApiClient(scenario), [scenario]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [state, setState] = useState<RunState>("running");
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let failures = 0;
    setRecord(null);
    setStatus(null);
    setLoadError(null);
    setPollError(null);

    const failLoad = (cause: unknown) => {
      if (!active) return;
      setLoadError({
        message: cause instanceof Error ? cause.message : "Unable to load this run.",
        notFound: cause instanceof ApiError && cause.status === 404,
      });
    };

    // The gateway record carries the authoritative run state (e.g. coordinator_lost).
    const refreshRecord = async () => {
      const next = await api.getRun(runId);
      if (active) {
        setRecord(next);
        setState(next.state);
      }
      return next;
    };

    const tick = async () => {
      try {
        const next = await api.getStatus(runId);
        if (!active) return;
        failures = 0;
        setPollError(null);
        setStatus(next);
        if (next.state === "complete" || next.state === "failed") {
          setState(next.state);
          return;
        }
        if (next.stale) {
          const current = await refreshRecord();
          if (current.state !== "running") return;
        }
        timer = window.setTimeout(tick, POLL_MS);
      } catch (cause) {
        if (!active) return;
        failures += 1;
        setPollError(cause instanceof Error ? cause.message : "Status request failed.");
        try {
          const current = await refreshRecord();
          if (current.state !== "running") return;
        } catch (recordCause) {
          if (recordCause instanceof ApiError && recordCause.status === 404) {
            failLoad(recordCause);
            return;
          }
        }
        if (active) timer = window.setTimeout(tick, Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS));
      }
    };

    Promise.all([api.getRun(runId), api.getConfig().catch(() => null)])
      .then(([initial, nextConfig]) => {
        if (!active) return;
        setRecord(initial);
        setState(initial.state);
        setStatus(initial.status);
        setConfig(nextConfig);
        if (initial.state === "running") void tick();
      })
      .catch(failLoad);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, runId]);

  if (loadError) {
    return (
      <section className="page-content">
        <EmptyState icon={<WifiOff size={22} />} title={loadError.notFound ? "Run not found" : "Unable to load run"}>
          <span>{loadError.notFound ? "The gateway has no record of this run." : loadError.message}</span>
          <a href="#/launch">Launch a new run</a>
        </EmptyState>
      </section>
    );
  }
  if (!record) {
    return <section className="page-content"><LoadingState>Loading run</LoadingState></section>;
  }
  if (record.params.kind === "pdes" || record.params.kind === "attack") {
    return <SpecializedLiveView kind={record.params.kind} api={api} runId={runId} record={record} status={status} state={state} />;
  }

  const legacyStatus = status && !("kind" in status) ? status : null;
  const total = legacyStatus?.replications ?? record.params.replications;
  const counts = legacyStatus ?? { pending: total, assigned: 0, complete: 0, failed: 0, failed_attempts: 0 };
  const peers = config?.peers.map((peer) => peer.id) ?? [];
  const phaseLabel = legacyStatus?.phase === "serial_baseline"
    ? "Serial baseline on coordinator"
    : legacyStatus?.phase === "complete"
      ? "Finished"
      : "Distributed replications";

  return (
    <section className="page-content" aria-labelledby="live-heading">
      <PageHeading
        id="live-heading"
        eyebrow="LIVE BATCH"
        title="Batch progress"
        lede={<>{phaseLabel}{state === "running" ? " · updating every 0.5 s" : ""}</>}
        actions={<StateBadge state={state} />}
        actionsLive="polite"
      />
      <StatStrip variant="meta" items={[
        { label: "Coordinator", value: record.coordinator },
        { label: "Base seed", value: record.params.base_seed },
        { label: "Elapsed", value: formatDuration(legacyStatus?.elapsed_seconds) },
        record.params.kind === "network"
          ? { label: "Network", value: isNetworkScenario(record.params.scenario) ? `${record.params.scenario.nodes.length} nodes · ${record.params.scenario.flows.length} flows` : "scenario" }
          : { label: "λ / μ", value: <>{record.params.lambda} / {record.params.mu}</> },
        { label: "Batch ID", value: record.batch_id, wide: true },
      ]} />

      {state === "coordinator_lost" && (
        <div className="lost-banner" role="alert">
          <Unplug size={20} />
          <div>
            <strong>The coordinator {record.coordinator} stopped responding</strong>
            <p>Batch state lives only on the coordinating node, so this batch cannot finish. Seeds fully determine results: resubmitting with the same base seed on another node reproduces it exactly.</p>
            <a className="banner-action" href={`#/launch?resubmit=${encodeURIComponent(runId)}`}><RotateCcw size={15} />Resubmit on another node with the same base seed</a>
          </div>
        </div>
      )}
      {state === "complete" && (
        <div className="complete-banner" role="status">
          <span><strong>Batch complete.</strong> {record.params.kind === "network" ? "The network results are ready." : "The final report is ready."}</span>
          <a className="banner-action" href={`#/report/${encodeURIComponent(runId)}`}>View report<ArrowRight size={15} /></a>
        </div>
      )}
      {state === "failed" || state === "unknown" ? (
        <Notice kind="error">The gateway could not determine how this batch ended.</Notice>
      ) : null}
      {pollError && state === "running" && (
        <Notice kind="warning">Status unavailable: {pollError} Retrying with backoff.</Notice>
      )}
      {legacyStatus?.stale && state !== "coordinator_lost" && (
        <Notice kind="warning">Showing the last stored snapshot; the coordinator did not answer.</Notice>
      )}

      <div className="panel">
        <ProgressBar counts={counts} total={total} label="Distributed replications" />
        <dl className="count-grid">
          <div><dt>Complete</dt><dd>{counts.complete.toLocaleString()}</dd></div>
          <div><dt>In flight</dt><dd>{counts.assigned.toLocaleString()}</dd></div>
          <div><dt>Pending</dt><dd>{counts.pending.toLocaleString()}</dd></div>
          <div className={counts.failed > 0 ? "count-bad" : ""}><dt>Failed</dt><dd>{counts.failed.toLocaleString()}</dd></div>
          <div className={counts.failed_attempts > 0 ? "count-warn" : ""}><dt>Failed attempts (retried)</dt><dd>{counts.failed_attempts.toLocaleString()}</dd></div>
        </dl>
        {legacyStatus?.serial_baseline && (
          <ProgressBar counts={legacyStatus.serial_baseline} total={total} label={`Serial baseline on ${record.coordinator}`} />
        )}
      </div>

      {isNetworkScenario(record.params.scenario) ? (
        <>
          <SectionTitle title="Watch the traffic" note="while the copies compute, play any of them here" />
          <NetworkPlayer api={api} scenario={record.params.scenario} copies={copyList(record.params.base_seed, record.params.replications)} />
        </>
      ) : Boolean(config?.features?.task_grid) ? (
        <>
          <SectionTitle title="Replications" note={`${total.toLocaleString()} tasks`} />
          <TaskGrid tasks={legacyStatus?.tasks} enabled={true} peers={peers} mock={mockEnabled} />
        </>
      ) : null}
    </section>
  );
}

/**
 * Shared live view for partitioned runs. PDES network runs and attack campaigns
 * report the same window/partition shape, so they differ only in their labels,
 * rerun endpoint and the PDES-only topology preview.
 */
function SpecializedLiveView({ kind, api, runId, record, status, state }: {
  kind: "pdes" | "attack";
  api: ApiClient;
  runId: string;
  record: RunRecord;
  status: RunStatus | null;
  state: RunState;
}) {
  const [report, setReport] = useState<PDESReport | AttackReport | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const partitionedStatus: PDESStatus | AttackStatus | null =
    status && "kind" in status && status.kind === kind ? status as PDESStatus | AttackStatus : null;
  const timing = partitionBreakdown(partitionedStatus?.partitions ?? report?.partitions ?? {});
  const networkScenario = isNetworkScenario(record.params.scenario) ? record.params.scenario : undefined;
  const attackScenario = isAttackScenario(record.params.scenario) ? record.params.scenario : undefined;
  const duration = kind === "pdes" ? networkScenario?.duration ?? 0 : attackScenario?.duration ?? 0;
  const canRerun = kind === "pdes" ? Boolean(networkScenario) : Boolean(attackScenario);

  useEffect(() => {
    let active = true;
    api.getReport(runId).then((next) => {
      if (!active || !("kind" in next) || next.kind !== kind) return;
      if (next.kind === "pdes" || next.kind === "attack") setReport(next);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, runId, kind]);

  const rerun = async () => {
    setRerunning(true);
    setRerunError(null);
    try {
      const cluster = await api.getCluster();
      const excludedNode = partitionedStatus?.failed_node ?? (state === "coordinator_lost" ? record.coordinator : undefined);
      const survivors = cluster.nodes.filter((node) => node.healthy && node.id !== excludedNode);
      if (kind === "pdes") {
        if (!networkScenario) return;
        const routerCount = networkScenario.nodes.filter((node) => node.kind === "router").length;
        const parts = Math.min(survivors.length, routerCount);
        if (parts < 1 || survivors.length < 1) throw new Error("No surviving nodes are available to rerun this scenario.");
        const created = await api.createPDESRun(
          survivors[0].id, networkScenario, parts, record.params.base_seed, record.params.baseline ?? true,
        );
        window.location.hash = `#/live/${encodeURIComponent(created.run_id)}`;
      } else {
        if (!attackScenario) return;
        const parts = Math.min(survivors.length, attackScenario.nodes.length);
        if (parts < 1 || survivors.length < 1) throw new Error("No surviving nodes are available to rerun this campaign.");
        const created = await api.createAttackRun(
          survivors[0].id, attackScenario, parts, record.params.base_seed, record.params.baseline ?? true,
        );
        window.location.hash = `#/live/${encodeURIComponent(created.run_id)}`;
      }
    } catch (cause) {
      const fallback = kind === "pdes" ? "Could not rerun on surviving nodes." : "Could not rerun the campaign on surviving nodes.";
      setRerunError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setRerunning(false);
    }
  };

  const windowsLabel = kind === "pdes" ? "Simulation windows" : "Campaign windows";
  return (
    <section className="page-content" aria-labelledby="live-heading">
      <PageHeading
        id="live-heading"
        eyebrow={kind === "pdes" ? "PARTITIONED RUN" : "PARTITIONED THREAT CAMPAIGN"}
        title={kind === "pdes" ? "PDES progress" : "Campaign progress"}
        lede={<>{partitionedStatus?.phase ?? "Waiting for status"} · seed {record.params.base_seed}</>}
        actions={<StateBadge state={state} />}
      />
      <StatStrip variant="meta" items={[
        { label: "Coordinator", value: record.coordinator },
        { label: "Partitions", value: record.params.parts ?? report?.plan.parts ?? "--" },
        { label: "Simulated time", value: partitionedStatus ? `${partitionedStatus.simulated_time.toFixed(2)} / ${duration} s` : "--" },
        { label: "Batch ID", value: record.batch_id, wide: true },
      ]} />
      <div className="panel">
        <ProgressBar
          done={partitionedStatus?.windows_done ?? 0}
          total={partitionedStatus?.windows_total ?? 0}
          label={windowsLabel}
          percentageDigits={1}
        />
      </div>
      {partitionedStatus?.stale && <Notice kind="warning">Showing the last stored partition snapshot; the coordinator is unavailable.</Notice>}
      {state === "failed" && <Notice kind="error">
        <strong>{kind === "pdes" ? "Partitioned run failed" : "Campaign failed"}{partitionedStatus?.failed_node ? ` on ${partitionedStatus.failed_node}` : ""}.</strong> {partitionedStatus?.error ?? report?.error ?? "The coordinator reported a worker failure."}
        {canRerun && <button className="ghost-button" type="button" disabled={rerunning} onClick={() => void rerun()}>{rerunning ? "Rerunning…" : "Rerun on surviving nodes"}</button>}
        <a className="banner-action" href={`#/report/${encodeURIComponent(runId)}`}>View failure report<ArrowRight size={15} /></a>
      </Notice>}
      {state === "coordinator_lost" && <div className="lost-banner" role="alert">
        <Unplug size={20} /><div><strong>The coordinator {record.coordinator} stopped responding</strong>
          <p>{kind === "pdes"
            ? "The partition state was volatile; restart the same scenario and base seed on the surviving nodes."
            : "The campaign state was volatile; restart the same campaign and base seed on the surviving nodes."}</p>
          {canRerun && <button className="ghost-button" type="button" disabled={rerunning} onClick={() => void rerun()}>{rerunning ? "Rerunning…" : "Rerun on surviving nodes"}</button>}
        </div>
      </div>}
      {rerunError && <Notice kind="error">{rerunError}</Notice>}
      {state === "complete" && <div className="complete-banner" role="status">
        <span><strong>{kind === "pdes" ? "Partitioned run complete." : "Campaign complete."}</strong> {kind === "pdes" ? "Merged metrics are ready." : "Merged campaign samples are ready."}</span>
        <a className="banner-action" href={`#/report/${encodeURIComponent(runId)}`}>View report<ArrowRight size={15} /></a></div>}
      <SectionTitle title="Per-partition timing" note="compute versus barrier wait" />
      <PartitionTimingList breakdown={timing} legend />
      {kind === "pdes" && networkScenario && report?.plan && <div className="pdes-topology-preview">
        <SectionTitle title="Partition map" note="cut links connect different owners" />
        <TopologyCanvas scenario={networkScenario} mode="partition" partitionAssignment={report.plan.assignment} cutLinks={report.plan.cut_links} />
      </div>}
    </section>
  );
}
