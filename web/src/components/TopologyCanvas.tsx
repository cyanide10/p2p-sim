import { useRef, useState } from "react";
import { DROP_MS, dropLabel, flowSlot, HOP_MS, type NetLiveState, type Scenario } from "../lib/network";

export type Tool = "select" | "host" | "router" | "link" | "delete";
export type Selection = { kind: "node" | "link"; id: string } | null;

export const VIEW_W = 1000;
export const VIEW_H = 640;
const CONGESTED = 0.85;

interface Props {
  scenario: Scenario;
  mode: "edit" | "live" | "heat";
  tool?: Tool;
  selected?: Selection;
  pendingLink?: string | null;
  onSelect?: (sel: Selection) => void;
  onPlace?: (x: number, y: number) => void;
  onMove?: (id: string, x: number, y: number) => void;
  onLinkEnd?: (id: string) => void;
  onDelete?: (sel: NonNullable<Selection>) => void;
  live?: NetLiveState;
  now?: number;
  flowIndex?: Record<string, number>;
  /** heat mode: mean utilization (0..1) per link, with an optional detail string for the tooltip */
  heat?: Record<string, { value: number; detail: string }>;
  routerHeat?: Record<string, { value: number; detail: string }>;
}

/** Neutral light-to-dark ramp for load (0..1); hue is reserved for flows. */
export function loadColor(u: number): string {
  const v = Math.max(0, Math.min(1, u));
  return `color-mix(in oklab, var(--load-high) ${Math.round(v * 100)}%, var(--load-low))`;
}

