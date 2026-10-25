export interface Peer {
  id: string;
  url: string;
}

export interface RunParameters {
  /** "network" for independent network copies; "pdes" for partitioned execution. */
  kind?: "network" | "pdes";
  scenario?: import("../lib/network").Scenario;
  parts?: number;
  baseline?: boolean;
  replications: number;
  lambda: number;
  mu: number;
  sim_time: number;
  warmup_time: number;
  tolerance_pct: number;
  base_seed: number;
  serial_baseline: boolean;
}

export interface RunDefaults extends Omit<RunParameters, "base_seed"> {
  base_seed?: number;
}

export interface GatewayConfig {
  defaults: RunDefaults;
  peers: Peer[];
  gateway_version: string;
  features?: {
    task_grid?: boolean;
  };
}

export interface ClusterNode {
  id: string;
  url: string;
  healthy: boolean;
  observer_id: string | null;
  latency_ms: number | null;
  peers_seen: Record<string, boolean | null>;
  error?: string;
}

export interface ClusterSnapshot {
  nodes: ClusterNode[];
  updated_at: string;
}

export type RunState =
  | "running"
  | "complete"
  | "failed"
  | "coordinator_lost"
  | "unknown";

export interface TaskCounts {
  pending: number;
  assigned: number;
  complete: number;
  failed: number;
  failed_attempts: number;
}

/** Per-replication detail. Real nodes do not expose this yet (docs/node-api-gaps.md). */
export interface TaskDetail {
  task_id: string;
  state: "pending" | "assigned" | "complete" | "failed";
  peer_id?: string;
  attempts: number;
}

export interface NodeStatus {
  batch_id: string;
  coordinator: string;
  state: "running" | "complete";
  phase: "distributed" | "serial_baseline" | "complete";
  replications: number;
  pending: number;
  assigned: number;
  complete: number;
  failed: number;
  failed_attempts: number;
  elapsed_seconds: number;
  serial_baseline?: TaskCounts;
  stale?: boolean;
  tasks?: TaskDetail[];
}

export interface PartitionTiming {
  compute_s: number;
  wait_s: number;
  messages: number;
  bytes: number;
}

export interface PDESStatus {
  kind: "pdes";
  batch_id: string;
  coordinator: string;
  state: "running" | "complete" | "failed";
  phase: string;
  simulated_time: number;
  windows_done: number;
  windows_total: number;
  partitions: Record<string, PartitionTiming>;
  failed_node?: string;
  error?: string;
  stale?: boolean;
}

export type RunStatus = NodeStatus | PDESStatus;

export interface MetricComparison {
  n: number;
  mean: number;
  stddev: number;
  ci95_low: number;
  ci95_high: number;
  ci95_half_width: number;
  theoretical: number;
  rel_error_pct: number;
  tolerance_pct: number;
  within_tolerance: boolean;
  theoretical_in_ci: boolean;
}

export interface Theory {
  rho: number;
  L: number;
  W: number;
}

export interface NodeReport {
  batch_id: string;
  coordinator: string;
  state: "running" | "complete";
  phase: "distributed" | "serial_baseline" | "complete";
  verdict: "PENDING" | "PASS" | "FAIL";
  verdict_detail: string;
  params: Omit<RunParameters, "replications" | "tolerance_pct" | "base_seed" | "serial_baseline">;
  replications_requested: number;
  base_seed: number;
  seed_scheme: string;
  tolerance_pct: number;
  ci_method: string;
  tasks: TaskCounts;
  tasks_per_peer: Record<string, number>;
  failed_tasks: Array<{
    task_id: string;
    seed: number;
    attempts: number;
    error: string;
  }>;
  theoretical: Theory;
  mean_wait_time: MetricComparison | null;
  mean_queue_length: MetricComparison | null;
  utilization: MetricComparison | null;
  timing: {
    distributed_wall_clock_seconds: number;
    distributed_peers: number;
    sum_replication_runtime_seconds: number;
    serial_peer?: string;
    serial_wall_clock_seconds: number | null;
    speedup: number | null;
    serial_results_match_distributed?: boolean;
    serial_note?: string;
  };
  stale?: boolean;
  task_details?: TaskDetail[];
}

