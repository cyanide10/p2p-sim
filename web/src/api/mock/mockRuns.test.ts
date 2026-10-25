import { describe, expect, it } from "vitest";
import type { MockScenario, RunParameters } from "../types";
import {
  distributedMs,
  encodeRunId,
  LOSS_FRACTION,
  mockReport,
  mockStatus,
  runState,
  serialMs,
  type MockRun,
} from "./mockRuns";

const params: RunParameters = {
  replications: 100,
  lambda: 0.8,
  mu: 1,
  sim_time: 10000,
  warmup_time: 1000,
  tolerance_pct: 10,
  base_seed: 42000,
  serial_baseline: true,
};

function makeRun(scenario: MockScenario, overrides: Partial<RunParameters> = {}, peers = ["node-1", "node-2", "node-3"]): MockRun {
  return {
    run_id: "run",
    batch_id: "batch-node-1-test",
    coordinator: "node-1",
    created_at: new Date(0).toISOString(),
    started_ms: 0,
    params: { ...params, ...overrides },
    scenario,
    peers,
    loses_coordinator: scenario === "coordinator-loss",
  };
}

const end = (run: MockRun) => distributedMs(run) + serialMs(run) + 1;

describe("mock run timeline", () => {
  it("progresses from running to complete with a passing report", () => {
    const run = makeRun("happy-path");
    const early = mockStatus(run, distributedMs(run) / 2);
    expect(early.state).toBe("running");
    expect(early.complete).toBeGreaterThan(0);
    expect(early.complete + early.assigned + early.pending).toBe(100);
    expect(mockReport(run, distributedMs(run) / 2).verdict).toBe("PENDING");

    const serial = mockStatus(run, distributedMs(run) + 1);
    expect(serial.phase).toBe("serial_baseline");
    expect(serial.serial_baseline).toBeDefined();

    expect(runState(run, end(run))).toBe("complete");
    const report = mockReport(run, end(run));
    expect(report.verdict).toBe("PASS");
    expect(report.mean_wait_time?.n).toBe(100);
    expect(report.timing.serial_results_match_distributed).toBe(true);
    expect(report.timing.speedup).toBeGreaterThan(1);
    expect(Object.values(report.tasks_per_peer).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("produces identical statistics for the same seed and parameters", () => {
    const first = mockReport(makeRun("happy-path"), end(makeRun("happy-path")));
    const second = mockReport(makeRun("node-4", {}, ["node-1", "node-2", "node-3", "node-4"]), end(makeRun("node-4")));
    expect(second.mean_wait_time).toEqual(first.mean_wait_time);
    expect(Object.keys(second.tasks_per_peer)).toHaveLength(4);
  });

  it("retries the failed worker's task and still completes", () => {
    const run = makeRun("worker-failure");
    const status = mockStatus(run, end(run));
    expect(status.failed_attempts).toBe(1);
    expect(status.tasks?.filter((task) => task.attempts > 1)).toHaveLength(1);
    const report = mockReport(run, end(run));
    expect(report.tasks.complete).toBe(100);
    expect(report.tasks_per_peer["node-2"]).toBeLessThan(report.tasks_per_peer["node-3"]);
  });

  it("freezes a lost coordinator's batch and marks the snapshot stale", () => {
    const run = makeRun("coordinator-loss");
    const lossAt = distributedMs(run) * LOSS_FRACTION;
    expect(runState(run, lossAt - 1)).toBe("running");
    expect(runState(run, end(run))).toBe("coordinator_lost");
    const status = mockStatus(run, end(run));
    expect(status.stale).toBe(true);
    expect(status.state).toBe("running");
    expect(status.complete).toBeLessThan(100);
  });

  it("flags serial mismatch and small samples", () => {
    const mismatch = makeRun("serial-mismatch");
    expect(mockReport(mismatch, end(mismatch)).timing.serial_results_match_distributed).toBe(false);
    const small = makeRun("small-n", { replications: 12 });
    expect(mockReport(small, end(small)).mean_wait_time?.n).toBe(12);
  });

  it("omits serial timing when the baseline is off", () => {
    const run = makeRun("happy-path", { serial_baseline: false });
    const report = mockReport(run, end(run));
    expect(report.timing.serial_wall_clock_seconds).toBeNull();
    expect(report.timing.serial_results_match_distributed).toBeUndefined();
  });
});

describe("encodeRunId", () => {
  it("is unpadded base64url of [coordinator, batch_id]", () => {
    const id = encodeRunId("node-1", "batch-x");
    expect(id).not.toMatch(/[+/=]/);
    const json = atob(id.replace(/-/g, "+").replace(/_/g, "/"));
    expect(JSON.parse(json)).toEqual(["node-1", "batch-x"]);
  });
});
