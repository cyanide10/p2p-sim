// Deterministic large-scale cyber-attack campaign model for the Threat Lab.
//
// This is a presentation model, not a packet-level simulator: it turns a few
// strategic inputs (attack type, scale, intensity, target capacity, defensive
// posture) into a repeatable campaign timeline. The visible topology groups
// thousands of real hosts into a few dozen tokens, so the same run can be
// scrubbed, paused and replayed frame for frame. The network lab remains the
// place where packet-level traffic runs on the node pool.

export type AttackKind = "ddos" | "synflood" | "worm" | "exfil";

export type NodeRole = "target" | "service" | "endpoint" | "edge" | "bot";

export type TargetState = "secure" | "degraded" | "critical" | "offline";

export interface AttackPhase {
  id: string;
  label: string;
  /** Start of the phase as a fraction of the campaign. */
  at: number;
}

export interface AttackScenario {
  id: AttackKind;
  label: string;
  codename: string;
  tagline: string;
  description: string;
  severity: "high" | "critical" | "stealth";
  unit: string;
  scaleLabel: string;
  capacityLabel: string;
  attackLabel: string;
  impactLabel: string;
  impactUnit: string;
  accent: string;
  defaultScale: number;
  defaultIntensity: number;
  defaultCapacity: number;
  phases: AttackPhase[];
}

export const ATTACK_ORDER: AttackKind[] = ["ddos", "synflood", "worm", "exfil"];

export const ATTACK_SCENARIOS: Record<AttackKind, AttackScenario> = {
  ddos: {
    id: "ddos",
    label: "Volumetric DDoS",
    codename: "OP. FLOODGATE",
    tagline: "A botnet flood against the public data core.",
    description:
      "A rented botnet concentrates garbage traffic on the internet edge. Links saturate, queues overflow, and legitimate requests time out while operators race to engage scrubbing.",
    severity: "critical",
    unit: "Gbps",
    scaleLabel: "Botnet size",
    capacityLabel: "Edge capacity",
    attackLabel: "Flood volume",
    impactLabel: "Packet loss",
    impactUnit: "%",
    accent: "#ff5a4e",
    defaultScale: 48_000,
    defaultIntensity: 5,
    defaultCapacity: 40,
    phases: [
      { id: "recon", label: "Reconnaissance", at: 0 },
      { id: "arming", label: "Botnet arming", at: 0.1 },
      { id: "flood", label: "Volumetric flood", at: 0.2 },
      { id: "detect", label: "Detection", at: 0.58 },
      { id: "scrub", label: "Scrubbing", at: 0.7 },
      { id: "recover", label: "Recovery", at: 0.86 },
    ],
  },
  synflood: {
    id: "synflood",
    label: "SYN flood",
    codename: "OP. HANDSHAKE",
    tagline: "Connection-table exhaustion at the API tier.",
    description:
      "A proxy swarm opens half-finished TCP handshakes through the edge. The API tier exhausts its connection table, legitimate clients are refused, and SYN cookies become the last line of defence.",
    severity: "high",
    unit: "Mpps",
    scaleLabel: "Proxy swarm",
    capacityLabel: "Handshake capacity",
    attackLabel: "SYN rate",
    impactLabel: "Dropped connections",
    impactUnit: "%",
    accent: "#ffb454",
    defaultScale: 32_000,
    defaultIntensity: 5,
    defaultCapacity: 8,
    phases: [
      { id: "recon", label: "Reconnaissance", at: 0 },
      { id: "swarm", label: "Proxy swarm", at: 0.12 },
      { id: "flood", label: "Connection flood", at: 0.22 },
      { id: "detect", label: "Detection", at: 0.55 },
      { id: "limit", label: "Rate limiting", at: 0.66 },
      { id: "recover", label: "Recovery", at: 0.84 },
    ],
  },
  worm: {
    id: "worm",
    label: "Ransomware worm",
    codename: "OP. RED THREAD",
    tagline: "Self-propagating lateral movement across the estate.",
    description:
      "A worm enters through a workstation and spreads over SMB and stolen credentials. It reaches the domain controller, encrypts file shares, and forces isolation of whole VLANs before containment takes hold.",
    severity: "critical",
    unit: "hosts/s",
    scaleLabel: "Exposed hosts",
    capacityLabel: "Containment rate",
    attackLabel: "New infections / s",
    impactLabel: "Hosts encrypted",
    impactUnit: "%",
    accent: "#ff4fa3",
    defaultScale: 12_000,
    defaultIntensity: 5,
    defaultCapacity: 260,
    phases: [
      { id: "access", label: "Initial access", at: 0 },
      { id: "foothold", label: "Foothold", at: 0.1 },
      { id: "lateral", label: "Lateral movement", at: 0.22 },
      { id: "escalate", label: "Domain escalation", at: 0.5 },
      { id: "contain", label: "Containment", at: 0.64 },
      { id: "recover", label: "Recovery", at: 0.86 },
    ],
  },
  exfil: {
    id: "exfil",
    label: "Data exfiltration",
    codename: "OP. SILENT EGRESS",
    tagline: "Low-and-slow theft through an inspected egress.",
    description:
      "An intruder stages records in the file service and smuggles them out through a regional peering link. Volume stays under most alert thresholds, so the damage is measured in gigabytes rather than downtime.",
    severity: "stealth",
    unit: "Gbps",
    scaleLabel: "Exposed hosts",
    capacityLabel: "Egress inspection",
    attackLabel: "Exfil rate",
    impactLabel: "Data exfiltrated",
    impactUnit: "GB",
    accent: "#57d5ff",
    defaultScale: 9_000,
    defaultIntensity: 5,
    defaultCapacity: 2.5,
    phases: [
      { id: "access", label: "Foothold", at: 0 },
      { id: "discover", label: "Discovery", at: 0.12 },
      { id: "collect", label: "Collection", at: 0.28 },
      { id: "exfil", label: "Exfiltration", at: 0.42 },
      { id: "detect", label: "Detection", at: 0.7 },
      { id: "block", label: "Blocked", at: 0.84 },
    ],
  },
};

