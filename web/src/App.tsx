import { Activity, CircleHelp, CircleX, Clock3, Network, RadioTower, RefreshCw, Share2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createApiClient } from "./api/client";
import { MOCK_SCENARIOS, type ClusterSnapshot, type GatewayConfig, type MockScenario, type RunCreated } from "./api/types";
import { parseHash } from "./lib/format";
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
  const client = createApiClient(scenario);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [nextConfig, nextSnapshot] = await Promise.all([
          client.getConfig(),
          client.getCluster(),
        ]);
        if (!active) return;
        setConfig(nextConfig);
        setSnapshot(nextSnapshot);
        setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Unable to load cluster data.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [scenario, refreshKey]);

  const nodes = snapshot?.nodes ?? [];
  const disagreement = nodes.some((observer) =>
    nodes.some((observed) => {
      const seen = observer.peers_seen[observed.id];
      return seen !== null && seen !== undefined && seen !== observed.healthy;
    }),
  );
  const lastUpdated = snapshot ? new Date(snapshot.updated_at).toLocaleTimeString() : "--";

  return (
    <section className="page-content" aria-labelledby="cluster-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">POOL OVERVIEW</p>
          <h1 id="cluster-heading">Cluster</h1>
          <p className="lede">Live health and membership as observed across the node pool.</p>
        </div>
        <div className="heading-actions">
          {mockEnabled && import.meta.env.DEV && (
            <label className="scenario-control">
              <span>Scenario</span>
              <select value={scenario} onChange={(event) => window.dispatchEvent(new CustomEvent("mock-scenario", { detail: event.target.value }))}>
                {MOCK_SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
          )}
          <button className="icon-button" type="button" title="Refresh cluster" aria-label="Refresh cluster" onClick={() => setRefreshKey((value) => value + 1)}>
            <RefreshCw size={17} />
          </button>
        </div>
      </div>

      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {disagreement && <div className="notice notice-warning" role="status">Peer views disagree. This may indicate a network partition.</div>}

      <div className="summary-strip" aria-live="polite">
        <div className="summary-stat"><span>Configured nodes</span><strong>{config?.peers.length ?? "--"}</strong></div>
        <div className="summary-stat"><span>Healthy</span><strong>{nodes.filter((node) => node.healthy).length}<small> / {nodes.length}</small></strong></div>
        <div className="summary-stat"><span>Last updated</span><strong className="time-value"><Clock3 size={15} />{lastUpdated}</strong></div>
        <span className={`refresh-state ${loading ? "is-loading" : ""}`}><i />{loading ? "Connecting" : "Auto refresh · 3 sec"}</span>
      </div>

      {loading && !snapshot ? (
        <div className="loading-state" role="status"><span className="spinner" />Connecting to cluster</div>
      ) : !snapshot ? (
        <div className="empty-state"><Network size={22} /><strong>Cluster data unavailable</strong><span>Check the gateway connection and try again.</span></div>
      ) : (
        <>
          <div className="section-title"><h2>Nodes</h2><span>{nodes.length} configured</span></div>
          <div className="node-grid">
            {nodes.map((node) => (
              <article className={`node-row ${node.healthy ? "" : "node-row-down"}`} key={node.id}>
                <div className="node-identity">
                  <span className={`health-dot ${node.healthy ? "healthy" : "unhealthy"}`} aria-hidden="true" />
                  <div><strong>{node.id}</strong><span>{node.url}</span></div>
                </div>
                <div className="node-observer">{node.observer_id === node.id ? <span className="self-marker">SELF</span> : node.observer_id ? `Seen by ${node.observer_id}` : <span className="muted">No observer</span>}</div>
                <div className="node-latency">{node.latency_ms === null ? "--" : `${node.latency_ms} ms`}</div>
                <div className={`health-label ${node.healthy ? "text-healthy" : "text-unhealthy"}`}>
                  {node.healthy ? <Activity size={15} /> : <CircleX size={15} />}
                  {node.healthy ? "Healthy" : "Unreachable"}
                </div>
                {node.error && <div className="node-error"><CircleHelp size={14} />{node.error}</div>}
              </article>
            ))}
          </div>

          <div className="section-title matrix-title"><div><h2>Who sees whom</h2><p>Rows are observers; columns are observed nodes.</p></div></div>
          <div className="matrix-frame">
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
          <a className={activeRoute === "network" ? "active" : ""} href="#/network"><Share2 size={17} /><span>Network lab</span></a>
          <a className={activeRoute === "traffic" ? "active" : ""} href="#/traffic"><RadioTower size={17} /><span>Live traffic</span></a>
          <a className={activeRoute === "launch" ? "active" : ""} href="#/launch"><Activity size={17} /><span>Launch run</span></a>
          <a className="nav-muted" href="#/history" aria-disabled="true" onClick={(event) => event.preventDefault()}><Clock3 size={17} /><span>History</span><small>SOON</small></a>
        </nav>
        <div className="sidebar-footer"><span className="connection-indicator" />{mockEnabled ? "Mock environment" : "Gateway connection"}<span className="version-tag">{mockEnabled ? "DEV" : "LIVE"}</span></div>
      </aside>
      <main className="main-area">
        <header className="topbar"><span>Distributed queueing simulator</span><span className="topbar-right">{mockEnabled ? "LOCAL PREVIEW" : "GATEWAY"}</span></header>
        {activeRoute === "cluster" ? <ClusterPage scenario={scenario} mockEnabled={mockEnabled} />
          : activeRoute === "launch" ? <LaunchPage key={query.get("resubmit") ?? "new"} scenario={scenario} onStarted={handleRunStarted} resubmitRunId={query.get("resubmit")} />
          : activeRoute === "network" ? <NetworkPage scenario={scenario} mockEnabled={mockEnabled} />
          : activeRoute === "traffic" ? <TrafficPage scenario={scenario} mockEnabled={mockEnabled} />
          : activeRoute === "live" && routeId ? <LivePage runId={routeId} scenario={scenario} mockEnabled={mockEnabled} />
          : activeRoute === "report" && routeId ? <ReportPage runId={routeId} scenario={scenario} />
          : <section className="page-content"><div className="empty-state"><CircleHelp size={22} /><strong>Page not found</strong><a href="#/cluster">Return to Cluster</a></div></section>}
      </main>
    </div>
  );
}

export { App };