import type { PartitionPlan } from "../api/types";
import type { Scenario } from "../lib/network";
import { partitionHeat, partitionOwners } from "../lib/pdes";
import { TopologyCanvas } from "./TopologyCanvas";

interface Props {
  scenario: Scenario;
  plan: PartitionPlan;
  participants?: string[];
  /** Link and router utilization to colour the map with (live sample or final metrics). */
  load?: { links: Record<string, { util: number; queue?: number }>; routers: Record<string, { util: number; queue?: number }> };
  cutTraffic?: Record<string, number>;
  caption?: string;
}

/**
 * The network as the nodes split it: each region outlined in its node's
 * colour, dashed links where packets cross between nodes, and load as fill.
 */
export function PartitionMap({ scenario, plan, participants, load, cutTraffic = {}, caption }: Props) {
  const owners = partitionOwners(plan, scenario, participants);
  const heat = partitionHeat(load ?? { links: {}, routers: {} }, cutTraffic);
  const crossed = Object.values(cutTraffic).reduce((sum, count) => sum + count, 0);
  return (
    <div className="partition-map">
      <ul className="partition-owners" aria-label="Which node simulates which part of the network">
        {owners.map((owner) => (
          <li key={owner.part}>
            <i className={`partition-swatch partition-${owner.part % 6}`} aria-hidden="true" />
            <strong>{owner.node}</strong>
            <span>{owner.routers} router{owner.routers === 1 ? "" : "s"} · {owner.hosts} host{owner.hosts === 1 ? "" : "s"}</span>
          </li>
        ))}
        <li className="partition-owners-cut">
          <i className="partition-cut-swatch" aria-hidden="true" />
          <span>{plan.cut_links.length} link{plan.cut_links.length === 1 ? "" : "s"} between nodes{crossed ? ` · ${crossed.toLocaleString()} packets crossed` : ""}</span>
        </li>
      </ul>
      {load && <div className="net-heat-legend" aria-hidden="true"><span>0%</span><i /><span>100% load</span></div>}
      <div className="net-canvas net-canvas-report">
        <TopologyCanvas scenario={scenario} mode="heat" heat={heat.links} routerHeat={heat.routers}
          partitionAssignment={plan.assignment} cutLinks={plan.cut_links} />
      </div>
      {caption && <p className="pdes-plan-note">{caption}</p>}
    </div>
  );
}