export function getScenario(kind: AttackKind): AttackScenario {
  return ATTACK_SCENARIOS[kind];
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

export const VIEW_W = 1000;
export const VIEW_H = 620;
export const MAP_CENTER = { x: 500, y: 310 };

export interface AttackNode {
  id: string;
  label: string;
  role: NodeRole;
  x: number;
  y: number;
  /** Hosts represented by this token (a cluster of bots, a subnet, a service). */
  units: number;
  region: string;
  group: string;
}

export interface AttackLink {
  id: string;
  a: string;
  b: string;
  kind: "backbone" | "service" | "access" | "peer" | "lateral";
}

export interface AttackPath {
  id: string;
  /** Two or three consecutive nodes; the path is drawn as one continuous curve. */
  nodes: string[];
  weight: number;
}

export interface AttackTopology {
  nodes: AttackNode[];
  links: AttackLink[];
}

export interface AttackConfig {
  kind: AttackKind;
  seed: number;
  duration: number;
  scale: number;
  intensity: number;
  capacity: number;
  defense: number;
}

export const DEFAULT_DURATION = 300;
export const SAMPLE_STEP = 0.5;
export const MIN_SCALE = 500;
export const MAX_SCALE = 200_000;

export function normalizeConfig(raw: Partial<AttackConfig> & { kind: AttackKind }): AttackConfig {
  const scenario = getScenario(raw.kind);
  const finite = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) ? value : fallback;
  return {
    kind: raw.kind,
    seed: Number.isSafeInteger(raw.seed) && (raw.seed ?? -1) >= 0 ? raw.seed! : 2026,
    duration: Math.max(30, Math.min(900, Math.round(finite(raw.duration, DEFAULT_DURATION)))),
    scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(finite(raw.scale, scenario.defaultScale)))),
    intensity: Math.max(1, Math.min(10, finite(raw.intensity, scenario.defaultIntensity))),
    capacity: Math.max(0.05, Math.min(scenario.defaultCapacity * 8, finite(raw.capacity, scenario.defaultCapacity))),
    defense: Math.max(0, Math.min(100, finite(raw.defense, 60))),
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

const SERVICE_DEFS = [
  { id: "api", label: "API" },
  { id: "auth", label: "AUTH" },
  { id: "db", label: "DB" },
  { id: "files", label: "FILES" },
  { id: "mail", label: "MAIL" },
  { id: "dns", label: "DNS" },
] as const;