export function TopologyCanvas(props: Props) {
  const { scenario, mode, tool = "select", selected = null, pendingLink = null, live, now = 0, flowIndex = {}, heat, routerHeat } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const nodes = new Map(scenario.nodes.map((n) => [n.id, n]));
  const down = new Set(live?.down ?? []);
  const editing = mode === "edit";
  // Outside the editor, frame the network itself instead of the whole drawing area.
  let box = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };
  if (!editing && scenario.nodes.length) {
    const xs = scenario.nodes.map((n) => n.x), ys = scenario.nodes.map((n) => n.y);
    const pad = 70;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const w = Math.max(x1 - x0, 420), h = Math.max(y1 - y0, 260);
    box = { x: (x0 + x1 - w) / 2, y: (y0 + y1 - h) / 2, w, h };
  }

  const toView = (event: React.PointerEvent) => {
    const svg = svgRef.current!;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const p = point.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: Math.max(20, Math.min(VIEW_W - 20, p.x)), y: Math.max(20, Math.min(VIEW_H - 20, p.y)) };
  };

  const onBackground = (event: React.PointerEvent<SVGRectElement>) => {
    if (!editing) return;
    const { x, y } = toView(event);
    if (tool === "host" || tool === "router") props.onPlace?.(x, y);
    else props.onSelect?.(null);
  };

  const onNodeDown = (event: React.PointerEvent, id: string) => {
    if (!editing) return;
    event.stopPropagation();
    if (tool === "delete") return props.onDelete?.({ kind: "node", id });
    if (tool === "link") return props.onLinkEnd?.(id);
    props.onSelect?.({ kind: "node", id });
    if (tool === "select") {
      const node = nodes.get(id)!;
      const p = toView(event);
      setDrag({ id, dx: node.x - p.x, dy: node.y - p.y });
      (event.target as Element).setPointerCapture?.(event.pointerId);
    }
  };

  const onMove = (event: React.PointerEvent) => {
    if (!drag) return;
    const p = toView(event);
    props.onMove?.(drag.id, Math.round(p.x + drag.dx), Math.round(p.y + drag.dy));
  };

  const onLinkDown = (event: React.PointerEvent, id: string) => {
    if (!editing) return;
    event.stopPropagation();
    if (tool === "delete") props.onDelete?.({ kind: "link", id });
    else props.onSelect?.({ kind: "link", id });
  };

  return (
    <svg ref={svgRef} className={`topology topology-${mode} tool-${tool}`} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}
      role="img" aria-label={`Network with ${scenario.nodes.length} nodes and ${scenario.links.length} links`}>
      <rect className="topology-bg" x={box.x} y={box.y} width={box.w} height={box.h} onPointerDown={onBackground} />

      {scenario.links.map((l) => {
        const a = nodes.get(l.a), b = nodes.get(l.b);
        if (!a || !b) return null;
        const isDown = down.has(l.id) || down.has(l.a) || down.has(l.b);
        const load = mode === "live" ? live?.links[l.id]?.util ?? 0 : mode === "heat" ? heat?.[l.id]?.value ?? 0 : null;
        const width = load === null ? 3 : 3 + 9 * load;
        const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        const isSel = selected?.kind === "link" && selected.id === l.id;
        const title = mode === "heat" ? `${l.id}: ${heat?.[l.id]?.detail ?? "no data"}` :
          `${l.id} · ${l.bandwidth} pkt/s · ${(l.delay * 1000).toFixed(1)} ms${load !== null ? ` · load ${(load * 100).toFixed(0)}%` : ""}${isDown ? " · DOWN" : ""}`;
        return (
          <g key={l.id} className={`topo-link ${isDown ? "is-down" : ""} ${isSel ? "is-selected" : ""}`} onPointerDown={(e) => onLinkDown(e, l.id)}>
            <title>{title}</title>
            <line className="topo-link-hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            {isSel && <line className="topo-link-halo" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />}
            <line className="topo-link-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              style={{ strokeWidth: width, stroke: load === null || isDown ? undefined : loadColor(load) }} />
            {editing && <text className="topo-link-label" x={midX} y={midY - 8} textAnchor="middle">{l.id} · {l.bandwidth}/s</text>}
            {isDown && <text className="topo-down-label" x={midX} y={midY - 8} textAnchor="middle">✕ DOWN</text>}
          </g>
        );
      })}

      {mode === "live" && live?.moving.map((p) => {
        const a = nodes.get(p.from), b = nodes.get(p.to);
        if (!a || !b) return null;
        const f = Math.min(1, Math.max(0, (now - p.start) / HOP_MS));
        const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
        return <circle key={`${p.pkt}-${p.from}`} className="topo-packet" cx={x} cy={y} r={6} style={{ fill: flowSlot(flowIndex[p.flow] ?? 99) }} />;
      })}

      {scenario.nodes.map((n) => {
        const isDown = down.has(n.id);
        const isSel = selected?.kind === "node" && selected.id === n.id;
        const isPending = pendingLink === n.id;
        const routerLive = mode === "live" ? live?.routers[n.id] : undefined;
        const routerLoad = mode === "heat" ? routerHeat?.[n.id] : undefined;
        const fillLoad = routerLive?.util ?? routerLoad?.value;
        const title = n.kind === "router"
          ? `${n.id} · router · ${n.service_rate} pkt/s · buffer ${n.buffer}${routerLive ? ` · queue ${routerLive.queue} · load ${(routerLive.util * 100).toFixed(0)}%` : ""}${routerLoad ? ` · ${routerLoad.detail}` : ""}${isDown ? " · DOWN" : ""}`
          : `${n.id} · host`;
        return (
          <g key={n.id} className={`topo-node topo-${n.kind} ${isDown ? "is-down" : ""} ${isSel ? "is-selected" : ""} ${isPending ? "is-pending" : ""}`}
            transform={`translate(${n.x}, ${n.y})`} onPointerDown={(e) => onNodeDown(e, n.id)}>
            <title>{title}</title>
            {n.kind === "router"
              ? <circle className="topo-shape" r={24} style={fillLoad !== undefined && !isDown ? { fill: loadColor(fillLoad) } : undefined} />
              : <rect className="topo-shape" x={-20} y={-16} width={40} height={32} rx={6} />}
            {n.kind === "router" && <path className={`topo-glyph ${fillLoad !== undefined && fillLoad > 0.5 && !isDown ? "on-dark" : ""}`} d="M-9 -4 L9 -4 M5 -8 L9 -4 L5 0 M9 4 L-9 4 M-5 0 L-9 4 L-5 8" />}
            {n.kind === "host" && <path className="topo-glyph" d="M-10 -7 H10 V5 H-10 Z M-4 9 H4" />}
            <text className="topo-node-label" y={n.kind === "router" ? 42 : 36} textAnchor="middle">{n.id}</text>
            {routerLive && routerLive.queue > 0 && !isDown && (
              <g className="topo-queue" transform="translate(20, -24)"><rect x={-4} y={-11} width={Math.max(22, 10 + String(routerLive.queue).length * 8)} height={18} rx={9} /><text x={7 + String(routerLive.queue).length * 2} y={2} textAnchor="middle">{routerLive.queue}</text></g>
            )}
            {isDown && <text className="topo-down-label" y={-32} textAnchor="middle">✕ DOWN</text>}
          </g>
        );
      })}

      {!editing && scenario.links.map((l) => {
        const a = nodes.get(l.a), b = nodes.get(l.b);
        const load = mode === "live" ? live?.links[l.id]?.util ?? 0 : heat?.[l.id]?.value ?? 0;
        if (!a || !b || load < CONGESTED || down.has(l.id) || down.has(l.a) || down.has(l.b)) return null;
        return (
          <g key={`c-${l.id}`} className="topo-congested" transform={`translate(${(a.x + b.x) / 2}, ${(a.y + b.y) / 2 - 16})`}>
            <rect x={-30} y={-11} width={60} height={20} rx={10} />
            <text x={0} y={4} textAnchor="middle">⚠ {(load * 100).toFixed(0)}%</text>
          </g>
        );
      })}

      {mode === "live" && live?.drops.map((d, i) => {
        const node = nodes.get(d.at);
        const link = scenario.links.find((l) => l.id === d.at);
        const a = link ? nodes.get(link.a) : undefined, b = link ? nodes.get(link.b) : undefined;
        const x = node?.x ?? (a && b ? (a.x + b.x) / 2 : null);
        const y = node?.y ?? (a && b ? (a.y + b.y) / 2 : null);
        if (x === null || y === null) return null;
        const age = Math.min(1, (now - d.start) / DROP_MS);
        return (
          <g key={`${d.at}-${d.start}-${i}`} className="topo-drop" transform={`translate(${x + 14}, ${y - 14 - age * 16})`} style={{ opacity: 1 - age }}>
            <title>Packet dropped: {dropLabel(d.reason)}</title>
            <path d="M-5 -5 L5 5 M5 -5 L-5 5" />
          </g>
        );
      })}

      {editing && scenario.nodes.length === 0 && (
        <text className="topology-empty" x={VIEW_W / 2} y={VIEW_H / 2} textAnchor="middle">Pick “Router” or “Host” above, then click here to place it — or load a sample network</text>
      )}
    </svg>
  );
}
