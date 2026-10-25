import { ArrowRight, RotateCcw, Unplug, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient } from "../api/client";
import type { GatewayConfig, MockScenario, NodeStatus, RunRecord, RunState } from "../api/types";
import { NetworkPlayer } from "../components/NetworkPlayer";
import { ProgressBar, StateBadge, TaskGrid } from "../components/RunBits";
import { formatDuration } from "../lib/format";

const POLL_MS = 500;

/** The copies of a run that the player can replay: seed = base_seed + index. */
export function copyList(baseSeed: number, replications: number) {
  return Array.from({ length: Math.min(replications, 100) }, (_, i) => ({ label: `Copy ${i + 1} (seed ${baseSeed + i})`, seed: baseSeed + i }));
}
const MAX_BACKOFF_MS = 8000;

export function LivePage({ runId, scenario, mockEnabled }: { runId: string; scenario: MockScenario; mockEnabled: boolean }) {
  const api = useMemo(() => createApiClient(scenario), [scenario]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [status, setStatus] = useState<NodeStatus | null>(null);
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
        if (next.state === "complete") {
          setState("complete");
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

  const total = status?.replications ?? record.params.replications;
  const counts = status ?? { pending: total, assigned: 0, complete: 0, failed: 0, failed_attempts: 0 };
  const peers = config?.peers.map((peer) => peer.id) ?? [];
  const phaseLabel = status?.phase === "serial_baseline"
    ? "Serial baseline on coordinator"
    : status?.phase === "complete"
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
        <div><dt>Elapsed</dt><dd>{formatDuration(status?.elapsed_seconds)}</dd></div>
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
      {status?.stale && state !== "coordinator_lost" && (
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
        {status?.serial_baseline && (
          <ProgressBar counts={status.serial_baseline} total={total} label={`Serial baseline on ${record.coordinator}`} />
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
      <TaskGrid tasks={status?.tasks} enabled={Boolean(config?.features?.task_grid)} peers={peers} mock={mockEnabled} />
        </>
      )}
    </section>
  );
}
