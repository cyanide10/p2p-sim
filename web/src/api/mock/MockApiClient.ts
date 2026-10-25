import type { NetStreamEvent } from "../../lib/network";
import { generateTraffic, type TrafficParams } from "../../lib/traffic";
import { ApiError, type ApiClient, type TrafficHandler } from "../client";
import type {
  ClusterNode,
  ClusterSnapshot,
  GatewayConfig,
  HealthResponse,
  MockScenario,
  NodeReport,
  NodeStatus,
  RunCreated,
  RunList,
  RunParameters,
  RunRecord,
} from "../types";
import { encodeRunId, isLost, mockReport, mockStatus, runState, toRecord, type MockRun } from "./mockRuns";

const STORAGE_KEY = "p2p-sim-mock-runs";
let runs: MockRun[] | null = null;

// Mock runs persist for the browser session so a reload keeps Live/Report working.
function store(): MockRun[] {
  if (runs) return runs;
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    runs = saved ? (JSON.parse(saved) as MockRun[]) : [];
  } catch {
    runs = [];
  }
  return runs;
}

function save() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store()));
  } catch {
    // Storage unavailable: runs stay in memory only.
  }
}

function findRun(runId: string): MockRun {
  const run = store().find((item) => item.run_id === runId);
  if (!run) throw new ApiError("Run not found.", 404);
  return run;
}

function batchId(coordinator: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  const suffix = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `batch-${coordinator}-${stamp}-${suffix}`;
}

const basePeers = [
  { id: "node-1", url: "http://127.0.0.1:8081" },
  { id: "node-2", url: "http://127.0.0.1:8082" },
  { id: "node-3", url: "http://127.0.0.1:8083" },
];

export class MockApiClient implements ApiClient {
  constructor(private readonly scenario: MockScenario) {}

  async getConfig(): Promise<GatewayConfig> {
    const peers = this.scenario === "node-4"
      ? [...basePeers, { id: "node-4", url: "http://127.0.0.1:8084" }]
      : basePeers;
    return {
      defaults: {
        replications: this.scenario === "small-n" ? 12 : 100,
        lambda: 0.8,
        mu: 1,
        sim_time: 10000,
        warmup_time: 1000,
        tolerance_pct: 10,
        serial_baseline: true,
      },
      peers,
      gateway_version: "mock",
      features: { task_grid: true },
    };
  }

  async getCluster(): Promise<ClusterSnapshot> {
    const peers = this.scenario === "node-4"
      ? [...basePeers, { id: "node-4", url: "http://127.0.0.1:8084" }]
      : basePeers;
    const now = Date.now();
    // Coordinators that died during a batch stay down while this scenario is selected.
    const lostCoordinators = new Set(this.scenario === "coordinator-loss"
      ? store().filter((run) => isLost(run, now)).map((run) => run.coordinator)
      : []);
    const nodes: ClusterNode[] = peers.map((peer, index) => {
      const workerDown = this.scenario === "worker-failure" && peer.id === "node-2";
      const coordinatorDown = (this.scenario === "coordinator-loss" && peer.id === "node-1") || lostCoordinators.has(peer.id);
      const healthy = !workerDown && !coordinatorDown;
      const observerId = this.scenario === "coordinator-loss" && peer.id === "node-1"
        ? null
        : peer.id;
      return {
        ...peer,
        healthy,
        observer_id: observerId,
        latency_ms: healthy ? 3 + index * 4 : null,
        peers_seen: Object.fromEntries(peers.map((observed) => [
          observed.id,
          this.scenario === "worker-failure" && peer.id === "node-3" && observed.id === "node-2"
            ? false
            : (observed.id === "node-1" && this.scenario === "coordinator-loss") || lostCoordinators.has(observed.id)
              ? false
              : true,
        ])),
        ...(!healthy ? { error: "Connection timed out" } : {}),
      };
    });
    return { nodes, updated_at: new Date().toISOString() };
  }

  async createRun(coordinator: string, params: RunParameters): Promise<RunCreated> {
    if (this.scenario === "validation-error") throw new ApiError("lambda must be less than mu.", 400);
    const now = Date.now();
    const busy = store().find((run) => run.coordinator === coordinator && runState(run, now) === "running");
    if (busy || (this.scenario === "busy" && coordinator === "node-1")) {
      throw new ApiError("A batch is already running on this node.", 409);
    }
    const config = await this.getConfig();
    const created = new Date(now);
    const id = batchId(coordinator, created);
    // A resubmission of a lost batch (same seed and parameters) is allowed to finish.
    const resubmission = store().some((run) =>
      run.loses_coordinator && JSON.stringify(run.params) === JSON.stringify(params));
    const run: MockRun = {
      run_id: encodeRunId(coordinator, id),
      batch_id: id,
      coordinator,
      created_at: created.toISOString(),
      started_ms: now,
      params,
      scenario: this.scenario,
      peers: config.peers.map((peer) => peer.id),
      loses_coordinator: this.scenario === "coordinator-loss" && !resubmission,
    };
    store().push(run);
    save();
    return {
      run_id: run.run_id,
      batch_id: run.batch_id,
      status: "started",
      coordinator,
      replications: params.replications,
      base_seed: params.base_seed,
      peers: run.peers.length,
    };
  }

  async listRuns(limit: number, offset: number): Promise<RunList> {
    const now = Date.now();
    const newest = [...store()].sort((a, b) => b.started_ms - a.started_ms);
    return {
      runs: newest.slice(offset, offset + limit).map((run) => toRecord(run, now)),
      limit,
      offset,
      total: newest.length,
    };
  }

  async getRun(runId: string): Promise<RunRecord> {
    return toRecord(findRun(runId), Date.now());
  }

  async getStatus(runId: string): Promise<NodeStatus> {
    return mockStatus(findRun(runId), Date.now());
  }

  async getReport(runId: string): Promise<NodeReport> {
    const run = findRun(runId);
    const now = Date.now();
    if (isLost(run, now)) {
      throw new ApiError("Coordinator unreachable and no final report was captured.", 502);
    }
    return mockReport(run, now);
  }

  /** Replays a browser-computed stream at the requested speed. */
  openTraffic(params: TrafficParams, onEvent: TrafficHandler) {
    if (this.scenario === "busy" && params.node === "node-1") {
      onEvent({ type: "error", message: "node busy: concurrent task limit reached" });
      return () => undefined;
    }
    const events = generateTraffic(params);
    const started = performance.now();
    let next = 0;
    const timer = window.setInterval(() => {
      const simNow = ((performance.now() - started) / 1000) * params.speed;
      while (next < events.length) {
        const event = events[next];
        if ("t" in event && event.t > simNow) break;
        onEvent(event);
        next += 1;
      }
      if (next >= events.length) window.clearInterval(timer);
    }, 40);
    return () => window.clearInterval(timer);
  }

  // Network scenarios are simulated by netsim.py on the nodes; the mock has no simulator.
  async createNetworkRun(): Promise<RunCreated> {
    throw new ApiError("Network runs need the real nodes. Start the Docker stack and open the gateway (port 8090).", 501);
  }

  openNetworkTraffic(_node: string, _scenario: unknown, _speed: number, _seed: number, _start: number, onEvent: (event: NetStreamEvent) => void) {
    window.setTimeout(() => onEvent({ type: "error", message: "Live network runs need the real nodes. Start the Docker stack and open the gateway (port 8090)." }), 0);
    return () => undefined;
  }

  async getHealth(): Promise<HealthResponse> {
    return { status: "ok" };
  }
}