import { CircleDot, LoaderCircle, Network, Play } from "lucide-react";
import type { PartitionPlan } from "../api/types";
import { NetworkNumberInput } from "./NetworkNumberInput";
import { PanelTitle } from "./PagePrimitives";
import type { GridOptions } from "../lib/network";
import { splitOutlook } from "../lib/pdes";

interface Props {
  grid: Omit<GridOptions, "seed">;
  onGrid: (value: Omit<GridOptions, "seed">) => void;
  parts: number;
  onParts: (value: number) => void;
  seed: number;
  onSeed: (value: number) => void;
  advancedOpen: boolean;
  onAdvancedOpen: (open: boolean) => void;
  baseline: boolean;
  onBaseline: (value: boolean) => void;
  healthyCount: number;
  maxParts: number;
  coordinator: string;
  hasErrors: boolean;
  partitionPlan: PartitionPlan | null;
  planning: boolean;
  submitting: boolean;
  onGenerate: () => void;
  onPreview: () => void;
  onRun: () => void;
  /** Packets one copy of the current network offers, for the speed outlook. */
  offeredPackets: number;
}

export function NetworkPdesPanel({
  grid, onGrid, parts, onParts, seed, onSeed, advancedOpen, onAdvancedOpen,
  baseline, onBaseline, healthyCount, maxParts, coordinator, hasErrors,
  partitionPlan, planning, submitting, onGenerate, onPreview, onRun, offeredPackets,
}: Props) {
  const outlook = partitionPlan ? splitOutlook(offeredPackets, partitionPlan.windows) : null;
  const updateGrid = (patch: Partial<Omit<GridOptions, "seed">>) => onGrid({ ...grid, ...patch });
  return (
    <section className="pdes-launch-panel" aria-labelledby="pdes-launch-heading">
      <PanelTitle
        id="pdes-launch-heading"
        eyebrow="PARTITIONED EXECUTION (PDES)"
        title="Split one copy across your nodes"
        tone="pdes"
      />
      <p className="net-help pdes-intro">Runs the network on the canvas as a single simulation, with each node simulating one region of it. Preview the split first, then run it.</p>
      <div className="pdes-controls">
        <label className="net-field"><span>Partitions</span><select value={parts} onChange={(event) => onParts(Number(event.target.value))}>
          {Array.from({ length: Math.max(1, maxParts) }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label className="toggle-row"><input type="checkbox" checked={baseline} onChange={(event) => onBaseline(event.target.checked)} /><span className="toggle-copy"><strong>Also run it on one node</strong><small>Checks the results match and measures the speedup.</small></span></label>
        <button type="button" className="ghost-button" onClick={onPreview} disabled={planning || hasErrors || !coordinator || maxParts < 1 || parts > maxParts}>
          {planning ? <LoaderCircle size={15} className="button-spin" /> : <CircleDot size={15} />}1. Preview split
        </button>
        <button type="button" className="primary-button" onClick={onRun} disabled={!partitionPlan || submitting || hasErrors || !coordinator}
          title={partitionPlan ? undefined : "Preview the split first"}>
          {submitting ? <LoaderCircle size={15} className="button-spin" /> : <Play size={15} fill="currentColor" />}2. Run partitioned
        </button>
      </div>
      <p className="pdes-plan-note">{healthyCount} healthy nodes · up to {maxParts} partitions{partitionPlan ? "" : " · the canvas colours each node by partition after a preview"}</p>
      {partitionPlan && <div className="pdes-plan-summary" role="status">
        <span><strong>Lookahead</strong> {partitionPlan.lookahead.toPrecision(4)} s</span>
        <span><strong>Windows</strong> {partitionPlan.windows.toLocaleString()}</span>
        <span><strong>Cut links</strong> {partitionPlan.cut_links.length ? partitionPlan.cut_links.join(", ") : "none"}</span>
        <span><strong>Routers per node</strong> {partitionPlan.load.join(" / ")}</span>
      </div>}
      {outlook && <p className={`pdes-outlook pdes-outlook-${outlook.kind}`} role="status">
        {outlook.kind === "slower" && <>Likely <strong>slower than one node</strong>: each window holds about {outlook.perWindow.toFixed(1)} packets, so the nodes spend their time waiting for each other. Try fewer partitions, or a network whose regions are joined by slow links (Three-site WAN sample).</>}
        {outlook.kind === "even" && <>Likely <strong>about as fast as one node</strong>: each window holds about {outlook.perWindow.toFixed(0)} packets. More traffic, or slower links between regions, would help.</>}
        {outlook.kind === "faster" && <>Likely <strong>faster than one node</strong>: each window holds about {outlook.perWindow.toFixed(0)} packets of work. Separate machines add network delay to every window, so measure it with the one-node check.</>}
      </p>}
      <details className="pdes-advanced" open={advancedOpen}>
        <summary onClick={(event) => { event.preventDefault(); onAdvancedOpen(!advancedOpen); }}>Need a bigger network? Generate a grid</summary>
        <p className="net-help">Replaces the network on the canvas with a grid or torus of routers and random host-to-host flows. The same seed always generates the same traffic.</p>
        <div className="pdes-generator-grid">
          <label className="net-field"><span>Layout</span><select value={grid.topology} onChange={(event) => updateGrid({ topology: event.target.value as GridOptions["topology"] })}><option value="grid">Grid</option><option value="torus">Torus</option></select></label>
          <NetworkNumberInput label="Router rows" value={grid.rows} onChange={(value) => updateGrid({ rows: Math.round(value) })} min={2} step="1" />
          <NetworkNumberInput label="Router columns" value={grid.columns} onChange={(value) => updateGrid({ columns: Math.round(value) })} min={2} step="1" />
          <NetworkNumberInput label="Hosts / router" value={grid.hostsPerRouter} onChange={(value) => updateGrid({ hostsPerRouter: Math.round(value) })} min={1} step="1" />
          <NetworkNumberInput label="Flows" value={grid.flowCount} onChange={(value) => updateGrid({ flowCount: Math.round(value) })} min={1} step="1" />
          <NetworkNumberInput label="Flow rate (pkt/s)" value={grid.flowRate} onChange={(value) => updateGrid({ flowRate: value })} min={0.01} />
          <NetworkNumberInput label="Bandwidth (pkt/s)" value={grid.bandwidth} onChange={(value) => updateGrid({ bandwidth: value })} min={0.01} />
          <NetworkNumberInput label="Link delay (s)" value={grid.delay} onChange={(value) => updateGrid({ delay: value })} min={0} />
          <NetworkNumberInput label="Router service rate" value={grid.serviceRate} onChange={(value) => updateGrid({ serviceRate: value })} min={0.01} />
          <NetworkNumberInput label="Router buffer" value={grid.buffer} onChange={(value) => updateGrid({ buffer: Math.round(value) })} min={1} step="1" />
          <NetworkNumberInput label="Length (s)" value={grid.duration} onChange={(value) => updateGrid({ duration: value })} min={1} />
          <NetworkNumberInput label="Seed" value={seed} onChange={onSeed} min={0} step="1" />
        </div>
        <button className="ghost-button pdes-generate" type="button" onClick={onGenerate}><Network size={15} />Generate and replace canvas</button>
      </details>
    </section>
  );
}
