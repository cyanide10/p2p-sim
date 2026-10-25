import { ApiError, type ApiClient } from "../client";
import type {
  ClusterNode,
  ClusterSnapshot,
  GatewayConfig,
  HealthResponse,
  MetricComparison,
  MockScenario,
  NodeReport,
  NodeStatus,
  RunCreated,
  RunList,
  RunParameters,
  RunRecord,
  TaskCounts,
} from "../types";

const basePeers = [
  { id: "node-1", url: "http://127.0.0.1:8081" },
  { id: "node-2", url: "http://127.0.0.1:8082" },
  { id: "node-3", url: "http://127.0.0.1:8083" },
];

const DISTRIBUTED_MS = 10_000;
const SERIAL_MS = 4_000;
const LOSS_AFTER_MS = 4_000;
const Z95 = 1.959963984540054;

interface MockRun {
  runId: string;
  batchId: string;
  coordinator: string;
  params: RunParameters;
  peers: string[];
  scenario: MockScenario;
  startedAt: number;
  createdAt: string;
}

// Module-level so runs survive the per-render client instances.
const mockRuns = new Map<string, MockRun>();
let mockRunCount = 0;

function findRun(runId: string): MockRun {
  const run = mockRuns.get(runId);
  if (!run) throw new ApiError("run not found", 404);
  return run;
}

const elapsedMs = (run: MockRun) => Date.now() - run.startedAt;
const isLost = (run: MockRun, elapsed: number) => run.scenario === "coordinator-loss" && elapsed >= LOSS_AFTER_MS;

function counts(total: number, fraction: number, workers: number): TaskCounts {
  const complete = Math.floor(total * Math.min(1, fraction));
  const assigned = Math.min(workers, total - complete);
  return { pending: total - complete - assigned, assigned, complete, failed: 0, failed_attempts: 0 };
}

function mockStatus(run: MockRun, elapsed: number): NodeStatus {
  const reps = run.params.replications;
  const distributed = counts(reps, elapsed / DISTRIBUTED_MS, run.peers.length);
  const inDistributed = elapsed < DISTRIBUTED_MS;
  const inSerial = !inDistributed && run.params.serial_baseline && elapsed < DISTRIBUTED_MS + SERIAL_MS;
  const phase = inDistributed ? "distributed" : inSerial ? "serial_baseline" : "complete";
  return {
    batch_id: run.batchId,
    coordinator: run.coordinator,
    state: phase === "complete" ? "complete" : "running",
    phase,
    replications: reps,
    ...distributed,
    elapsed_seconds: Math.min(elapsed, DISTRIBUTED_MS + (run.params.serial_baseline ? SERIAL_MS : 0)) / 1000,
    ...(run.params.serial_baseline && !inDistributed
      ? { serial_baseline: counts(reps, (elapsed - DISTRIBUTED_MS) / SERIAL_MS, 1) }
      : {}),
  };
}

function metric(theory: number, n: number, relStdDev: number, bias: number, tolerance: number): MetricComparison | null {
  if (n < 2) return null;
  const mean = theory * (1 + bias);
  const stddev = theory * relStdDev;
  const half = (Z95 * stddev) / Math.sqrt(n);
  const relError = Math.abs(mean - theory) / theory * 100;
  return {
    n,
    mean,
    stddev,
    ci95_low: mean - half,
    ci95_high: mean + half,
    ci95_half_width: half,
    theoretical: theory,
    rel_error_pct: relError,
    tolerance_pct: tolerance,
    within_tolerance: relError <= tolerance,
    theoretical_in_ci: theory >= mean - half && theory <= mean + half,
  };
}