export interface Estimate {
  n: number;
  mean: number;
  stddev: number;
  ci95_low: number;
  ci95_high: number;
  ci95_half_width: number;
}

export interface Band {
  mean: Array<number | null>;
  low: Array<number | null>;
  high: Array<number | null>;
}

/** GET /report for a network run (node/internal/netbatch). */
export interface NetworkReport {
  kind: "network";
  batch_id: string;
  coordinator: string;
  state: "running" | "complete";
  phase: string;
  verdict: "PENDING" | "COMPLETE" | "FAIL";
  verdict_detail: string;
  replications_requested: number;
  base_seed: number;
  seed_scheme: string;
  ci_method: string;
  scenario: import("../lib/network").Scenario;
  tasks: TaskCounts;
  tasks_per_peer: Record<string, number>;
  failed_tasks: Array<{ task_id: string; seed: number; attempts: number; error: string }>;
  flows: Record<string, Record<string, Estimate | null>>;
  links: Record<string, Record<string, Estimate | null>>;
  routers: Record<string, Record<string, Estimate | null>>;
  totals: Record<string, Estimate | null>;
  series: { bin_width: number; delivered_rate: Band; dropped_rate: Band; mean_delay: Band; flows: Record<string, Band> };
  timing: { distributed_wall_clock_seconds: number; distributed_peers: number; sum_replication_runtime_seconds: number; parallelism: number | null };
  stale?: boolean;
}

export interface PartitionPlan {
  ok: boolean;
  parts: number;
  assignment: Record<string, number>;
  cut_links: string[];
  lookahead: number;
  windows: number;
  load: number[];
}

export interface PDESMetrics {
  duration: number;
  flows: Record<string, Record<string, number | null>>;
  links: Record<string, Record<string, number | null>>;
  routers: Record<string, Record<string, number | null>>;
  totals: Record<string, number | null>;
  series: {
    bin_width: number;
    delivered_rate: number[];
    dropped_rate: number[];
    mean_delay: Array<number | null>;
    flows: Record<string, number[]>;
  };
}

export interface PDESReport {
  kind: "pdes";
  batch_id: string;
  coordinator: string;
  state: "running" | "complete" | "failed";
  phase: string;
  scenario: import("../lib/network").Scenario;
  base_seed: number;
  plan: PartitionPlan;
  metrics?: PDESMetrics;
  baseline_metrics?: PDESMetrics;
  results_identical?: boolean;
  first_difference?: string;
  speedup?: number;
  partitioned_wall_seconds: number;
  baseline_wall_seconds?: number;
  partitions: Record<string, PartitionTiming>;
  failed_node?: string;
  error?: string;
  stale?: boolean;
}

export type RunReport = NodeReport | NetworkReport | PDESReport;

export interface RunRecord {
  run_id: string;
  batch_id: string;
  coordinator: string;
  created_at: string;
  params: RunParameters;
  state: RunState;
  status: RunStatus | null;
  report: RunReport | null;
}

export interface RunCreated {
  run_id: string;
  batch_id: string;
  status: "started";
  coordinator: string;
  replications?: number;
  base_seed: number;
  peers?: number;
  parts?: number;
}

export interface RunList {
  runs: RunRecord[];
  limit: number;
  offset: number;
  total: number;
}

export interface HealthResponse {
  status: string;
}

export type MockScenario =
  | "happy-path"
  | "worker-failure"
  | "coordinator-loss"
  | "busy"
  | "validation-error"
  | "small-n"
  | "serial-mismatch"
  | "node-4";

export const MOCK_SCENARIOS: Array<{ id: MockScenario; label: string }> = [
  { id: "happy-path", label: "Happy path" },
  { id: "worker-failure", label: "Worker failure" },
  { id: "coordinator-loss", label: "Coordinator loss" },
  { id: "busy", label: "Busy coordinator" },
  { id: "validation-error", label: "Validation error" },
  { id: "small-n", label: "Small sample" },
  { id: "serial-mismatch", label: "Serial mismatch" },
  { id: "node-4", label: "Four nodes" },
];