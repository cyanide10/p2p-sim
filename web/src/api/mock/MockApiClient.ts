import { ApiError, type ApiClient } from "../client";
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
    const nodes: ClusterNode[] = peers.map((peer, index) => {
      const workerDown = this.scenario === "worker-failure" && peer.id === "node-2";
      const coordinatorDown = this.scenario === "coordinator-loss" && peer.id === "node-1";
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
            : observed.id === "node-1" && this.scenario === "coordinator-loss"
              ? false
              : true,
        ])),
        ...(!healthy ? { error: "Connection timed out" } : {}),
      };
    });
    return { nodes, updated_at: new Date().toISOString() };
  }

  async createRun(coordinator: string, params: RunParameters): Promise<RunCreated> {
    if (this.scenario === "busy") throw new ApiError("A batch is already running on this node.", 409);
    if (this.scenario === "validation-error") throw new ApiError("lambda must be less than mu.", 400);
    return {
      run_id: "mock-run-1",
      batch_id: "mock-batch-1",
      status: "started",
      coordinator,
      replications: params.replications,
      base_seed: params.base_seed,
      peers: this.scenario === "node-4" ? 4 : 3,
    };
  }

  async listRuns(_limit: number, _offset: number): Promise<RunList> {
    return { runs: [], limit: _limit, offset: _offset, total: 0 };
  }

  async getRun(_runId: string): Promise<RunRecord> {
    throw new ApiError("Run not found.", 404);
  }

  async getStatus(_runId: string): Promise<NodeStatus> {
    throw new ApiError("Run not found.", 404);
  }

  async getReport(_runId: string): Promise<NodeReport> {
    throw new ApiError("Run not found.", 404);
  }

  async getHealth(): Promise<HealthResponse> {
    return { status: "ok" };
  }
}