const EDGE_DEFS = [
  { id: "edge-na", label: "EDGE NA", region: "North America", angle: Math.PI },
  { id: "edge-eu", label: "EDGE EU", region: "Europe", angle: -Math.PI / 2 },
  { id: "edge-apac", label: "EDGE APAC", region: "Asia-Pacific", angle: 0 },
] as const;

const BOT_GROUPS = [
  { id: "na", region: "North America", edge: "edge-na", angle: Math.PI },
  { id: "eu", region: "Europe", edge: "edge-eu", angle: -Math.PI / 2 },
  { id: "apac", region: "Asia-Pacific", edge: "edge-apac", angle: 0 },
] as const;

const BOTS_PER_GROUP = 7;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildTopology(seed: number, scale: number): AttackTopology {
  const random = mulberry32(seed + 0x9e3779b9);
  const jitter = (amount: number) => (random() - 0.5) * amount;
  const nodes: AttackNode[] = [];
  const links: AttackLink[] = [];
  let linkIndex = 0;
  const link = (a: string, b: string, kind: AttackLink["kind"]) => {
    links.push({ id: `l${++linkIndex}`, a, b, kind });
  };

  nodes.push({
    id: "dc",
    label: "DC-CORE",
    role: "target",
    x: MAP_CENTER.x,
    y: MAP_CENTER.y,
    units: 1,
    region: "HQ",
    group: "core",
  });

  SERVICE_DEFS.forEach((service, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI) / 3;
    const radius = 96;
    nodes.push({
      id: service.id,
      label: service.label,
      role: "service",
      x: round(MAP_CENTER.x + Math.cos(angle) * radius),
      y: round(MAP_CENTER.y + Math.sin(angle) * radius),
      units: 1,
      region: "HQ",
      group: "service",
    });
    link("dc", service.id, "service");
  });

  EDGE_DEFS.forEach((edge) => {
    const rx = 340;
    const ry = 210;
    nodes.push({
      id: edge.id,
      label: edge.label,
      role: "edge",
      x: round(MAP_CENTER.x + Math.cos(edge.angle) * rx),
      y: round(MAP_CENTER.y + Math.sin(edge.angle) * ry),
      units: 1,
      region: edge.region,
      group: "edge",
    });
    link("dc", edge.id, "backbone");
  });
  link("edge-na", "edge-eu", "backbone");
  link("edge-eu", "edge-apac", "backbone");
  link("edge-apac", "edge-na", "backbone");

  for (let index = 0; index < 6; index += 1) {
    const angle = (60 + index * 12) * (Math.PI / 180);
    nodes.push({
      id: `ws${index + 1}`,
      label: `WS-0${index + 1}`,
      role: "endpoint",
      x: round(MAP_CENTER.x + Math.cos(angle) * 195 + jitter(5)),
      y: round(MAP_CENTER.y + Math.sin(angle) * 195 + jitter(5)),
      units: Math.max(1, Math.round(scale / 6)),
      region: "HQ",
      group: "endpoint",
    });
  }
  for (let index = 1; index <= 6; index += 1) {
    link("dc", `ws${index}`, "access");
    link(`ws${index}`, `ws${(index % 6) + 1}`, "lateral");
  }

  let botIndex = 0;
  for (const group of BOT_GROUPS) {
    for (let index = 0; index < BOTS_PER_GROUP; index += 1) {
      botIndex += 1;
      const spread = 0.95;
      const angle = group.angle + (index - (BOTS_PER_GROUP - 1) / 2) * (spread / (BOTS_PER_GROUP - 1));
      const rx = 358 + jitter(14);
      const ry = 246 + jitter(12);
      const id = `bot-${group.id}-${index + 1}`;
      nodes.push({
        id,
        label: `${group.id.toUpperCase()}-${String(index + 1).padStart(2, "0")}`,
        role: "bot",
        x: round(MAP_CENTER.x + Math.cos(angle) * rx),
        y: round(MAP_CENTER.y + Math.sin(angle) * ry),
        units: Math.max(1, Math.round(scale / (BOTS_PER_GROUP * 3))),
        region: group.region,
        group: group.id,
      });
      link(group.edge, id, "peer");
    }
  }

  return { nodes, links };
}

