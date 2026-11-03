import { describe, expect, it } from "vitest";
import {
  ATTACK_ORDER, ATTACK_SCENARIOS, DEFAULT_DURATION, SAMPLE_STEP, VIEW_H, VIEW_W, attackRunFromMetrics,
  buildAttackPaths, buildAttackRun, buildAttackScenario, buildTopology, compact, getScenario,
  normalizeConfig, percent, phaseFor, sampleAt,
} from "./attack";

describe("normalizeConfig", () => {
  it("clamps every input into the supported range", () => {
    const loose = normalizeConfig({ kind: "ddos", seed: -1, duration: 5, scale: 1, intensity: 99, capacity: 1_000, defense: 400 });
    expect(loose.seed).toBe(2026);
    expect(loose.duration).toBe(30);
    expect(loose.scale).toBe(500);
    expect(loose.intensity).toBe(10);
    expect(loose.capacity).toBe(ATTACK_SCENARIOS.ddos.defaultCapacity * 8);
    expect(loose.defense).toBe(100);

    const negative = normalizeConfig({ kind: "worm", duration: -20, scale: -1, intensity: -4, capacity: -2, defense: -1 });
    expect(negative.duration).toBe(30);
    expect(negative.scale).toBe(500);
    expect(negative.intensity).toBe(1);
    expect(negative.capacity).toBe(0.05);
    expect(negative.defense).toBe(0);
  });

  it("uses scenario defaults for missing values", () => {
    for (const kind of ATTACK_ORDER) {
      const config = normalizeConfig({ kind });
      expect(config.scale).toBe(getScenario(kind).defaultScale);
      expect(config.intensity).toBe(getScenario(kind).defaultIntensity);
      expect(config.capacity).toBe(getScenario(kind).defaultCapacity);
    }
  });

  it("rejects fractional seeds", () => {
    expect(normalizeConfig({ kind: "exfil", seed: 12.5 }).seed).toBe(2026);
  });
});

describe("buildTopology", () => {
  it("builds a deterministic, fully-connected map inside the viewport", () => {
    const first = buildTopology(2026, 48_000);
    expect(buildTopology(2026, 48_000)).toEqual(first);

    const ids = new Set(first.nodes.map((node) => node.id));
    expect(ids.size).toBe(first.nodes.length);
    expect(first.nodes.filter((node) => node.role === "bot")).toHaveLength(21);
    expect(first.nodes.filter((node) => node.role === "endpoint")).toHaveLength(6);
    expect(first.nodes.filter((node) => node.role === "service")).toHaveLength(6);
    expect(first.nodes.filter((node) => node.role === "edge")).toHaveLength(3);

    for (const node of first.nodes) {
      expect(node.x).toBeGreaterThan(0);
      expect(node.x).toBeLessThan(VIEW_W);
      expect(node.y).toBeGreaterThan(0);
      expect(node.y).toBeLessThan(VIEW_H);
      expect(node.units).toBeGreaterThan(0);
    }
    for (const link of first.links) {
      expect(ids.has(link.a)).toBe(true);
      expect(ids.has(link.b)).toBe(true);
      expect(link.a).not.toBe(link.b);
    }
    expect(new Set(first.links.map((link) => link.id)).size).toBe(first.links.length);
  });

  it("represents the requested scale with clustered units", () => {
    const topology = buildTopology(7, 60_000);
    const endpointUnits = topology.nodes.filter((node) => node.role === "endpoint").reduce((sum, node) => sum + node.units, 0);
    const botUnits = topology.nodes.filter((node) => node.role === "bot").reduce((sum, node) => sum + node.units, 0);
    expect(endpointUnits).toBeGreaterThanOrEqual(59_000);
    expect(botUnits).toBeGreaterThanOrEqual(59_000);
  });

  it("produces attack paths that only reference existing nodes", () => {
    const topology = buildTopology(2026, 48_000);
    const paths = buildAttackPaths(topology.nodes, topology.links);
    const ids = new Set(topology.nodes.map((node) => node.id));
    expect(paths.map((group) => group.length)).toEqual([21, 21, 6, 13]);
    for (const group of paths) {
      for (const path of group) {
        expect(path.nodes.length).toBeGreaterThanOrEqual(2);
        expect(path.weight).toBeGreaterThan(0);
        for (const id of path.nodes) expect(ids.has(id)).toBe(true);
      }
    }
  });
});

