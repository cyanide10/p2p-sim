import { Activity, ChevronDown, CircleHelp, CircleX, Clock3, Network, RadioTower, RefreshCw, Share2, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createApiClient } from "./api/client";
import { MOCK_SCENARIOS, type ClusterSnapshot, type GatewayConfig, type MockScenario, type RunCreated } from "./api/types";
import { EmptyState, LoadingState, Notice, PageHeading, SectionTitle, StatStrip } from "./components/PagePrimitives";
import { parseHash } from "./lib/format";
import { startPolling } from "./lib/poll";
import { AttackPage } from "./pages/AttackPage";
import { LaunchPage } from "./pages/LaunchPage";
import { LivePage } from "./pages/LivePage";
import { NetworkPage } from "./pages/NetworkPage";
import { ReportPage } from "./pages/ReportPage";
import { TrafficPage } from "./pages/TrafficPage";

const subscribeToHash = (callback: () => void) => {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
};

const getCurrentHash = () => window.location.hash || "#/cluster";

function ClusterPage({
  scenario,
  mockEnabled,
}: {
  scenario: MockScenario;
  mockEnabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState<ClusterSnapshot | null>(null);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [manualState, setManualState] = useState<"idle" | "checking" | "done">("idle");
  const [matrixOpen, setMatrixOpen] = useState(false);
  const manualRefresh = useRef(false);
  const client = useMemo(() => createApiClient(scenario), [scenario]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const manual = manualRefresh.current;
      try {
        const [nextConfig, nextSnapshot] = await Promise.all([
          client.getConfig(),
          client.getCluster(),
        ]);
        if (!active) return;
        setConfig(nextConfig);
        setSnapshot(nextSnapshot);
        setError(null);
        if (manual) {
          manualRefresh.current = false;
          setManualState("done");
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Unable to load cluster data.");
        if (manual) {
          manualRefresh.current = false;
          setManualState("idle");
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    const stop = startPolling(refresh, 3000);
    return () => {
      active = false;
      stop();
    };
  }, [client, refreshKey]);

  // "Just checked" is a short-lived acknowledgement of the manual refresh;
  // the label returns to the 3 sec auto-poll wording afterwards.
  useEffect(() => {
    if (manualState !== "done") return;
    const timer = window.setTimeout(() => setManualState("idle"), 4000);
    return () => window.clearTimeout(timer);
  }, [manualState]);

  const nodes = snapshot?.nodes ?? [];
  const disagreement = nodes.some((observer) =>
    nodes.some((observed) => {
      const seen = observer.peers_seen[observed.id];
      return seen !== null && seen !== undefined && seen !== observed.healthy;
    }),
  );
  const lastUpdated = snapshot ? new Date(snapshot.updated_at).toLocaleTimeString() : "--";
  const healthyCount = nodes.filter((node) => node.healthy).length;

  // A disagreement is the one case where the matrix should not stay hidden:
  // it is the authoritative view of who sees whom differently.
  useEffect(() => {
    if (disagreement) setMatrixOpen(true);
  }, [disagreement]);

  return (
    <section className="page-content" aria-labelledby="cluster-heading">
      <PageHeading
        id="cluster-heading"
        eyebrow="POOL OVERVIEW"
        title="Cluster"
        lede="Live health and membership as observed across the node pool."
        actions={<>
          {mockEnabled && import.meta.env.DEV && (
            <label className="scenario-control">
              <span>Scenario</span>
              <select value={scenario} onChange={(event) => window.dispatchEvent(new CustomEvent("mock-scenario", { detail: event.target.value }))}>
                {MOCK_SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
          )}
          <button
            className="icon-button"
            type="button"
            title="Refresh cluster"
            aria-label="Refresh cluster"
            onClick={() => {
              manualRefresh.current = true;
              setManualState("checking");
              setRefreshKey((value) => value + 1);
            }}
          >
            <RefreshCw size={17} />
          </button>
        </>}
      />

      {error && <Notice kind="error">{error}</Notice>}
      {disagreement && <Notice kind="warning">Nodes disagree about each other&rsquo;s health — possible partition.</Notice>}

      <StatStrip
        variant="summary"
        live
        items={[
          { label: "Healthy", value: healthyCount, small: ` / ${nodes.length}` },
          { label: "Last updated", value: <><Clock3 size={15} />{lastUpdated}</>, valueClassName: "time-value" },
        ]}
        extra={
          <span className={`refresh-state ${loading || manualState === "checking" ? "is-loading" : ""} ${manualState === "done" ? "is-checked" : ""}`}>
            <i />
            {manualState === "checking" ? "Checking now" : manualState === "done" ? "Just checked" : loading ? "Connecting" : "Auto refresh · 3 sec"}
          </span>
        }
      />

      {loading && !snapshot ? (
        <LoadingState>Connecting to cluster</LoadingState>
      ) : !snapshot ? (
        <EmptyState icon={<Network size={22} />} title="Cluster data unavailable"><span>Check the gateway connection and try again.</span></EmptyState>
      ) : (
        <>
          <SectionTitle title="Nodes" note={`${config?.peers.length ?? nodes.length} configured`} />
          <div className="node-grid">
            {nodes.map((node) => (
              <article className={`node-row ${node.healthy ? "" : "node-row-down"}`} key={node.id}>
                <div className="node-identity">
                  <span className={`health-dot ${node.healthy ? "healthy" : "unhealthy"}`} aria-hidden="true" />
                  <div><strong>{node.id}</strong><span>{node.url}</span></div>
                </div>
                {/* Each node reports its own health, so only a mismatched identity is worth showing. */}
                <div className="node-observer">{node.observer_id && node.observer_id !== node.id ? <span className="muted" title="This address answered with a different node ID; check peers.yaml">Answers as {node.observer_id}</span> : null}</div>
                <div className="node-latency">{node.latency_ms === null ? "--" : `${node.latency_ms} ms`}</div>
                <div className={`health-label ${node.healthy ? "text-healthy" : "text-unhealthy"}`}>
                  {node.healthy ? <Activity size={15} /> : <CircleX size={15} />}
                  {node.healthy ? "Healthy" : "Unreachable"}
                </div>
                {node.error && <div className="node-error"><CircleHelp size={14} />{node.error}</div>}
              </article>
            ))}
          </div>

          <SectionTitle
            className="matrix-title"
            title="Who sees whom"
            note={<p>Rows are observers; columns are the observed nodes.</p>}
            action={
              <button
                className="disclosure-toggle"
                type="button"
                aria-expanded={matrixOpen}
                aria-controls="peer-health-matrix"
                onClick={() => setMatrixOpen((open) => !open)}
              >
                {matrixOpen ? "Hide matrix" : "Show matrix"}
                <ChevronDown size={14} className={matrixOpen ? "is-open" : ""} />
              </button>
            }
          />
          <div className="matrix-frame" id="peer-health-matrix" hidden={!matrixOpen}>
            <table className="peer-matrix">
              <caption className="sr-only">Peer health observations by node</caption>
              <thead><tr><th scope="col">Observer</th>{nodes.map((node) => <th scope="col" key={node.id}>{node.id}</th>)}</tr></thead>
              <tbody>{nodes.map((observer) => (
                <tr key={observer.id}>
                  <th scope="row">{observer.id}</th>
                  {nodes.map((observed) => {
                    const seen = observer.peers_seen[observed.id];
                    const state = seen === true ? "up" : seen === false ? "down" : "unknown";
                    return <td key={observed.id}><span className={`matrix-state ${state}`}><i />{state === "up" ? "Up" : state === "down" ? "Down" : "Unknown"}</span></td>;
                  })}
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function App() {
  const hash = useSyncExternalStore(subscribeToHash, getCurrentHash, () => "#/cluster");
  const mockEnabled = import.meta.env.VITE_USE_MOCK !== "false";
  const [scenario, setScenario] = useState<MockScenario>("happy-path");

  useEffect(() => {
    const changeScenario = (event: Event) => {
      const selected = (event as CustomEvent<string>).detail;
      if (MOCK_SCENARIOS.some((item) => item.id === selected)) setScenario(selected as MockScenario);
    };
    window.addEventListener("mock-scenario", changeScenario);
    return () => window.removeEventListener("mock-scenario", changeScenario);
  }, []);

  const { route: activeRoute, id: routeId, query } = parseHash(hash);

  const handleRunStarted = (run: RunCreated) => {
    window.location.hash = `#/live/${encodeURIComponent(run.run_id)}`;
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/cluster" aria-label="p2p-sim home"><span className="brand-mark"><Network size={19} /></span><span>p2p<span className="brand-dot">.</span>sim</span></a>
        <div className="sidebar-caption">SIMULATION CONTROL</div>
        <nav className="primary-nav" aria-label="Primary navigation">
          <a className={activeRoute === "cluster" ? "active" : ""} href="#/cluster"><Network size={17} /><span>Cluster</span></a>
          <a className={activeRoute === "network" ? "active" : ""} href="#/network"><Share2 size={17} /><span>Network</span></a>
          <a className={activeRoute === "attack" ? "active" : ""} href="#/attack"><ShieldAlert size={17} /><span>Attack</span></a>
          <a className={activeRoute === "traffic" ? "active" : ""} href="#/traffic"><RadioTower size={17} /><span>Traffic</span></a>
          <a className={activeRoute === "launch" ? "active" : ""} href="#/launch"><Activity size={17} /><span>Launch run</span></a>
        </nav>
        <div className="sidebar-footer"><span className="connection-indicator" />{mockEnabled ? "Mock environment" : "Gateway connection"}<span className="version-tag">{mockEnabled ? "DEV" : "LIVE"}</span></div>
      </aside>
      <main className="main-area">
        <header className="topbar"><span>Node pool simulator harness</span><span className="topbar-right">{mockEnabled ? "LOCAL PREVIEW" : "GATEWAY"}</span></header>
        {activeRoute === "cluster" ? <ClusterPage scenario={scenario} mockEnabled={mockEnabled} />
          : activeRoute === "launch" ? <LaunchPage key={query.get("resubmit") ?? "new"} scenario={scenario} onStarted={handleRunStarted} resubmitRunId={query.get("resubmit")} />
          : activeRoute === "network" ? <NetworkPage scenario={scenario} />
          : activeRoute === "attack" ? <AttackPage scenario={scenario} />
          : activeRoute === "traffic" ? <TrafficPage scenario={scenario} mockEnabled={mockEnabled} />
          : activeRoute === "live" && routeId ? <LivePage runId={routeId} scenario={scenario} mockEnabled={mockEnabled} />
          : activeRoute === "report" && routeId ? <ReportPage runId={routeId} scenario={scenario} />
          : <section className="page-content"><EmptyState icon={<CircleHelp size={22} />} title="Page not found"><a href="#/cluster">Return to Cluster</a></EmptyState></section>}
      </main>
    </div>
  );
}

export { App };