import { useId } from "react";
import type { AttackKind, AttackNode, AttackPath, AttackRun, AttackSample, NodeState } from "../lib/attack";
import { MAP_CENTER, VIEW_H, VIEW_W } from "../lib/attack";

interface Point {
  x: number;
  y: number;
}

interface Props {
  run: AttackRun;
  sample: AttackSample;
  clock: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const COLORS = {
  grid: "#12291f",
  ring: "#17382b",
  link: "#1d4436",
  linkHot: "#285b47",
  text: "#b8d5c8",
  muted: "#729587",
  secure: "#54d6a4",
  degraded: "#ffb454",
  critical: "#ff5d52",
  compromise: "#ff4fa3",
  cyan: "#57d5ff",
  bot: "#5f8575",
};

const ROLE_SIZE: Record<AttackNode["role"], number> = {
  target: 38,
  service: 17,
  edge: 21,
  endpoint: 14,
  bot: 8,
};

const ROLE_COLOR: Record<AttackNode["role"], string> = {
  target: COLORS.cyan,
  service: COLORS.secure,
  edge: COLORS.cyan,
  endpoint: COLORS.secure,
  bot: COLORS.bot,
};

function controlPoint(a: Point, b: Point, bend: number): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const outwardX = midX - MAP_CENTER.x;
  const outwardY = midY - MAP_CENTER.y;
  const perpX = -dy / length;
  const perpY = dx / length;
  const sign = perpX * outwardX + perpY * outwardY >= 0 ? 1 : -1;
  return { x: midX + perpX * bend * sign, y: midY + perpY * bend * sign };
}

interface Segment {
  a: Point;
  c: Point;
  b: Point;
}

function pathSegments(path: AttackPath, positions: Map<string, Point>): Segment[] {
  const segments: Segment[] = [];
  for (let index = 0; index < path.nodes.length - 1; index += 1) {
    const a = positions.get(path.nodes[index]);
    const b = positions.get(path.nodes[index + 1]);
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const bend = Math.min(58, Math.max(16, length * 0.16)) * (index % 2 === 0 ? 1 : 0.7);
    segments.push({ a, c: controlPoint(a, b, bend), b });
  }
  return segments;
}

function segmentD(segment: Segment): string {
  return `M ${segment.a.x} ${segment.a.y} Q ${segment.c.x} ${segment.c.y} ${segment.b.x} ${segment.b.y}`;
}

