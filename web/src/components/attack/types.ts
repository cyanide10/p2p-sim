import type { AttackReport, AttackStatus } from "../../api/types";
import type { AttackConfig } from "../../lib/attack";

export type ExecutionMode = "local" | "worker" | "pdes";

export interface PoolNode {
  id: string;
  healthy: boolean;
}

export interface RemoteCampaign {
  runId: string;
  config: AttackConfig;
  status: AttackStatus | null;
  report: AttackReport | null;
}
