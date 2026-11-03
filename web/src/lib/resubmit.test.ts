import { describe, expect, it } from "vitest";
import type { AttackScenarioWire } from "./attack";
import type { RunCreated, RunParameters } from "../api/types";
import type { Scenario } from "./network";
import { startRun } from "./resubmit";

const created: RunCreated = { run_id: "r", batch_id: "b", status: "started", coordinator: "node-2", replications: 30, base_seed: 7, peers: 3 };
const scenario: Scenario = { duration: 60, nodes: [], links: [], flows: [], events: [] };
const attack: AttackScenarioWire = {
  kind: "ddos", duration: 300, step: 0.5, seed: 7, scale: 48_000, intensity: 5,
  capacity: 40, defense: 60, phases: [{ id: "recon", at: 0 }],
  nodes: [{ id: "dc", index: 0, role: "target", units: 1 }],
};
const mm1: RunParameters = { replications: 50, lambda: 0.8, mu: 1, sim_time: 1000, warmup_time: 100, tolerance_pct: 10, base_seed: 7, serial_baseline: false };
// The gateway records network runs with zeroed M/M/1 fields.
const network: RunParameters = { kind: "network", scenario, replications: 30, lambda: 0, mu: 0, sim_time: 0, warmup_time: 0, tolerance_pct: 0, base_seed: 7, serial_baseline: false };
const attackRun: RunParameters = { kind: "attack", scenario: attack, parts: 2, baseline: false, replications: 0, lambda: 0, mu: 0, sim_time: 0, warmup_time: 0, tolerance_pct: 0, base_seed: 7, serial_baseline: false };

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    api: {
      createRun: async (coordinator: string, params: RunParameters) => { calls.push(`mm1 ${coordinator} ${params.lambda}`); return created; },
      createNetworkRun: async (coordinator: string, sc: Scenario, replications: number, baseSeed: number) => {
        calls.push(`network ${coordinator} ${sc.duration} ${replications} ${baseSeed}`);
        return created;
      },
      createPDESRun: async (coordinator: string, sc: Scenario, parts: number, baseSeed: number, baseline: boolean) => {
        calls.push(`pdes ${coordinator} ${sc.duration} ${parts} ${baseSeed} ${baseline}`);
        return created;
      },
      createAttackRun: async (coordinator: string, sc: AttackScenarioWire, parts: number, baseSeed: number, baseline: boolean) => {
        calls.push(`attack ${coordinator} ${sc.kind} ${parts} ${baseSeed} ${baseline}`);
        return created;
      },
    },
  };
}

describe("startRun", () => {
  it("resubmits a network run as a network batch with the same scenario, size and seed", async () => {
    const { api, calls } = recorder();
    await startRun(api, "node-2", network);
    expect(calls).toEqual(["network node-2 60 30 7"]);
  });

  it("submits M/M/1 parameters as an M/M/1 batch", async () => {
    const { api, calls } = recorder();
    await startRun(api, "node-2", mm1);
    expect(calls).toEqual(["mm1 node-2 0.8"]);
  });

  it("resubmits a partitioned run with the same scenario, part count and seed", async () => {
    const { api, calls } = recorder();
    await startRun(api, "node-2", { ...network, kind: "pdes", parts: 3, baseline: false });
    expect(calls).toEqual(["pdes node-2 60 3 7 false"]);
  });

  it("resubmits a threat campaign with the same campaign, part count and seed", async () => {
    const { api, calls } = recorder();
    await startRun(api, "node-2", attackRun);
    expect(calls).toEqual(["attack node-2 ddos 2 7 false"]);
  });

  it("refuses a network run whose scenario was not recorded", async () => {
    const { api, calls } = recorder();
    await expect(startRun(api, "node-2", { ...network, scenario: undefined })).rejects.toThrow(/scenario/);
    expect(calls).toEqual([]);
  });
});