/** Paths for every attack kind, in ATTACK_ORDER. */
export function buildAttackPaths(nodes: AttackNode[], links: AttackLink[]): [AttackPath[], AttackPath[], AttackPath[], AttackPath[]] {
  const bots = nodes.filter((node) => node.role === "bot");
  const endpoints = nodes.filter((node) => node.role === "endpoint");
  const services = nodes.filter((node) => node.role === "service");
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgeForGroup = new Map<string, string>();
  for (const link of links) {
    if (link.kind !== "peer") continue;
    const a = nodeById.get(link.a);
    const b = nodeById.get(link.b);
    if (a?.role === "bot" && b?.role === "edge") edgeForGroup.set(a.group, b.id);
    else if (b?.role === "bot" && a?.role === "edge") edgeForGroup.set(b.group, a.id);
  }

  const botPaths = (sink: string): AttackPath[] =>
    bots.map((bot, index) => ({
      id: `attack-${sink}-${index}`,
      nodes: [bot.id, edgeForGroup.get(bot.group) ?? "edge-na", sink],
      weight: 1 / bots.length,
    }));

  const nearestService = (endpoint: AttackNode): AttackNode =>
    services.reduce((best, service) => {
      const distance = (endpoint.x - service.x) ** 2 + (endpoint.y - service.y) ** 2;
      const bestDistance = (endpoint.x - best.x) ** 2 + (endpoint.y - best.y) ** 2;
      return distance < bestDistance ? service : best;
    }, services[0]);

  const wormPaths = endpoints.map((endpoint, index) => ({
    id: `worm-${index}`,
    nodes: [endpoint.id, nearestService(endpoint).id, "dc"],
    weight: 1 / endpoints.length,
  }));

  const exfilPaths: AttackPath[] = [
    ...endpoints.map((endpoint, index) => ({
      id: `collect-${index}`,
      nodes: [endpoint.id, "files"],
      weight: 0.35 / endpoints.length,
    })),
    ...bots
      .filter((bot) => bot.group === "apac")
      .map((bot, index) => ({
        id: `egress-${index}`,
        nodes: ["files", "edge-apac", bot.id],
        weight: 0.65 / bots.filter((item) => item.group === "apac").length,
      })),
  ];

  return [botPaths("dc"), botPaths("api"), wormPaths, exfilPaths];
}

// ---------------------------------------------------------------------------
// Campaign model
// ---------------------------------------------------------------------------

export interface NodeState {
  /** 0..1+ (1 ≈ at capacity). */
  load: number;
  /** 0..1 fraction of the token's hosts that are compromised. */
  compromise: number;
}

export interface AttackSample {
  t: number;
  phase: string;
  threat: number;
  attackLoad: number;
  legitLoad: number;
  capacity: number;
  loadRatio: number;
  /** Scenario-specific impact value (loss %, encrypted % or exfiltrated GB). */
  impact: number;
  /** 0..100 representation of impact, for charts. */
  impactPct: number;
  latencyMs: number;
  availability: number;
  compromised: number;
  botsActive: number;
  blocked: number;
  targetState: TargetState;
  nodes: Record<string, NodeState>;
}

export interface AttackEvent {
  t: number;
  level: "info" | "warn" | "critical" | "success";
  text: string;
}

export interface AttackSummary {
  peakThreat: number;
  peakLoadRatio: number;
  peakImpact: number;
  peakCompromised: number;
  timeAboveCapacity: number;
  recoverySeconds: number | null;
  exfiltratedGb: number;
  blockedPct: number;
}

