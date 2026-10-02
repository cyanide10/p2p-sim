import type { RunParameters } from "../api/types";

export type RunField = keyof Omit<RunParameters, "serial_baseline">;
export type FieldErrors = Partial<Record<RunField, string>>;

export interface RunValidation {
  errors: FieldErrors;
  warnings: string[];
  rho: number | null;
  theoretical: { W: number; L: number } | null;
}

export function validateRun(params: RunParameters): RunValidation {
  const errors: FieldErrors = {};
  const warnings: string[] = [];
  const values: Array<[RunField, number]> = [
    ["replications", params.replications],
    ["lambda", params.lambda],
    ["mu", params.mu],
    ["sim_time", params.sim_time],
    ["warmup_time", params.warmup_time],
    ["tolerance_pct", params.tolerance_pct],
    ["base_seed", params.base_seed],
  ];

  for (const [field, value] of values) {
    if (!Number.isFinite(value)) errors[field] = "Enter a finite number.";
  }

  if (Number.isFinite(params.replications)) {
    if (!Number.isInteger(params.replications) || params.replications < 2 || params.replications > 100_000) {
      errors.replications = "Use a whole number from 2 to 100,000.";
    } else if (params.replications < 30) {
      warnings.push("The normal-approximation confidence interval is less reliable below 30 replications.");
    }
  }
  if (Number.isFinite(params.lambda) && params.lambda <= 0) errors.lambda = "Lambda must be greater than zero.";
  if (Number.isFinite(params.mu) && params.mu <= 0) errors.mu = "Mu must be greater than zero.";
  if (Number.isFinite(params.lambda) && Number.isFinite(params.mu) && params.lambda > 0 && params.mu > 0 && params.lambda >= params.mu) {
    errors.lambda = "Lambda must be less than mu; the node rejects unstable queues.";
  }
  if (Number.isFinite(params.sim_time) && params.sim_time <= 0) errors.sim_time = "Simulation time must be greater than zero.";
  if (Number.isFinite(params.warmup_time) && params.warmup_time < 0) errors.warmup_time = "Warmup time cannot be negative.";
  if (Number.isFinite(params.sim_time) && Number.isFinite(params.warmup_time) && params.warmup_time >= params.sim_time) {
    errors.warmup_time = "Warmup time must be less than simulation time.";
  }
  if (Number.isFinite(params.tolerance_pct) && params.tolerance_pct <= 0) errors.tolerance_pct = "Tolerance must be greater than zero.";
  if (Number.isFinite(params.base_seed) && (!Number.isSafeInteger(params.base_seed) || params.base_seed < 0 || params.base_seed > Number.MAX_SAFE_INTEGER - params.replications)) {
    errors.base_seed = "Seed must be a nonnegative safe integer with room for every replication.";
  }

  const rho = Number.isFinite(params.lambda) && Number.isFinite(params.mu) && params.mu > 0
    ? params.lambda / params.mu
    : null;
  const theoretical = rho !== null && rho >= 0 && rho < 1 && params.lambda > 0
    ? { W: 1 / (params.mu - params.lambda), L: rho / (1 - rho) }
    : null;

  return { errors, warnings, rho, theoretical };
}

export function randomSeed(replications: number): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % (Number.MAX_SAFE_INTEGER - replications);
}