import type { Band, PartitionPlan, PartitionTiming, PDESLiveLoad } from "../api/types";
import type { Scenario } from "./network";

export interface PartitionBreakdown {
  rows: Array<{ id: string; compute: number; wait: number; messages: number; bytes: number }>;
  totalCompute: number;
  totalWait: number;
  maxTotal: number;
}

export function partitionClassForNode(nodeId: string, assignment: Record<string, number>): string {
  const part = assignment[nodeId];
  return Number.isInteger(part) && part >= 0 ? `partition-${part % 6}` : "";
}

/** Compute and barrier-wait bar widths as percentages of the widest partition. */
export function partitionBarWidths(compute: number, wait: number, maxTotal: number): { compute: number; wait: number } {
  const scale = maxTotal > 0 ? maxTotal : 1;
  return {
    compute: (Math.max(0, compute) / scale) * 100,
    wait: (Math.max(0, wait) / scale) * 100,
  };
}

export function partitionBreakdown(partitions: Record<string, PartitionTiming>): PartitionBreakdown {
  const rows = Object.entries(partitions)
    .map(([id, timing]) => ({
      id,
      compute: Math.max(0, timing.compute_s),
      wait: Math.max(0, timing.wait_s),
      messages: timing.messages,
      bytes: timing.bytes,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const totalCompute = rows.reduce((sum, row) => sum + row.compute, 0);
  const totalWait = rows.reduce((sum, row) => sum + row.wait, 0);
  return {
    rows,
    totalCompute,
    totalWait,
    maxTotal: Math.max(0, ...rows.map((row) => row.compute + row.wait)),
  };
}

/** A single run's series as a chart band with no spread (PDES produces one run, not many copies). */
export function singleBand(values: Array<number | null>): Band {
  return { mean: [...values], low: [...values], high: [...values] };
}

export interface PartitionOwner {
  part: number;
  /** The node that simulated this partition, when the coordinator reported it. */
  node: string;
  routers: number;
  hosts: number;
}

/** Which node simulated which partition, and how much of the network each one held. */
export function partitionOwners(plan: PartitionPlan, scenario: Scenario, participants: string[] = []): PartitionOwner[] {
  const kinds = new Map(scenario.nodes.map((node) => [node.id, node.kind]));
  return Array.from({ length: plan.parts }, (_, part) => {
    const members = Object.entries(plan.assignment).filter(([, owner]) => owner === part).map(([id]) => id);
    return {
      part,
      node: participants[part] ?? `partition ${part + 1}`,
      routers: members.filter((id) => kinds.get(id) === "router").length,
      hosts: members.filter((id) => kinds.get(id) === "host").length,
    };
  });
}

type Heat = Record<string, { value: number; detail: string }>;

/**
 * Map colours for a partitioned run: load from the latest live sample (or the
 * final metrics), and, for cut links, how many packets crossed between nodes.
 */
export function partitionHeat(
  load: { links: Record<string, { util: number; queue?: number }>; routers: Record<string, { util: number; queue?: number }> },
  cutTraffic: Record<string, number> = {},
): { links: Heat; routers: Heat } {
  const describe = (util: number, queue?: number) => `load ${(util * 100).toFixed(0)}%${queue ? ` · ${queue} queued` : ""}`;
  const links: Heat = {};
  for (const [id, station] of Object.entries(load.links)) {
    const crossed = cutTraffic[id];
    links[id] = { value: station.util, detail: `${describe(station.util, station.queue)}${crossed ? ` · ${crossed.toLocaleString()} packets crossed between nodes` : ""}` };
  }
  for (const [id, crossed] of Object.entries(cutTraffic)) {
    if (!links[id]) links[id] = { value: 0, detail: `${crossed.toLocaleString()} packets crossed between nodes` };
  }
  const routers: Heat = {};
  for (const [id, station] of Object.entries(load.routers)) routers[id] = { value: station.util, detail: describe(station.util, station.queue) };
  return { links, routers };
}

/** Final link and router utilization from merged PDES metrics, in the live-load shape. */
export function metricsLoad(metrics: { links: Record<string, Record<string, number | null>>; routers: Record<string, Record<string, number | null>> }): Pick<PDESLiveLoad, "links" | "routers"> {
  const pick = (table: Record<string, Record<string, number | null>>) =>
    Object.fromEntries(Object.entries(table).map(([id, row]) => [id, { util: row.utilization ?? 0, queue: 0 }]));
  return { links: pick(metrics.links), routers: pick(metrics.routers) };
}

/**
 * Rough outlook for a split run from the packets each synchronization window
 * holds. Calibrated on a 3-node Docker cluster (one machine): about 0.6 packets
 * per window ran 9x slower, 28 broke even and 45 ran 1.2x faster. Separate
 * machines add network latency to every window, so the bar is higher there.
 */
export function splitOutlook(offeredPackets: number, windows: number): { kind: "slower" | "even" | "faster"; perWindow: number } {
  const perWindow = windows > 0 ? offeredPackets / windows : 0;
  return { kind: perWindow < 20 ? "slower" : perWindow < 40 ? "even" : "faster", perWindow };
}