export interface AttackRun {
  config: AttackConfig;
  scenario: AttackScenario;
  topology: AttackTopology;
  paths: AttackPath[];
  samples: AttackSample[];
  events: AttackEvent[];
  summary: AttackSummary;
  step: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const smooth = (value: number) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

function floodProfile(u: number, t: number): number {
  const pulse = 1 + 0.05 * Math.sin(t * 1.7) + 0.025 * Math.sin(t * 0.53);
  if (u < 0.1) return 0;
  if (u < 0.2) return smooth((u - 0.1) / 0.1) * pulse;
  if (u < 0.58) return pulse;
  if (u < 0.7) return 1.35 * pulse;
  if (u < 0.86) return (1.35 - ((u - 0.7) / 0.16) * 1.3) * pulse;
  return 0.02;
}

function handshakeProfile(u: number, t: number): number {
  const pulse = 1 + 0.06 * Math.sin(t * 2.2);
  if (u < 0.12) return 0;
  if (u < 0.22) return smooth((u - 0.12) / 0.1) * pulse;
  if (u < 0.55) return pulse;
  if (u < 0.66) return 1.18 * pulse;
  if (u < 0.84) return (1.18 - ((u - 0.66) / 0.18) * 1.12) * pulse;
  return 0.02;
}

function exfilProfile(u: number, t: number): number {
  const pulse = 0.96 + 0.04 * Math.sin(t * 0.8);
  if (u < 0.14) return 0;
  if (u < 0.28) return smooth((u - 0.14) / 0.14) * pulse;
  if (u < 0.7) return 0.82 * pulse;
  if (u < 0.8) return 1.28 * pulse;
  if (u < 0.92) return (1.28 - ((u - 0.8) / 0.12) * 1.22) * pulse;
  return 0.03;
}

function logistic(u: number, midpoint: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * (u - midpoint)));
}

function lossForLoad(ratio: number): number {
  if (ratio <= 0.9) return 0;
  return clamp(((ratio - 0.9) / Math.max(0.2, ratio)) * 135, 0, 99);
}

function latencyForLoad(ratio: number): number {
  if (ratio < 0.92) return 12 / Math.max(0.08, 1 - ratio * 0.92);
  return Math.min(9_999, 180 + ratio * ratio * 640);
}

export function targetStateFor(loadRatio: number, availability: number, compromise: number): TargetState {
  if (availability < 40 || loadRatio > 1.6 || compromise > 0.85) return "offline";
  if (availability < 82 || loadRatio > 1.1 || compromise > 0.55) return "critical";
  if (availability < 98 || loadRatio > 0.8 || compromise > 0.2) return "degraded";
  return "secure";
}

// Wire scenario sent to the node's attack planner/worker. Presentation-only
// fields (labels, colours) stay in the browser; the Python model only needs the
// campaign inputs and the topology tokens.
export interface AttackNodeSpec {
  id: string;
  index: number;
  role: NodeRole;
  units: number;
}

export interface AttackPhaseSpec {
  id: string;
  at: number;
}

export interface AttackScenarioWire {
  kind: AttackKind;
  duration: number;
  step: number;
  seed: number;
  scale: number;
  intensity: number;
  capacity: number;
  defense: number;
  phases: AttackPhaseSpec[];
  nodes: AttackNodeSpec[];
}

/** Metrics returned by attacksim.py (single worker or merged PDES). */
export interface AttackMetrics {
  kind: AttackKind;
  duration: number;
  step: number;
  samples: AttackSample[];
  summary: AttackSummary;
}

export function buildAttackScenario(config: AttackConfig): AttackScenarioWire {
  const scenario = getScenario(config.kind);
  const topology = buildTopology(config.seed, config.scale);
  return {
    kind: config.kind,
    duration: config.duration,
    step: SAMPLE_STEP,
    seed: config.seed,
    scale: config.scale,
    intensity: config.intensity,
    capacity: config.capacity,
    defense: config.defense,
    phases: scenario.phases.map((phase) => ({ id: phase.id, at: phase.at })),
    nodes: topology.nodes.map((node, index) => ({
      id: node.id,
      index,
      role: node.role,
      units: node.units,
    })),
  };
}

/** Rebuilds the local presentation model from a node/PDES campaign result. */
export function attackRunFromMetrics(config: AttackConfig, metrics: AttackMetrics): AttackRun {
  const scenario = getScenario(config.kind);
  const topology = buildTopology(config.seed, config.scale);
  const paths = buildAttackPaths(topology.nodes, topology.links)[ATTACK_ORDER.indexOf(config.kind)];
  return {
    config,
    scenario,
    topology,
    paths,
    samples: metrics.samples,
    events: buildEvents(metrics.samples, scenario, config),
    summary: metrics.summary,
    step: metrics.step,
  };
}