function mockReport(run: MockRun, status: NodeStatus, elapsed: number): NodeReport {
  const { lambda, mu, sim_time, warmup_time, tolerance_pct, replications, base_seed, serial_baseline } = run.params;
  const rho = lambda / mu;
  const theory = { rho, L: rho / (1 - rho), W: 1 / (mu - lambda) };
  const n = status.complete;
  const W = metric(theory.W, n, 0.18, 0.012, tolerance_pct);
  const L = metric(theory.L, n, 0.22, 0.015, tolerance_pct);
  const distributedDone = status.phase !== "distributed";
  const pass = Boolean(W?.within_tolerance && L?.within_tolerance);
  const tasksPerPeer = Object.fromEntries(run.peers.map((peer, index) => [
    peer,
    Math.floor(n / run.peers.length) + (index < n % run.peers.length ? 1 : 0),
  ]));
  const distributedWall = Math.min(elapsed, DISTRIBUTED_MS) / 1000;
  const serialDone = status.phase === "complete" && serial_baseline;
  const serialWall = serial_baseline && distributedDone ? (serialDone ? 27.1 : (elapsed - DISTRIBUTED_MS) / 1000) : null;
  return {
    batch_id: run.batchId,
    coordinator: run.coordinator,
    state: status.state,
    phase: status.phase,
    verdict: !distributedDone ? "PENDING" : pass ? "PASS" : "FAIL",
    verdict_detail: !distributedDone
      ? "distributed phase still running; statistics are provisional"
      : `W rel. error ${W?.rel_error_pct.toFixed(2)}%, L rel. error ${L?.rel_error_pct.toFixed(2)}% (tolerance ${tolerance_pct.toFixed(2)}%); theoretical W in CI: ${W?.theoretical_in_ci}, L in CI: ${L?.theoretical_in_ci}`,
    params: { lambda, mu, sim_time, warmup_time },
    replications_requested: replications,
    base_seed,
    seed_scheme: "seed = base_seed + task_index (task_index = 0..replications-1)",
    tolerance_pct,
    ci_method: "normal approximation: mean ± 1.96·s/√n (valid for n ≥ 30)",
    tasks: { pending: status.pending, assigned: status.assigned, complete: status.complete, failed: status.failed, failed_attempts: status.failed_attempts },
    tasks_per_peer: tasksPerPeer,
    failed_tasks: [],
    theoretical: theory,
    mean_wait_time: W,
    mean_queue_length: L,
    utilization: metric(rho, n, 0.01, -0.002, tolerance_pct),
    timing: {
      distributed_wall_clock_seconds: distributedWall,
      distributed_peers: run.peers.length,
      sum_replication_runtime_seconds: n * 0.28,
      ...(serial_baseline ? { serial_peer: run.coordinator } : {}),
      serial_wall_clock_seconds: serialWall,
      speedup: serialDone ? 27.1 / distributedWall : null,
      ...(serialDone ? { serial_results_match_distributed: run.scenario !== "serial-mismatch" } : {}),
      ...(serial_baseline && !serialDone && distributedDone ? { serial_note: "serial baseline in progress" } : {}),
    },
  };
}

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
    mockRunCount += 1;
    const peers = (this.scenario === "node-4" ? [...basePeers, { id: "node-4", url: "" }] : basePeers).map((peer) => peer.id);
    const run: MockRun = {
      runId: `mock-run-${mockRunCount}`,
      batchId: `batch-${coordinator}-mock-${mockRunCount}`,
      coordinator,
      params,
      peers,
      scenario: this.scenario,
      startedAt: Date.now(),
      createdAt: new Date().toISOString(),
    };
    mockRuns.set(run.runId, run);
    return {
      run_id: run.runId,
      batch_id: run.batchId,
      status: "started",
      coordinator,
      replications: params.replications,
      base_seed: params.base_seed,
      peers: peers.length,
    };
  }

  async listRuns(_limit: number, _offset: number): Promise<RunList> {
    return { runs: [], limit: _limit, offset: _offset, total: 0 };
  }

  async getRun(runId: string): Promise<RunRecord> {
    const run = findRun(runId);
    const elapsed = elapsedMs(run);
    const lost = isLost(run, elapsed);
    const status = mockStatus(run, lost ? LOSS_AFTER_MS : elapsed);
    return {
      run_id: run.runId,
      batch_id: run.batchId,
      coordinator: run.coordinator,
      created_at: run.createdAt,
      params: run.params,
      state: lost ? "coordinator_lost" : status.state,
      status,
      report: status.state === "complete" ? mockReport(run, status, elapsed) : null,
    };
  }

  async getStatus(runId: string): Promise<NodeStatus> {
    const run = findRun(runId);
    const elapsed = elapsedMs(run);
    if (isLost(run, elapsed)) throw new ApiError(`${run.coordinator} unreachable: connection refused`, 502);
    return { ...mockStatus(run, elapsed), stale: false };
  }

  async getReport(runId: string): Promise<NodeReport> {
    const run = findRun(runId);
    const elapsed = elapsedMs(run);
    if (isLost(run, elapsed)) throw new ApiError("coordinator no longer holds this batch", 404);
    return { ...mockReport(run, mockStatus(run, elapsed), elapsed), stale: false };
  }

  async getHealth(): Promise<HealthResponse> {
    return { status: "ok" };
  }
}