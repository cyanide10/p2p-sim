import { Cpu } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ApiError, createApiClient } from "../api/client";
import type { AttackReport, AttackStatus, MockScenario, PartitionPlan, RunCreated } from "../api/types";
import { Notice, PageHeading } from "../components/PagePrimitives";
import { AttackCharts } from "../components/attack/AttackCharts";
import { AttackConfigure } from "../components/attack/AttackConfigure";
import { AttackExecution } from "../components/attack/AttackExecution";
import { AttackRuntime } from "../components/attack/AttackRuntime";
import type { ExecutionMode, PoolNode, RemoteCampaign } from "../components/attack/types";
import {
  ATTACK_SCENARIOS, DEFAULT_DURATION, attackRunFromMetrics, buildAttackRun,
  buildAttackScenario, getScenario, normalizeConfig,
  type AttackKind, type AttackRun,
} from "../lib/attack";
import { startPolling } from "../lib/poll";

export function AttackPage({ scenario: mockScenario }: { scenario: MockScenario }) {
  const api = useMemo(() => createApiClient(mockScenario), [mockScenario]);
  const [kind, setKind] = useState<AttackKind>("ddos");
  const scenario = getScenario(kind);
  const [seed, setSeed] = useState(2026);
  const [scale, setScale] = useState(scenario.defaultScale);
  const [intensity, setIntensity] = useState(scenario.defaultIntensity);
  const [capacity, setCapacity] = useState(scenario.defaultCapacity);
  const [defense, setDefense] = useState(60);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(4);
  const [clock, setClock] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<ExecutionMode>("local");
  const [pool, setPool] = useState<PoolNode[]>([]);
  const [coordinator, setCoordinator] = useState("");
  const [parts, setParts] = useState(1);
  const [baseline, setBaseline] = useState(true);
  const [plan, setPlan] = useState<PartitionPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [remote, setRemote] = useState<RemoteCampaign | null>(null);
  const [remoteRun, setRemoteRun] = useState<AttackRun | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  const localRun = useMemo(
    () => buildAttackRun({ kind, seed, duration: DEFAULT_DURATION, scale, intensity, capacity, defense }),
    [kind, seed, scale, intensity, capacity, defense],
  );
  const run = remoteRun ?? localRun;
  const effectiveParts = mode === "worker" ? 1 : parts;
  const healthyCount = pool.filter((node) => node.healthy).length;
  const maxParts = Math.max(1, healthyCount);
  const executionLabel = mode === "local" ? "Local model" : mode === "worker" ? "Node worker" : `PDES · ${effectiveParts} parts`;
  const remoteRunId = remote?.runId ?? null;
  const remoteState = remote?.status?.state ?? null;
  const remoteReport = remote?.report ?? null;
  const remoteConfig = remote?.config ?? null;

  useEffect(() => {
    let active = true;
    Promise.all([api.getConfig(), api.getCluster()]).then(([config, cluster]) => {
      if (!active) return;
      const healthy = new Set(cluster.nodes.filter((node) => node.healthy).map((node) => node.id));
      const list = config.peers.map((peer) => ({ id: peer.id, healthy: healthy.has(peer.id) }));
      setPool(list);
      setCoordinator((current) => current || list.find((node) => node.healthy)?.id || list[0]?.id || "");
      setParts((current) => Math.max(1, Math.min(current, Math.max(1, healthy.size))));
    }).catch((cause: unknown) => {
      if (active) {
        setNotice({
          kind: "info",
          text: `Node pool unavailable; the local campaign remains available. ${cause instanceof Error ? cause.message : ""}`.trim(),
        });
      }
    });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    setParts((current) => Math.max(1, Math.min(current, maxParts)));
  }, [maxParts]);

  useEffect(() => {
    setPlan(null);
  }, [kind, seed, scale, intensity, capacity, defense, parts, coordinator, mode]);

  useEffect(() => {
    setRemote(null);
    setRemoteRun(null);
  }, [kind, seed, scale, intensity, capacity, defense]);

  useEffect(() => {
    if (!remoteRunId || remoteReport || remoteState === "failed") return;
    let active = true;
    const poll = async () => {
      try {
        const status = (await api.getStatus(remoteRunId)) as AttackStatus;
        if (!active) return;
        setRemote((current) => current && current.runId === remoteRunId ? { ...current, status } : current);
        if (status.state === "failed") {
          setNotice({ kind: "error", text: `Pool campaign failed: ${status.error ?? "unknown error"}. Showing the local model.` });
          return;
        }
        if (status.state === "complete") {
          const report = (await api.getReport(remoteRunId)) as AttackReport;
          if (!active) return;
          setRemote((current) => current && current.runId === remoteRunId ? { ...current, report } : current);
        }
      } catch (cause) {
        if (!active) return;
        setNotice({ kind: "error", text: `Lost the pool campaign: ${cause instanceof Error ? cause.message : "unknown error"}. Showing the local model.` });
      }
    };
    const stop = startPolling(poll, 1200);
    return () => { active = false; stop(); };
  }, [api, remoteRunId, remoteReport, remoteState]);

  useEffect(() => {
    if (!remoteReport?.metrics || !remoteConfig) return;
    setRemoteRun(attackRunFromMetrics(remoteConfig, remoteReport.metrics));
    setClock(0);
    setPlaying(true);
  }, [remoteReport, remoteConfig]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setClock((current) => Math.min(run.config.duration, current + 0.05 * speed));
    }, 50);
    return () => window.clearInterval(timer);
  }, [playing, speed, run.config.duration]);

  useEffect(() => {
    if (playing && clock >= run.config.duration) setPlaying(false);
  }, [clock, playing, run.config.duration]);

  const chooseKind = (next: AttackKind) => {
    const definition = ATTACK_SCENARIOS[next];
    setKind(next);
    setScale(definition.defaultScale);
    setIntensity(definition.defaultIntensity);
    setCapacity(definition.defaultCapacity);
    setDefense(60);
    setClock(0);
    setPlaying(true);
    setSelectedId(null);
  };

  const chooseMode = (next: ExecutionMode) => {
    setMode(next);
    setRemote(null);
    setRemoteRun(null);
    setPlan(null);
    setNotice(null);
  };

  const currentConfig = () => normalizeConfig({ kind, seed, duration: DEFAULT_DURATION, scale, intensity, capacity, defense });

  const previewPlan = async () => {
    if (!coordinator) return;
    setPlanning(true);
    setNotice(null);
    try {
      setPlan(await api.planAttack(coordinator, buildAttackScenario(currentConfig()), effectiveParts));
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : "Could not plan the attack partitions." });
    } finally {
      setPlanning(false);
    }
  };

  const runOnPool = async () => {
    if (!coordinator) {
      setNotice({ kind: "error", text: "Pick a healthy coordinator before starting a pool campaign." });
      return;
    }
    const config = currentConfig();
    setSubmitting(true);
    setNotice(null);
    try {
      const created: RunCreated = await api.createAttackRun(
        coordinator, buildAttackScenario(config), effectiveParts, config.seed, mode === "pdes" ? baseline : false,
      );
      setRemote({ runId: created.run_id, config, status: null, report: null });
      setRemoteRun(null);
      setNotice({
        kind: "info",
        text: `Started ${effectiveParts ===  1 ? "a single-worker campaign" : `a ${effectiveParts}-partition PDES campaign`} on ${coordinator}. The local model keeps playing until it completes.`,
      });
    } catch (cause) {
      const message = cause instanceof ApiError || cause instanceof Error ? cause.message : "Could not start the campaign.";
      setNotice({ kind: "error", text: `${message} Continuing with the local model.` });
      setMode("local");
      setRemote(null);
    } finally {
      setSubmitting(false);
    }
  };

  const seek = (time: number) => {
    setClock(Math.max(0, Math.min(run.config.duration, time)));
    setPlaying(false);
  };

  const togglePlay = () => {
    if (clock >= run.config.duration) {
      setClock(0);
      setPlaying(true);
      return;
    }
    setPlaying((value) => !value);
  };

  const restart = () => {
    setClock(0);
    setPlaying(true);
  };

  const resetTuning = () => {
    setScale(scenario.defaultScale);
    setIntensity(scenario.defaultIntensity);
    setCapacity(scenario.defaultCapacity);
    setDefense(60);
    setClock(0);
    setPlaying(true);
  };

  return (
    <section className="page-content attack-content" aria-labelledby="attack-heading">
      <PageHeading
        id="attack-heading"
        eyebrow="THREAT OPERATIONS"
        title="Attack"
        lede="Run a large-scale campaign against a live model of your estate, then trace the damage from first foothold to recovery."
        actionsWrap={false}
        actions={<div className="attack-head-tags">
          <span className="attack-head-tag"><Cpu size={13} />{executionLabel}</span>
          <span className="attack-head-tag">Seed {seed}</span>
        </div>}
      />

      <details className="attack-zone attack-config-zone" open>
        <summary>Configure</summary>
        <AttackConfigure
          kind={kind}
          scenario={scenario}
          scale={scale}
          intensity={intensity}
          capacity={capacity}
          defense={defense}
          seed={seed}
          onKind={chooseKind}
          onScale={setScale}
          onIntensity={setIntensity}
          onCapacity={setCapacity}
          onDefense={setDefense}
          onSeed={setSeed}
          onReset={resetTuning}
        />
      </details>

      <details className="attack-zone attack-execute-zone" open>
        <summary>Execute</summary>
        <AttackExecution
          mode={mode}
          pool={pool}
          coordinator={coordinator}
          parts={parts}
          baseline={baseline}
          plan={plan}
          planning={planning}
          submitting={submitting}
          remote={remote}
          effectiveParts={effectiveParts}
          healthyCount={healthyCount}
          maxParts={maxParts}
          onMode={chooseMode}
          onCoordinator={setCoordinator}
          onParts={setParts}
          onBaseline={setBaseline}
          onPreview={() => void previewPlan()}
          onRun={() => void runOnPool()}
        />
      </details>

      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}

      <details className="attack-zone attack-watch-zone" open>
        <summary>Watch</summary>
        <div className="attack-console" style={{ "--attack-accent": scenario.accent } as CSSProperties}>
          <AttackRuntime
            run={run}
            clock={clock}
            playing={playing}
            speed={speed}
            selectedId={selectedId}
            executionLabel={executionLabel}
            remoteRun={Boolean(remoteRun)}
            onSelect={setSelectedId}
            onSeek={seek}
            onTogglePlay={togglePlay}
            onRestart={restart}
            onSpeed={setSpeed}
          />
        </div>
      </details>

      <details className="attack-zone attack-analyze-zone">
        <summary>Analyze</summary>
        <AttackCharts run={run} clock={clock} onSeek={seek} />
      </details>

      <p className="attack-footnote">
        Deterministic campaigns are reproducible from their seed. Pool modes compute the same model remotely; the local model remains available offline.
      </p>
    </section>
  );
}
