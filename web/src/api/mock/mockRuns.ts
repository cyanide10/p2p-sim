import { CI_METHOD, compareToTheory, normalSample, seededRandom } from "../../lib/stats";
import type {
  MockScenario,
  NodeReport,
  NodeStatus,
  RunParameters,
  RunRecord,
  RunState,
  TaskCounts,
  TaskDetail,
} from "../types";

/** A mock batch. All state is derived from these fields and the current time. */
export interface MockRun {
  run_id: string;
  batch_id: string;
  coordinator: string;
  created_at: string;
  started_ms: number;
  params: RunParameters;
  scenario: MockScenario;
  peers: string[];
  /** Coordinator dies partway through (coordinator-loss scenario). */
  loses_coordinator: boolean;
}

export const SEED_SCHEME = "seed = base_seed + task_index (task_index = 0..replications-1)";
export const LOSS_FRACTION = 0.35;
export const WORKER_FAILURE_FRACTION = 0.4;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function distributedMs(run: MockRun): number {
  return clamp(run.params.replications * 100, 4000, 15000);
}

export function serialMs(run: MockRun): number {
  return run.params.serial_baseline ? clamp(run.params.replications * 40, 2000, 6000) : 0;
}

/** The worker that dies in the worker-failure scenario: node-2 if present, never the coordinator. */
export function failingWorker(run: MockRun): string | null {
  if (run.scenario !== "worker-failure") return null;
  const candidates = run.peers.filter((peer) => peer !== run.coordinator);
  return candidates.find((peer) => peer === "node-2") ?? candidates[0] ?? null;
}

interface Assignment {
  peer: string;
  attempts: number;
}

/** Round-robin assignment; after the worker failure its tasks move to the next live peer. */
export function assignTasks(run: MockRun): Assignment[] {
  const n = run.peers.length;
  const dead = failingWorker(run);
  const failAt = Math.floor(run.params.replications * WORKER_FAILURE_FRACTION);
  let retried = false;
  return Array.from({ length: run.params.replications }, (_, index) => {
    let peer = run.peers[index % n];
    let attempts = 1;
    if (dead && peer === dead && index >= failAt) {
      peer = run.peers[(index + 1) % n];
      if (!retried) {
        retried = true;
        attempts = 2;
      }
    }
    return { peer, attempts };
  });
}

function phaseCounts(total: number, done: number, inFlight: number): TaskCounts {
  const assigned = Math.min(inFlight, total - done);
  return { pending: total - done - assigned, assigned, complete: done, failed: 0, failed_attempts: 0 };
}

interface Snapshot {
  elapsedMs: number;
  distributedDone: number;
  serialDone: number | null;
  phase: NodeStatus["phase"];
}

function snapshotAt(run: MockRun, nowMs: number): Snapshot {
  const dist = distributedMs(run);
  const serial = serialMs(run);
  let elapsed = Math.max(0, nowMs - run.started_ms);
  if (run.loses_coordinator) elapsed = Math.min(elapsed, dist * LOSS_FRACTION);
  const total = run.params.replications;
  const distributedDone = Math.min(total, Math.floor((elapsed / dist) * total));
  if (elapsed < dist) return { elapsedMs: elapsed, distributedDone, serialDone: null, phase: "distributed" };
  if (serial > 0 && elapsed < dist + serial) {
    return {
      elapsedMs: elapsed,
      distributedDone: total,
      serialDone: Math.floor(((elapsed - dist) / serial) * total),
      phase: "serial_baseline",
    };
  }
  return {
    elapsedMs: Math.min(elapsed, dist + serial),
    distributedDone: total,
    serialDone: serial > 0 ? total : null,
    phase: "complete",
  };
}

export function isLost(run: MockRun, nowMs: number): boolean {
  return run.loses_coordinator && nowMs - run.started_ms >= distributedMs(run) * LOSS_FRACTION;
}

export function runState(run: MockRun, nowMs: number): RunState {
  if (isLost(run, nowMs)) return "coordinator_lost";
  return snapshotAt(run, nowMs).phase === "complete" ? "complete" : "running";
}

export function mockStatus(run: MockRun, nowMs: number): NodeStatus {
  const snap = snapshotAt(run, nowMs);
  const total = run.params.replications;
  const assignments = assignTasks(run);
  const failAt = Math.floor(total * WORKER_FAILURE_FRACTION);
  const counts = phaseCounts(total, snap.distributedDone, run.peers.length);
  if (failingWorker(run) && snap.distributedDone >= failAt) counts.failed_attempts = 1;

  const tasks: TaskDetail[] = assignments.map((assignment, index) => {
    const state = index < snap.distributedDone
      ? "complete"
      : index < snap.distributedDone + counts.assigned
        ? "assigned"
        : "pending";
    return {
      task_id: `${run.batch_id}-${String(index).padStart(4, "0")}`,
      state,
      ...(state === "pending" ? {} : { peer_id: assignment.peer }),
      attempts: state === "pending" ? 0 : state === "assigned" ? 1 : assignment.attempts,
    };
  });

  return {
    batch_id: run.batch_id,
    coordinator: run.coordinator,
    state: snap.phase === "complete" ? "complete" : "running",
    phase: snap.phase,
    replications: total,
    ...counts,
    elapsed_seconds: snap.elapsedMs / 1000,
    ...(snap.serialDone === null ? {} : { serial_baseline: phaseCounts(total, snap.serialDone, 1) }),
    stale: isLost(run, nowMs),
    tasks,
  };
}

