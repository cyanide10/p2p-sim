import { CircleDot, LoaderCircle, Network, Play } from "lucide-react";
import type { PartitionPlan } from "../api/types";
import { NetworkNumberInput } from "./NetworkNumberInput";
import { PanelTitle } from "./PagePrimitives";
import type { GridOptions } from "../lib/network";

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
}

export function NetworkPdesPanel({
  grid, onGrid, parts, onParts, seed, onSeed, advancedOpen, onAdvancedOpen,
  baseline, onBaseline, healthyCount, maxParts, coordinator, hasErrors,
  partitionPlan, planning, submitting, onGenerate, onPreview, onRun,
}: Props) {
  const updateGrid = (patch: Partial<Omit<GridOptions, "seed">>) => onGrid({ ...grid, ...patch });
  return (
    <section className="pdes-launch-panel" aria-labelledby="pdes-launch-heading">
      <PanelTitle
        id="pdes-launch-heading"
        eyebrow="PARTITIONED EXECUTION"
        title="Generate a grid and run PDES"
        tone="pdes"
        action={<button className="ghost-button" type="button" onClick={onGenerate}><Network size={15} />Generate grid</button>}
      />
      <div className="pdes-generator-grid pdes-generator-primary">
        <NetworkNumberInput label="Run length (s)" value={grid.duration} onChange={(value) => updateGrid({ duration: value })} min={1} />
        <label className="net-field"><span>Partitions</span><select value={parts} onChange={(event) => onParts(Number(event.target.value))}>
          {Array.from({ length: Math.max(1, maxParts) }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </div>
      <details className="pdes-advanced" open={advancedOpen}>
        <summary onClick={(event) => { event.preventDefault(); onAdvancedOpen(!advancedOpen); }}>Advanced generator settings</summary>
        <div className="pdes-generator-grid">
          <label className="net-field"><span>Layout</span><select value={grid.topology} onChange={(event) => updateGrid({ topology: event.target.value as GridOptions["topology"] })}><option value="grid">Grid</option><option value="torus">Torus</option></select></label>
          <NetworkNumberInput label="Router rows" value={grid.rows} onChange={(value) => updateGrid({ rows: Math.round(value) })} min={2} step="1" />
          <NetworkNumberInput label="Router columns" value={grid.columns} onChange={(value) => updateGrid({ columns: Math.round(value) })} min={2} step="1" />
          <NetworkNumberInput label="Hosts / router" value={grid.hostsPerRouter} onChange={(value) => updateGrid({ hostsPerRouter: Math.round(value) })} min={1} step="1" />
          <NetworkNumberInput label="Flows" value={grid.flowCount} onChange={(value) => updateGrid({ flowCount: Math.round(value) })} min={1} step="1" />
          <NetworkNumberInput label="Flow rate" value={grid.flowRate} onChange={(value) => updateGrid({ flowRate: value })} min={0.01} />
          <NetworkNumberInput label="Bandwidth" value={grid.bandwidth} onChange={(value) => updateGrid({ bandwidth: value })} min={0.01} />
          <NetworkNumberInput label="Link delay (s)" value={grid.delay} onChange={(value) => updateGrid({ delay: value })} min={0} />
          <NetworkNumberInput label="Router service rate" value={grid.serviceRate} onChange={(value) => updateGrid({ serviceRate: value })} min={0.01} />
          <NetworkNumberInput label="Router buffer" value={grid.buffer} onChange={(value) => updateGrid({ buffer: Math.round(value) })} min={1} step="1" />
          <NetworkNumberInput label="Seed" value={seed} onChange={onSeed} min={0} step="1" />
        </div>
      </details>
      <div className="pdes-controls">
        <label className="toggle-row"><input type="checkbox" checked={baseline} onChange={(event) => onBaseline(event.target.checked)} /><span className="toggle-copy"><strong>Run serial baseline</strong><small>Compare merged results with one-process execution.</small></span></label>
        <button type="button" className="ghost-button" onClick={onPreview} disabled={planning || hasErrors || !coordinator || maxParts < 1 || parts > maxParts}>
          {planning ? <LoaderCircle size={15} className="button-spin" /> : <CircleDot size={15} />}Preview plan
        </button>
        <button type="button" className="primary-button" onClick={onRun} disabled={!partitionPlan || submitting || hasErrors || !coordinator}>
          {submitting ? <LoaderCircle size={15} className="button-spin" /> : <Play size={15} fill="currentColor" />}Run partitioned
        </button>
      </div>
      <p className="pdes-plan-note">{healthyCount} healthy nodes · max {maxParts} partitions · same seed {seed} reproduces this generated traffic matrix.</p>
      {partitionPlan && <div className="pdes-plan-summary" role="status">
        <span><strong>Lookahead</strong> {partitionPlan.lookahead.toPrecision(4)} s</span>
        <span><strong>Windows</strong> {partitionPlan.windows.toLocaleString()}</span>
        <span><strong>Cut links</strong> {partitionPlan.cut_links.length ? partitionPlan.cut_links.join(", ") : "none"}</span>
        <span><strong>Load</strong> {partitionPlan.load.join(" / ")}</span>
      </div>}
    </section>
  );
}