describe("buildAttackRun", () => {
  it("is deterministic for the same configuration", () => {
    const first = buildAttackRun({ kind: "worm", seed: 42, defense: 40 });
    const second = buildAttackRun({ kind: "worm", seed: 42, defense: 40 });
    expect(second.samples).toEqual(first.samples);
    expect(second.events).toEqual(first.events);
    expect(second.summary).toEqual(first.summary);
    expect(second.paths).toEqual(first.paths);
  });

  it("covers the whole campaign at a fixed sample step", () => {
    const run = buildAttackRun({ kind: "ddos" });
    expect(run.config.duration).toBe(DEFAULT_DURATION);
    expect(run.samples[0].t).toBe(0);
    expect(run.samples.at(-1)?.t).toBe(DEFAULT_DURATION);
    expect(run.samples).toHaveLength(DEFAULT_DURATION / run.step + 1);
    expect(run.events.length).toBeGreaterThan(0);
    expect(run.events.every((event, index) => index === 0 || event.t >= run.events[index - 1].t)).toBe(true);
  });

  it("overloads the target during a DDoS flood", () => {
    const run = buildAttackRun({ kind: "ddos", defense: 0 });
    expect(run.summary.peakLoadRatio).toBeGreaterThan(1.5);
    expect(run.summary.peakThreat).toBeGreaterThan(60);
    expect(run.summary.timeAboveCapacity).toBeGreaterThan(30);
    expect(run.summary.peakImpact).toBeGreaterThan(20);
    expect(run.samples.some((sample) => sample.targetState === "critical" || sample.targetState === "offline")).toBe(true);
  });

  it("lets defensive posture shorten the outage and cut average damage", () => {
    const average = (run: ReturnType<typeof buildAttackRun>, pick: (sample: (typeof run.samples)[number]) => number) =>
      run.samples.reduce((sum, sample) => sum + pick(sample), 0) / run.samples.length;

    for (const kind of ["ddos", "synflood"] as const) {
      const exposed = buildAttackRun({ kind, defense: 0 });
      const defended = buildAttackRun({ kind, defense: 100 });
      // Mitigation engages after the flood peaks, so compare the whole campaign.
      expect(average(defended, (sample) => sample.attackLoad)).toBeLessThan(average(exposed, (sample) => sample.attackLoad));
      expect(average(defended, (sample) => sample.impact)).toBeLessThan(average(exposed, (sample) => sample.impact));
      expect(defended.summary.timeAboveCapacity).toBeLessThan(exposed.summary.timeAboveCapacity);
      expect(defended.summary.blockedPct).toBeGreaterThan(exposed.summary.blockedPct);
    }
  });

  it("spreads a worm through the estate and contains it with defence", () => {
    const run = buildAttackRun({ kind: "worm", defense: 0 });
    expect(run.summary.peakCompromised).toBeGreaterThan(run.config.scale * 0.8);
    expect(run.samples.every((sample, index) => index === 0 || sample.compromised >= run.samples[index - 1].compromised - 1e-6)).toBe(true);

    const contained = buildAttackRun({ kind: "worm", defense: 100 });
    expect(contained.summary.peakCompromised).toBeLessThan(run.summary.peakCompromised);
  });

  it("accumulates exfiltrated data and blocks more of it with defence", () => {
    const run = buildAttackRun({ kind: "exfil", defense: 0 });
    expect(run.samples.every((sample, index) => index === 0 || sample.impact >= run.samples[index - 1].impact)).toBe(true);
    expect(run.summary.exfiltratedGb).toBeGreaterThan(5);
    expect(run.summary.exfiltratedGb).toBe(run.samples.at(-1)?.impact);

    const defended = buildAttackRun({ kind: "exfil", defense: 100 });
    expect(defended.summary.exfiltratedGb).toBeLessThan(run.summary.exfiltratedGb);
  });

  it("clamps sampling to the campaign window", () => {
    const run = buildAttackRun({ kind: "synflood" });
    expect(sampleAt(run, -100).t).toBe(0);
    expect(sampleAt(run, 1_000_000).t).toBe(run.config.duration);
    expect(sampleAt(run, 100).t).toBeCloseTo(100, 5);
    expect(sampleAt(run, 0).nodes).toBeDefined();
    expect(sampleAt(run, 0).nodes.dc).toBeDefined();
  });
});

describe("wire scenario and remote metrics", () => {
  it("serializes the campaign inputs and topology tokens for the nodes", () => {
    const config = normalizeConfig({ kind: "exfil", seed: 11, scale: 9_000, intensity: 4, capacity: 2.5, defense: 35 });
    const wire = buildAttackScenario(config);
    const topology = buildTopology(config.seed, config.scale);

    expect(wire.kind).toBe("exfil");
    expect(wire.duration).toBe(config.duration);
    expect(wire.step).toBe(SAMPLE_STEP);
    expect(wire.seed).toBe(config.seed);
    expect(wire.capacity).toBe(config.capacity);
    expect(wire.phases).toEqual(getScenario("exfil").phases.map((phase) => ({ id: phase.id, at: phase.at })));
    expect(wire.nodes.map((node) => node.id)).toEqual(topology.nodes.map((node) => node.id));
    expect(wire.nodes.map((node) => node.role)).toEqual(topology.nodes.map((node) => node.role));
    // The node model only needs numbers and strings: no presentation metadata leaks in.
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    expect(wire.nodes.every((node, index) => node.index === index)).toBe(true);
  });

  it("rebuilds the local presentation model from node metrics", () => {
    const local = buildAttackRun({ kind: "worm", seed: 42, defense: 40 });
    const imported = attackRunFromMetrics(local.config, {
      kind: local.config.kind,
      duration: local.config.duration,
      step: local.step,
      samples: local.samples,
      summary: local.summary,
    });

    expect(imported.samples).toEqual(local.samples);
    expect(imported.summary).toEqual(local.summary);
    expect(imported.topology).toEqual(local.topology);
    expect(imported.paths).toEqual(local.paths);
    expect(imported.events.length).toBeGreaterThan(0);
  });
});

describe("phaseFor", () => {
  it("walks the scenario phases in order", () => {
    const scenario = getScenario("ddos");
    expect(phaseFor(scenario, 0).id).toBe("recon");
    expect(phaseFor(scenario, 0.2).id).toBe("flood");
    expect(phaseFor(scenario, 0.7).id).toBe("scrub");
    expect(phaseFor(scenario, 1).id).toBe("recover");
    expect(phaseFor(scenario, 5).id).toBe("recover");
  });
});

describe("formatting", () => {
  it("compacts large numbers and clamps percentages", () => {
    expect(compact(950)).toBe("950");
    expect(compact(12_500)).toBe("12.5K");
    expect(compact(2_400_000)).toBe("2.4M");
    expect(compact(Number.NaN)).toBe("--");
    expect(percent(42.4, 1)).toBe("42.4%");
    expect(percent(-10)).toBe("0%");
    expect(percent(180)).toBe("100%");
  });
});