export function buildAttackRun(input: Partial<AttackConfig> & { kind: AttackKind }): AttackRun {
  const config = normalizeConfig(input);
  const scenario = getScenario(config.kind);
  const topology = buildTopology(config.seed, config.scale);
  const paths = buildAttackPaths(
    topology.nodes,
    topology.links,
  )[ATTACK_ORDER.indexOf(config.kind)];
  const step = SAMPLE_STEP;
  const samples: AttackSample[] = [];
  let exfiltratedGb = 0;

  for (let t = 0; t <= config.duration + 1e-9; t += step) {
    const time = Math.min(config.duration, t);
    const u = time / config.duration;
    const defense = config.defense / 100;
    const phase = phaseFor(scenario, u).id;

    let attackLoad = 0;
    let legitLoad = 0;
    let capacity = config.capacity;
    let impact = 0;
    let impactPct = 0;
    let availability = 100;
    let latencyMs = 12;
    let compromised = 0;
    let botsActive = 0;
    let blocked = 0;
    let targetCompromise = 0;

    if (config.kind === "ddos" || config.kind === "synflood") {
      const isDdos = config.kind === "ddos";
      const base = isDdos
        ? config.scale * 0.0012 * (config.intensity / 5)
        : config.scale * 0.00022 * (config.intensity / 5);
      const profile = isDdos ? floodProfile(u, time) : handshakeProfile(u, time);
      const detectAt = isDdos ? 0.58 : 0.55;
      const mitigation = defense * smooth((u - detectAt) / 0.14);
      attackLoad = base * profile * (1 - mitigation);
      legitLoad = (isDdos ? 6 : 1.6) * (0.96 + 0.04 * Math.sin(time / 7));
      const ratio = (attackLoad + legitLoad) / capacity;
      const loss = lossForLoad(ratio);
      impact = loss;
      impactPct = loss;
      availability = clamp(100 - loss * 0.92 - Math.max(0, ratio - 1) * 18, 0, 100);
      latencyMs = latencyForLoad(ratio);
      compromised = config.scale * clamp((u - 0.08) / 0.12, 0, 1);
      botsActive = config.scale * clamp(profile, 0, 1);
      blocked = mitigation * 100;
      targetCompromise = 0;
    } else if (config.kind === "worm") {
      const start = 0.12;
      const midpoint = 0.55 - (config.intensity - 5) * 0.018;
      const steepness = 12 + config.intensity * 1.2;
      const containment = defense * smooth((u - 0.62) / 0.12);
      const effectiveU = u - containment * Math.max(0, u - 0.62) * 0.92;
      const susceptible = logistic(effectiveU, midpoint, steepness);
      const initial = logistic(start, midpoint, steepness);
      const fraction = clamp((susceptible - initial) / Math.max(1e-6, 1 - initial), 0, 1);
      const next = clamp(
        (logistic(effectiveU + 0.001, midpoint, steepness) - initial) / Math.max(1e-6, 1 - initial),
        0,
        1,
      );
      attackLoad = Math.max(0, (config.scale * (next - fraction)) / (0.001 * config.duration));
      legitLoad = 0;
      capacity = config.capacity;
      impact = fraction * 100;
      impactPct = impact;
      availability = clamp(100 - fraction * 92 - Math.max(0, attackLoad / capacity - 1) * 6, 0, 100);
      latencyMs = 12 + fraction * 420;
      compromised = config.scale * fraction;
      botsActive = 0;
      blocked = containment * 100;
      targetCompromise = fraction * 0.55;
    } else {
      const start = 0.1;
      const midpoint = 0.58 - (config.intensity - 5) * 0.017;
      const steepness = 10 + config.intensity;
      const containment = defense * smooth((u - 0.7) / 0.12);
      const effectiveU = u - containment * Math.max(0, u - 0.7) * 0.65;
      const susceptible = logistic(effectiveU, midpoint, steepness);
      const initial = logistic(start, midpoint, steepness);
      const fraction = clamp((susceptible - initial) / Math.max(1e-6, 1 - initial), 0, 1);
      const base = config.scale * 0.00006 * (config.intensity / 5);
      const profile = exfilProfile(u, time);
      const mitigation = containment * 0.6;
      attackLoad = base * profile * (1 - mitigation);
      legitLoad = 0.5 * (0.94 + 0.06 * Math.sin(time / 9));
      capacity = config.capacity;
      exfiltratedGb += (attackLoad * step) / 8;
      impact = exfiltratedGb;
      impactPct = clamp((exfiltratedGb / 75) * 100, 0, 100);
      const ratio = (attackLoad + legitLoad) / capacity;
      availability = clamp(100 - fraction * 18 - Math.max(0, ratio - 1) * 12, 0, 100);
      latencyMs = 12 + Math.max(0, ratio - 0.9) * 220;
      compromised = config.scale * fraction;
      botsActive = 0;
      blocked = mitigation * 100;
      targetCompromise = fraction * 0.2;
    }

    const loadRatio = (attackLoad + legitLoad) / capacity;
    const threat = (() => {
      if (config.kind === "worm") {
        return clamp(impact * 0.75 + (100 - availability) * 0.22 + Math.min(loadRatio, 4) * 4, 0, 100);
      }
      if (config.kind === "exfil") {
        return clamp(impactPct * 0.45 + (compromised / config.scale) * 45 + loadRatio * 9, 0, 100);
      }
      return clamp(loadRatio * 36 + impact * 0.4 + (100 - availability) * 0.8, 0, 100);
    })();

    const nodes: Record<string, NodeState> = {};
    topology.nodes.forEach((node, index) => {
      const wobble = 0.82 + 0.18 * Math.abs(Math.sin(index * 1.7 + config.seed * 0.001));
      let load = 0.05;
      let compromise = 0;
      if (node.role === "target") {
        load = clamp(loadRatio, 0, 2.4);
        compromise = targetCompromise;
      } else if (node.role === "service") {
        if (config.kind === "worm") {
          load = clamp((compromised / config.scale) * 1.35, 0, 2);
          compromise = clamp((compromised / config.scale) * wobble, 0, 1);
        } else if (config.kind === "exfil") {
          load = clamp(loadRatio * (node.id === "files" ? 1 : 0.38), 0, 2);
          compromise = node.id === "files" ? clamp((compromised / config.scale) * 1.15, 0, 1) : 0;
        } else {
          load = config.kind === "synflood" && node.id === "api" ? clamp(loadRatio, 0, 2) : clamp(loadRatio * 0.42, 0, 2);
        }
      } else if (node.role === "edge") {
        load = clamp(loadRatio * (config.kind === "ddos" || config.kind === "synflood" ? 0.86 : 0.16), 0, 2);
      } else if (node.role === "endpoint") {
        load = config.kind === "worm" || config.kind === "exfil" ? clamp((compromised / config.scale) * 1.25, 0, 2) : 0.06;
        compromise = config.kind === "worm" || config.kind === "exfil" ? clamp((compromised / config.scale) * wobble, 0, 1) : 0;
      } else {
        load = config.kind === "ddos" || config.kind === "synflood" ? clamp(botsActive / Math.max(1, config.scale), 0, 1.4) : 0.04;
        compromise = config.kind === "ddos" || config.kind === "synflood"
          ? clamp(botsActive / Math.max(1, config.scale), 0, 1)
          : 0.12;
      }
      nodes[node.id] = { load, compromise };
    });

    samples.push({
      t: time,
      phase,
      threat,
      attackLoad,
      legitLoad,
      capacity,
      loadRatio,
      impact,
      impactPct,
      latencyMs,
      availability,
      compromised,
      botsActive,
      blocked,
      targetState: targetStateFor(loadRatio, availability, targetCompromise),
      nodes,
    });
  }

  const summary = summarize(samples, config);
  return {
    config,
    scenario,
    topology,
    paths,
    samples,
    events: buildEvents(samples, scenario, config),
    summary,
    step,
  };
}

