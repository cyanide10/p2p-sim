import { describe, expect, it } from "vitest";
import type { RunParameters } from "../api/types";
import { validateRun } from "./validation";

const validRun: RunParameters = {
  replications: 100,
  lambda: 0.8,
  mu: 1,
  sim_time: 10000,
  warmup_time: 1000,
  tolerance_pct: 10,
  base_seed: 0,
  serial_baseline: true,
};

describe("validateRun", () => {
  it("accepts stable parameters and computes M/M/1 theory", () => {
    const result = validateRun(validRun);
    expect(result.errors).toEqual({});
    expect(result.rho).toBeCloseTo(0.8);
    expect(result.theoretical?.W).toBeCloseTo(5);
    expect(result.theoretical?.L).toBeCloseTo(4);
  });

  it("allows zero warmup and seed", () => {
    const result = validateRun({ ...validRun, warmup_time: 0, base_seed: 0 });
    expect(result.errors.warmup_time).toBeUndefined();
    expect(result.errors.base_seed).toBeUndefined();
  });

  it("blocks unstable queues to match node validation", () => {
    const result = validateRun({ ...validRun, lambda: 1 });
    expect(result.errors.lambda).toMatch(/less than mu/);
    expect(result.theoretical).toBeNull();
  });

  it("rejects invalid replication bounds and warns for small samples", () => {
    expect(validateRun({ ...validRun, replications: 1 }).errors.replications).toBeDefined();
    const result = validateRun({ ...validRun, replications: 12 });
    expect(result.errors.replications).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects missing, non-finite, negative, and inconsistent values", () => {
    const result = validateRun({
      ...validRun,
      lambda: Number.NaN,
      mu: -1,
      sim_time: 100,
      warmup_time: 100,
      tolerance_pct: 0,
      base_seed: Number.NaN,
    });
    expect(result.errors.lambda).toBeDefined();
    expect(result.errors.mu).toBeDefined();
    expect(result.errors.warmup_time).toMatch(/less than/);
    expect(result.errors.tolerance_pct).toBeDefined();
    expect(result.errors.base_seed).toBeDefined();
  });

  it("rejects seeds outside the exact JavaScript integer range", () => {
    const result = validateRun({ ...validRun, base_seed: Number.MAX_SAFE_INTEGER });
    expect(result.errors.base_seed).toBeDefined();
  });
});