/** Per-replication results; depend only on the seed and parameters, like the real simulator. */
export function replicationResults(params: RunParameters, count: number) {
  const { lambda, mu, sim_time, warmup_time } = params;
  const rho = lambda / mu;
  const W = 1 / (mu - lambda);
  const measured = Math.max(sim_time - warmup_time, 1);
  const cv = clamp(0.16 * Math.sqrt(9000 / measured) * (rho / 0.8), 0.005, 0.6);
  return Array.from({ length: count }, (_, index) => {
    const random = seededRandom(params.base_seed + index);
    const wait = Math.max(0.01, W * (1 + cv * normalSample(random)));
    return {
      wait,
      length: lambda * wait * (1 + 0.004 * normalSample(random)),
      utilization: clamp(rho * (1 + 0.02 * Math.sqrt(9000 / measured) * normalSample(random)), 0, 1),
    };
  });
}

export function mockReport(run: MockRun, nowMs: number): NodeReport {
  const snap = snapshotAt(run, nowMs);
  const { params } = run;
  const total = params.replications;
  const rho = params.lambda / params.mu;
  const theory = { rho, L: rho / (1 - rho), W: 1 / (params.mu - params.lambda) };
  const results = replicationResults(params, snap.distributedDone);
  const assignments = assignTasks(run);
  const status = mockStatus(run, nowMs);

  const tasksPerPeer: Record<string, number> = {};
  for (let index = 0; index < snap.distributedDone; index += 1) {
    const peer = assignments[index].peer;
    tasksPerPeer[peer] = (tasksPerPeer[peer] ?? 0) + 1;
  }

  const tolerance = params.tolerance_pct;
  const wait = compareToTheory(results.map((result) => result.wait), theory.W, tolerance);
  const length = compareToTheory(results.map((result) => result.length), theory.L, tolerance);
  const utilization = compareToTheory(results.map((result) => result.utilization), theory.rho, tolerance);

  const distributedDone = snap.phase !== "distributed";
  const distWall = distributedDone ? distributedMs(run) / 1000 : snap.elapsedMs / 1000;
  const perReplication = ((distributedMs(run) / 1000) * run.peers.length * 0.94) / total;
  const sumRuntime = perReplication * snap.distributedDone;

  let verdict: NodeReport["verdict"] = "PENDING";
  let detail = "distributed phase still running; statistics are provisional";
  if (distributedDone) {
    if (!wait || !length) {
      verdict = "FAIL";
      detail = "fewer than 2 replications completed";
    } else {
      verdict = wait.within_tolerance && length.within_tolerance ? "PASS" : "FAIL";
      detail = `W rel. error ${wait.rel_error_pct.toFixed(2)}%, L rel. error ${length.rel_error_pct.toFixed(2)}% (tolerance ${tolerance.toFixed(2)}%); theoretical W in CI: ${wait.theoretical_in_ci}, L in CI: ${length.theoretical_in_ci}`;
    }
  }

  const timing: NodeReport["timing"] = {
    distributed_wall_clock_seconds: distWall,
    distributed_peers: run.peers.length,
    sum_replication_runtime_seconds: sumRuntime,
    serial_wall_clock_seconds: null,
    speedup: null,
  };
  if (snap.serialDone !== null) {
    timing.serial_peer = run.coordinator;
    if (snap.phase === "complete") {
      const serialWall = perReplication * total * 1.04;
      timing.serial_wall_clock_seconds = serialWall;
      timing.speedup = serialWall / distWall;
      timing.serial_results_match_distributed = run.scenario !== "serial-mismatch";
    } else {
      timing.serial_wall_clock_seconds = (snap.elapsedMs - distributedMs(run)) / 1000;
      timing.serial_note = "serial baseline in progress";
    }
  }

  return {
    batch_id: run.batch_id,
    coordinator: run.coordinator,
    state: status.state,
    phase: status.phase,
    verdict,
    verdict_detail: detail,
    params: { lambda: params.lambda, mu: params.mu, sim_time: params.sim_time, warmup_time: params.warmup_time },
    replications_requested: total,
    base_seed: params.base_seed,
    seed_scheme: SEED_SCHEME,
    tolerance_pct: tolerance,
    ci_method: CI_METHOD,
    tasks: {
      pending: status.pending,
      assigned: status.assigned,
      complete: status.complete,
      failed: status.failed,
      failed_attempts: status.failed_attempts,
    },
    tasks_per_peer: tasksPerPeer,
    failed_tasks: [],
    theoretical: theory,
    mean_wait_time: wait,
    mean_queue_length: length,
    utilization,
    timing,
    stale: false,
  };
}

export function toRecord(run: MockRun, nowMs: number): RunRecord {
  const state = runState(run, nowMs);
  return {
    run_id: run.run_id,
    batch_id: run.batch_id,
    coordinator: run.coordinator,
    created_at: run.created_at,
    params: run.params,
    state,
    status: mockStatus(run, nowMs),
    report: state === "complete" ? mockReport(run, nowMs) : null,
  };
}

/** Gateway run IDs: unpadded base64url of the JSON array [coordinator, batch_id]. */
export function encodeRunId(coordinator: string, batchId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([coordinator, batchId]));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
