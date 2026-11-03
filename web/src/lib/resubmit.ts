import type { ApiClient } from "../api/client";
import { isAttackScenario, isNetworkScenario, type RunCreated, type RunParameters } from "../api/types";

/** Starts a batch from recorded parameters, keeping the original kind. */
export function startRun(
  api: Pick<ApiClient, "createRun" | "createNetworkRun" | "createPDESRun" | "createAttackRun">,
  coordinator: string,
  params: RunParameters,
): Promise<RunCreated> {
  if (params.kind === "attack") {
    if (!isAttackScenario(params.scenario)) {
      return Promise.reject(new Error("This attack run has no recorded campaign to resubmit."));
    }
    return api.createAttackRun(
      coordinator, params.scenario, params.parts ?? 1, params.base_seed, params.baseline !== false,
    );
  }
  if (params.kind === "network" || params.kind === "pdes") {
    if (!isNetworkScenario(params.scenario)) {
      return Promise.reject(new Error("This run has no recorded scenario to resubmit."));
    }
    if (params.kind === "pdes") {
      if (params.parts == null) return Promise.reject(new Error("This partitioned run has no recorded part count to resubmit."));
      return api.createPDESRun(coordinator, params.scenario, params.parts, params.base_seed, params.baseline !== false);
    }
    return api.createNetworkRun(coordinator, params.scenario, params.replications, params.base_seed);
  }
  return api.createRun(coordinator, params);
}
