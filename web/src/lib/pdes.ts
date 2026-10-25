import type { PartitionTiming } from "../api/types";

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