function summarize(samples: AttackSample[], config: AttackConfig): AttackSummary {
  let peakThreat = 0;
  let peakLoadRatio = 0;
  let peakImpact = 0;
  let peakCompromised = 0;
  let blockedPct = 0;
  let timeAboveCapacity = 0;
  let peakIndex = 0;
  samples.forEach((sample, index) => {
    if (sample.threat > peakThreat) {
      peakThreat = sample.threat;
      peakIndex = index;
    }
    peakLoadRatio = Math.max(peakLoadRatio, sample.loadRatio);
    peakImpact = Math.max(peakImpact, sample.impact);
    peakCompromised = Math.max(peakCompromised, sample.compromised);
    blockedPct = Math.max(blockedPct, sample.blocked);
    if (sample.loadRatio > 1) timeAboveCapacity += SAMPLE_STEP;
  });
  const peak = samples[peakIndex];
  const recovery = samples.slice(peakIndex).find((sample) => sample.loadRatio < 0.95 && sample.availability > 99);
  return {
    peakThreat,
    peakLoadRatio,
    peakImpact,
    peakCompromised,
    timeAboveCapacity,
    recoverySeconds: recovery ? recovery.t - peak.t : null,
    exfiltratedGb: config.kind === "exfil" ? samples[samples.length - 1]?.impact ?? 0 : 0,
    blockedPct,
  };
}