function pointOnPath(segments: Segment[], progress: number): Point | null {
  if (segments.length === 0) return null;
  const scaled = Math.max(0, Math.min(0.9999, progress)) * segments.length;
  const index = Math.min(segments.length - 1, Math.floor(scaled));
  const u = scaled - index;
  const { a, c, b } = segments[index];
  const oneMinus = 1 - u;
  return {
    x: oneMinus * oneMinus * a.x + 2 * oneMinus * u * c.x + u * u * b.x,
    y: oneMinus * oneMinus * a.y + 2 * oneMinus * u * c.y + u * u * b.y,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function pathStrength(path: AttackPath, sample: AttackSample, kind: AttackKind): number {
  const source = sample.nodes[path.nodes[0]];
  const pressure = source ? Math.max(source.compromise, source.load * 0.8) : 0;
  const factor = kind === "exfil" ? 10 : 8;
  return clamp(pressure * path.weight * factor, 0, 1);
}

function nodeColor(node: AttackNode, state: NodeState | undefined, kind: AttackKind): string {
  if (!state) return ROLE_COLOR[node.role];
  const compromised = state.compromise > 0.58;
  if (compromised) {
    if (node.role === "bot") return COLORS.critical;
    if (kind === "worm" || kind === "exfil") return COLORS.compromise;
    return COLORS.critical;
  }
  if (state.load > 1.1) return COLORS.critical;
  if (state.load > 0.82) return COLORS.degraded;
  return ROLE_COLOR[node.role];
}

function shieldPath(size: number): string {
  return `M 0 ${-size} L ${size * 0.82} ${-size * 0.5} L ${size * 0.72} ${size * 0.45} L 0 ${size} L ${-size * 0.72} ${size * 0.45} L ${-size * 0.82} ${-size * 0.5} Z`;
}

function hexPath(size: number): string {
  return `M 0 ${-size} L ${size * 0.87} ${-size * 0.5} L ${size * 0.87} ${size * 0.5} L 0 ${size} L ${-size * 0.87} ${size * 0.5} L ${-size * 0.87} ${-size * 0.5} Z`;
}

export function AttackMap({ run, sample, clock, selectedId, onSelect }: Props) {
  const uid = useId().replace(/:/g, "");
  const bgId = `${uid}-attack-bg`;
  const gridId = `${uid}-attack-grid`;
  const glowId = `${uid}-attack-target-glow`;
  const softGlowId = `${uid}-attack-soft-glow`;
  const { topology, config, scenario, paths } = run;
  const positions = new Map(topology.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  const accent = scenario.accent;
  const showBots = config.kind !== "worm";
  const visibleNodes = showBots ? topology.nodes : topology.nodes.filter((node) => node.role !== "bot");
  const countLabel = showBots
    ? `${visibleNodes.filter((node) => node.role === "bot").length} external clusters · ${config.scale.toLocaleString()} ${config.kind === "exfil" ? "exposed hosts" : "bots"}`
    : `${visibleNodes.filter((node) => node.role === "endpoint").length} workstation subnets · ${config.scale.toLocaleString()} exposed hosts`;

  return (
    <svg className="attack-map" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img"
      aria-label={`Network attack map for ${scenario.label}: ${config.scale.toLocaleString()} scale, target ${sample.targetState}`}
      onPointerDown={() => onSelect(null)}>
      <defs>
        <radialGradient id={bgId} cx="50%" cy="47%" r="72%">
          <stop offset="0%" stopColor="#0c211a" />
          <stop offset="58%" stopColor="#081610" />
          <stop offset="100%" stopColor="#040c09" />
        </radialGradient>
        <pattern id={gridId} width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke={COLORS.grid} strokeWidth="1" />
        </pattern>
        <radialGradient id={glowId}>
          <stop offset="0%" stopColor={sample.targetState === "secure" ? COLORS.secure : accent} stopOpacity="0.28" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <filter id={softGlowId} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <rect width={VIEW_W} height={VIEW_H} fill={`url(#${bgId})`} />
      <rect width={VIEW_W} height={VIEW_H} fill={`url(#${gridId})`} opacity="0.55" />

      <circle cx={MAP_CENTER.x} cy={MAP_CENTER.y} r="330" fill={`url(#${glowId})`} opacity={0.4 + sample.threat / 180} />
      <circle cx={MAP_CENTER.x} cy={MAP_CENTER.y} r="112" fill="none" stroke={COLORS.ring} strokeDasharray="3 8" />
      <circle cx={MAP_CENTER.x} cy={MAP_CENTER.y} r="212" fill="none" stroke={COLORS.ring} strokeDasharray="3 8" />
      <circle cx={MAP_CENTER.x} cy={MAP_CENTER.y} r="322" fill="none" stroke={COLORS.ring} strokeDasharray="3 8" />

      <text className="attack-region" x={94} y={MAP_CENTER.y} textAnchor="middle" transform={`rotate(-90 94 ${MAP_CENTER.y})`}>NORTH AMERICA</text>
      <text className="attack-region" x={MAP_CENTER.x} y={34} textAnchor="middle">EUROPE</text>
      <text className="attack-region" x={930} y={MAP_CENTER.y} textAnchor="middle" transform={`rotate(90 930 ${MAP_CENTER.y})`}>ASIA-PACIFIC</text>
      <text className="attack-region" x={MAP_CENTER.x} y={590} textAnchor="middle">HQ / DATA CENTRE</text>

      {topology.links.map((link) => {
        if (!showBots && link.kind === "peer") return null;
        const a = positions.get(link.a);
        const b = positions.get(link.b);
        if (!a || !b) return null;
        const isAttackEdge = link.kind === "peer" || link.kind === "backbone";
        return (
          <line key={link.id} className={`attack-map-link link-${link.kind}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={isAttackEdge ? COLORS.linkHot : COLORS.link} strokeWidth={link.kind === "lateral" ? 1 : 1.4} opacity={link.kind === "peer" ? 0.24 : 0.55} />
        );
      })}

      {paths.map((path, index) => {
        const segments = pathSegments(path, positions);
        if (segments.length === 0) return null;
        const strength = pathStrength(path, sample, config.kind);
        if (strength < 0.025) return null;
        const d = segments.map(segmentD).join(" ");
        const particle = pointOnPath(segments, (clock * 0.11 * (1 + (index % 3) * 0.25) + index * 0.37) % 1);
        return (
          <g key={path.id} className="attack-vector">
            <path d={d} fill="none" stroke={accent} strokeWidth={7 + strength * 7} opacity={0.05 + strength * 0.1} strokeLinecap="round" />
            <path className="attack-vector-line" d={d} fill="none" stroke={accent} strokeWidth={0.8 + strength * 2.2}
              opacity={0.22 + strength * 0.6} strokeDasharray={config.kind === "exfil" ? "2 9" : "7 9"} strokeLinecap="round" />
            {particle && strength > 0.18 && (
              <circle cx={particle.x} cy={particle.y} r={1.8 + strength * 2.2} fill={accent} opacity={0.55 + strength * 0.4} filter={`url(#${softGlowId})`} />
            )}
          </g>
        );
      })}

      {visibleNodes.map((node) => {
        const size = ROLE_SIZE[node.role];
        const state = sample.nodes[node.id];
        const color = nodeColor(node, state, config.kind);
        const compromised = (state?.compromise ?? 0) > 0.58;
        const active = (state?.compromise ?? 0) > 0.08;
        const isTarget = node.role === "target";
        const isSelected = selectedId === node.id;
        const labelY = isTarget ? 60 : size + 15;
        const targetPulse = isTarget ? 1 + 0.05 * Math.sin(clock * 2.2) : 1;
        return (
          <g key={node.id} className={`attack-node role-${node.role} ${compromised ? "is-compromised" : ""} ${isSelected ? "is-selected" : ""}`}
            transform={`translate(${node.x}, ${node.y})`}
            onPointerDown={(event) => { event.stopPropagation(); onSelect(node.id); }}>
            <title>{`${node.label} · ${node.role} · ${node.region} · ${node.units.toLocaleString()} units · load ${((state?.load ?? 0) * 100).toFixed(0)}% · compromise ${Math.round((state?.compromise ?? 0) * 100)}%`}</title>
            {(isTarget || compromised || (state?.load ?? 0) > 0.9) && (
              <circle r={size + 12 + (isTarget ? 12 * targetPulse : 4)} fill={color} opacity={isTarget ? 0.09 + sample.threat / 900 : 0.08} />
            )}
            {isTarget && (
              <>
                <circle r={size + 24} fill="none" stroke={color} strokeWidth="1" opacity="0.42" strokeDasharray="4 7" />
                <circle r={size + 14} fill="none" stroke={color} strokeWidth="1.5" opacity="0.65" />
              </>
            )}
            {node.role === "target" && (
              <>
                <path d={hexPath(size)} fill="#082a2a" stroke={color} strokeWidth="2.4" />
                <path d={`M ${-13} -15 H 13 M ${-13} -5 H 13 M ${-13} 5 H 13 M ${-13} 15 H 13`} stroke={color} strokeWidth="2" opacity="0.8" />
              </>
            )}
            {node.role === "service" && (
              <>
                <rect x={-size} y={-size * 0.78} width={size * 2} height={size * 1.56} rx="4" fill="#0a211a" stroke={color} strokeWidth="1.8" />
                <path d={`M ${-size * 0.55} ${-size * 0.2} H ${size * 0.55} M ${-size * 0.55} ${size * 0.24} H ${size * 0.55}`} stroke={color} strokeWidth="1.4" opacity="0.75" />
              </>
            )}
            {node.role === "edge" && (
              <>
                <path d={shieldPath(size)} fill="#0a201f" stroke={color} strokeWidth="1.8" />
                <path d={`M ${-size * 0.35} 0 L ${-size * 0.02} ${size * 0.32} L ${size * 0.42} ${-size * 0.3}`} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
              </>
            )}
            {node.role === "endpoint" && (
              <>
                <path d={hexPath(size)} fill={compromised ? "#2a0d1d" : "#0a211a"} stroke={color} strokeWidth="1.6" />
                <rect x={-size * 0.5} y={-size * 0.32} width={size} height={size * 0.55} rx="1.5" fill="none" stroke={color} strokeWidth="1.3" />
              </>
            )}
            {node.role === "bot" && (
              <>
                <path d={`M 0 ${-size} L ${size} ${size * 0.8} L ${-size} ${size * 0.8} Z`} fill={active ? color : "#10251d"} stroke={color} strokeWidth="1.2" />
                {active && <circle r={1.5} cy={size * 0.16} fill="#04100b" />}
              </>
            )}
            {isSelected && <circle r={size + 9} fill="none" stroke={COLORS.cyan} strokeWidth="1.5" strokeDasharray="3 4" />}
            <text className={`attack-node-label ${node.role === "bot" ? "is-bot" : ""}`} y={labelY} textAnchor="middle" fill={compromised ? color : COLORS.text}>{node.label}</text>
            {isTarget && <text className="attack-node-units" y={labelY + 13} textAnchor="middle">{node.units.toLocaleString()} core service</text>}
            {compromised && !isTarget && (
              <g transform={`translate(${size + 6}, ${-size - 2})`}>
                <circle r="5.5" fill="#24070a" stroke={color} strokeWidth="1.2" />
                <path d="M -2 -2 L 2 2 M 2 -2 L -2 2" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
              </g>
            )}
          </g>
        );
      })}

      <g className="attack-map-legend" transform="translate(26, 26)">
        <circle cx="4" cy="4" r="3.5" fill={COLORS.critical} />
        <text x="14" y="8">active attack vector</text>
        <circle cx="150" cy="4" r="3.5" fill={COLORS.compromise} />
        <text x="160" y="8">compromised asset</text>
      </g>
      <text className="attack-map-count" x={VIEW_W - 28} y={34} textAnchor="end">{countLabel}</text>
      <text className="attack-map-clock" x={VIEW_W - 28} y={VIEW_H - 22} textAnchor="end">T+ {clock.toFixed(1)}s / {config.duration}s</text>
      <line x1={MAP_CENTER.x} y1={44} x2={MAP_CENTER.x} y2={VIEW_H - 44} stroke={COLORS.ring} strokeWidth="0.6" strokeDasharray="2 12" opacity="0.5" />
      <line x1={108} y1={MAP_CENTER.y} x2={VIEW_W - 108} y2={MAP_CENTER.y} stroke={COLORS.ring} strokeWidth="0.6" strokeDasharray="2 12" opacity="0.5" />
    </svg>
  );
}
