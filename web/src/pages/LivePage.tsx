import { ArrowRight, RotateCcw, Unplug, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient, type ApiClient } from "../api/client";
import type { GatewayConfig, MockScenario, NodeStatus, PDESReport, PDESStatus, RunRecord, RunState, RunStatus } from "../api/types";
import { NetworkPlayer } from "../components/NetworkPlayer";
import { ProgressBar, StateBadge, TaskGrid } from "../components/RunBits";
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
        <div className="empty-state">
          <WifiOff size={22} />
          <strong>{loadError.notFound ? "Run not found" : "Unable to load run"}</strong>
          <span>{loadError.notFound ? "The gateway has no record of this run." : loadError.message}</span>
          <a href="#/launch">Launch a new run</a>
        </div>
      </section>
    );
  }
  if (!record) {
    return <section className="page-content"><div className="loading-state" role="status"><span className="spinner" />Loading run</div></section>;
  }
  if (record.params.kind === "pdes") {
    return <PDESLiveView api={api} runId={runId} record={record} status={status} state={state} />;
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
      <div className="page-heading">
        <div>
          <p className="eyebrow">LIVE BATCH</p>
          <h1 id="live-heading">Batch progress</h1>
          <p className="lede">{phaseLabel}{state === "running" ? " · updating every 0.5 s" : ""}</p>
        </div>
        <div className="heading-actions" aria-live="polite"><StateBadge state={state} /></div>
      </div>

      <dl className="meta-strip">
        <div><dt>Coordinator</dt><dd>{record.coordinator}</dd></div>
        <div><dt>Base seed</dt><dd>{record.params.base_seed}</dd></div>
        <div><dt>Elapsed</dt><dd>{formatDuration(legacyStatus?.elapsed_seconds)}</dd></div>
        {record.params.kind === "network"
          ? <div><dt>Network</dt><dd>{record.params.scenario ? `${record.params.scenario.nodes.length} nodes · ${record.params.scenario.flows.length} flows` : "scenario"}</dd></div>
          : <div><dt>λ / μ</dt><dd>{record.params.lambda} / {record.params.mu}</dd></div>}
        <div className="meta-wide"><dt>Batch ID</dt><dd>{record.batch_id}</dd></div>
      </dl>

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
      {(state === "failed" || state === "unknown") && (
        <div className="notice notice-error" role="alert">The gateway could not determine how this batch ended.</div>
      )}
      {pollError && state === "running" && (
        <div className="notice notice-warning" role="status">Status unavailable: {pollError} Retrying with backoff.</div>
      )}
      {legacyStatus?.stale && state !== "coordinator_lost" && (
        <div className="notice notice-warning" role="status">Showing the last stored snapshot; the coordinator did not answer.</div>
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

      {record.params.kind === "network" && record.params.scenario ? (
        <>
          <div className="section-title"><h2>Watch the traffic</h2><span>while the copies compute, play any of them here</span></div>
          <NetworkPlayer api={api} scenario={record.params.scenario} copies={copyList(record.params.base_seed, record.params.replications)} />
        </>
      ) : (
        <>
      <div className="section-title"><h2>Replications</h2><span>{total.toLocaleString()} tasks</span></div>
      <TaskGrid tasks={legacyStatus?.tasks} enabled={Boolean(config?.features?.task_grid)} peers={peers} mock={mockEnabled} />
        </>
      )}
    </section>
  );
}

function PDESLiveView({ api, runId, record, status, state }: {
  api: ApiClient;
  runId: string;
  record: RunRecord;
  status: NodeStatus | PDESStatus | null;
  state: RunState;
}) {
  const [report, setReport] = useState<PDESReport | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const pdesStatus = status && "kind" in status && status.kind === "pdes" ? status : null;
  const timing = partitionBreakdown(pdesStatus?.partitions ?? report?.partitions ?? {});
  const scenario = record.params.scenario;

  useEffect(() => {
    let active = true;
    api.getReport(runId).then((next) => {
      if (active && "kind" in next && next.kind === "pdes") setReport(next);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, runId]);

  const rerun = async () => {
    if (!scenario) return;
    setRerunning(true);
    setRerunError(null);
    try {
      const cluster = await api.getCluster();
      const excludedNode = pdesStatus?.failed_node ?? (state === "coordinator_lost" ? record.coordinator : undefined);
      const survivors = cluster.nodes.filter((node) => node.healthy && node.id !== excludedNode);
      const routerCount = scenario.nodes.filter((node) => node.kind === "router").length;
      const parts = Math.min(survivors.length, routerCount);
      if (parts < 1 || survivors.length < 1) throw new Error("No surviving nodes are available to rerun this scenario.");
      const created = await api.createPDESRun(
        survivors[0].id, scenario, parts, record.params.base_seed, record.params.baseline ?? true,
      );
      window.location.hash = `#/live/${encodeURIComponent(created.run_id)}`;
    } catch (cause) {
      setRerunError(cause instanceof Error ? cause.message : "Could not rerun on surviving nodes.");
    } finally {
      setRerunning(false);
    }
  };

  const progress = pdesStatus && pdesStatus.windows_total > 0
    ? Math.min(100, (pdesStatus.windows_done / pdesStatus.windows_total) * 100)
    : 0;
  return (
    <section className="page-content" aria-labelledby="live-heading">
      <div className="page-heading">
        <div><p className="eyebrow">PARTITIONED RUN</p><h1 id="live-heading">PDES progress</h1>
          <p className="lede">{pdesStatus?.phase ?? "Waiting for status"} · seed {record.params.base_seed}</p></div>
        <div className="heading-actions"><StateBadge state={state} /></div>
      </div>
      <dl className="meta-strip">
        <div><dt>Coordinator</dt><dd>{record.coordinator}</dd></div>
        <div><dt>Partitions</dt><dd>{record.params.parts ?? report?.plan.parts ?? "--"}</dd></div>
        <div><dt>Simulated time</dt><dd>{pdesStatus ? `${pdesStatus.simulated_time.toFixed(2)} / ${scenario?.duration ?? 0} s` : "--"}</dd></div>
        <div><dt>Windows</dt><dd>{pdesStatus ? `${pdesStatus.windows_done.toLocaleString()} / ${pdesStatus.windows_total.toLocaleString()}` : "--"}</dd></div>
        <div className="meta-wide"><dt>Batch ID</dt><dd>{record.batch_id}</dd></div>
      </dl>
      <div className="panel">
        <div className="progress-head"><span>Simulation windows</span><strong>{progress.toFixed(1)}%</strong></div>
        <div className="progress-track" role="progressbar" aria-label="Simulation windows" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span className="progress-complete" style={{ width: `${progress}%` }} />
        </div>
      </div>
      {pdesStatus?.stale && <div className="notice notice-warning" role="status">Showing the last stored partition snapshot; the coordinator is unavailable.</div>}
      {state === "failed" && <div className="notice notice-error" role="alert">
        <strong>Partitioned run failed{pdesStatus?.failed_node ? ` on ${pdesStatus.failed_node}` : ""}.</strong> {pdesStatus?.error ?? report?.error ?? "The coordinator reported a worker failure."}
        {scenario && <button className="ghost-button" type="button" disabled={rerunning} onClick={() => void rerun()}>{rerunning ? "Rerunning…" : "Rerun on surviving nodes"}</button>}
        <a className="banner-action" href={`#/report/${encodeURIComponent(runId)}`}>View failure report<ArrowRight size={15} /></a>
      </div>}
      {state === "coordinator_lost" && <div className="lost-banner" role="alert">
        <Unplug size={20} /><div><strong>The coordinator {record.coordinator} stopped responding</strong>
          <p>The partition state was volatile; restart the same scenario and base seed on the surviving nodes.</p>
          {scenario && <button className="ghost-button" type="button" disabled={rerunning} onClick={() => void rerun()}>{rerunning ? "Rerunning…" : "Rerun on surviving nodes"}</button>}
        </div>
      </div>}
      {rerunError && <div className="notice notice-error" role="alert">{rerunError}</div>}
      {state === "complete" && <div className="complete-banner" role="status"><span><strong>Partitioned run complete.</strong> Merged metrics are ready.</span>
        <a className="banner-action" href={`#/report/${encodeURIComponent(runId)}`}>View report<ArrowRight size={15} /></a></div>}
      <div className="section-title"><h2>Per-partition timing</h2><span>compute versus barrier wait</span></div>
      <div className="partition-timing-list">
        {timing.rows.map((row, index) => {
          const scale = timing.maxTotal || 1;
          return <div className="partition-timing-row" key={row.id}>
            <strong>{row.id}</strong>
            <div className="partition-time-track" aria-label={`${row.id}: ${row.compute.toFixed(3)} seconds compute, ${row.wait.toFixed(3)} seconds wait`}>
              <span className={`partition-time-compute peer-${index % 6}`} style={{ width: `${(row.compute / scale) * 100}%` }} />
              <span className="partition-time-wait" style={{ width: `${(row.wait / scale) * 100}%` }} />
            </div>
            <span>{row.compute.toFixed(2)}s / {row.wait.toFixed(2)}s</span>
          </div>;
        })}
        {!timing.rows.length && <p className="muted">Partition timing will appear after the first coordination window.</p>}
        <p className="partition-legend"><i className="partition-time-compute peer-0" /> Compute <i className="partition-time-wait" /> Barrier wait · {timing.totalCompute.toFixed(2)}s total compute / {timing.totalWait.toFixed(2)}s total wait</p>
      </div>
      {scenario && report?.plan && <div className="pdes-topology-preview">
        <div className="section-title"><h2>Partition map</h2><span>cut links connect different owners</span></div>
        <TopologyCanvas scenario={scenario} mode="partition" partitionAssignment={report.plan.assignment} cutLinks={report.plan.cut_links} />
      </div>}
    </section>
  );
}