function buildEvents(samples: AttackSample[], scenario: AttackScenario, config: AttackConfig): AttackEvent[] {
  const events: AttackEvent[] = [];
  const at = (fraction: number) => Math.round(fraction * config.duration * 10) / 10;
  const push = (t: number, level: AttackEvent["level"], text: string) => {
    if (t < 0 || t > config.duration) return;
    events.push({ t: Math.round(t * 10) / 10, level, text });
  };

  push(0, "info", `${scenario.codename} model armed · ${compact(config.scale)} ${config.kind === "worm" || config.kind === "exfil" ? "exposed hosts" : "nodes"}`);
  if (config.kind === "ddos") {
    push(at(0.1), "warn", "Botnet C2 issues the attack command");
    push(at(0.2), "critical", "Edge ingress crosses the 1 Tbps design baseline");
    push(at(0.58), "warn", "Volumetric anomaly confirmed by the SOC");
    if (config.defense > 0) push(at(0.7), "success", `Scrubbing engaged · ${compact(config.defense, 0)}% filter posture`);
  } else if (config.kind === "synflood") {
    push(at(0.12), "warn", "Proxy swarm starts half-open handshakes");
    push(at(0.22), "critical", "API connection table above 90% utilisation");
    push(at(0.55), "warn", "SYN-cookie challenge enabled at the edge");
    if (config.defense > 0) push(at(0.66), "success", "Per-source rate limiter engaged");
  } else if (config.kind === "worm") {
    push(at(0.1), "warn", "Patient zero: workstation SMB share infected");
    push(at(0.22), "critical", "Lateral movement across the workstation VLAN");
    push(at(0.5), "critical", "Domain controller credentials harvested");
    if (config.defense > 0) push(at(0.64), "success", "Endpoint isolation policy prevents new SMB sessions");
  } else {
    push(at(0.28), "warn", "Collection staged in the file service");
    push(at(0.42), "critical", "Compressed archive leaving through APAC peering");
    push(at(0.7), "warn", "DLP signature match on egress traffic");
    if (config.defense > 0) push(at(0.84), "success", "Egress filter drops the archive transfer");
  }

  const firstOver = samples.find((sample) => sample.loadRatio > 1);
  if (firstOver) push(firstOver.t, "critical", `Target capacity exceeded · ${firstOver.loadRatio.toFixed(2)}× offered load`);
  const peak = samples.reduce((best, sample) => (sample.threat > best.threat ? sample : best), samples[0]);
  push(peak.t, "critical", `Peak impact · threat index ${peak.threat.toFixed(0)}`);
  const recovery = samples.find((sample) => sample.t > peak.t && sample.loadRatio < 0.95 && sample.availability > 99);
  if (recovery) push(recovery.t, "success", "Service level restored · availability above 99%");

  return events
    .filter((event, index) => events.findIndex((item) => item.t === event.t && item.text === event.text) === index)
    .sort((a, b) => a.t - b.t);
}

export function sampleAt(run: AttackRun, time: number): AttackSample {
  const index = clamp(Math.round(time / run.step), 0, run.samples.length - 1);
  return run.samples[index];
}

export function phaseFor(scenario: AttackScenario, u: number): AttackPhase {
  let current = scenario.phases[0];
  for (const phase of scenario.phases) if (u >= phase.at) current = phase;
  return current;
}

export function phaseIndex(scenario: AttackScenario, phaseId: string): number {
  return Math.max(0, scenario.phases.findIndex((phase) => phase.id === phaseId));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function compact(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(digits)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(digits)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(digits)}K`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(digits)}K`;
  if (abs >= 100) return value.toFixed(0);
  return value.toFixed(digits);
}

export function percent(value: number, digits = 0): string {
  return `${clamp(value, 0, 100).toFixed(digits)}%`;
}
