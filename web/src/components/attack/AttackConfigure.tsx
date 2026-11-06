import { Bug, CloudLightning, Crosshair, Database, RotateCcw } from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import {
  ATTACK_ORDER, ATTACK_SCENARIOS, compact,
  type AttackKind, type AttackScenario,
} from "../../lib/attack";

const SCENARIO_ICONS: Record<AttackKind, ReactNode> = {
  ddos: <CloudLightning size={18} />,
  synflood: <Crosshair size={18} />,
  worm: <Bug size={18} />,
  exfil: <Database size={18} />,
};

const severityLabel: Record<string, string> = {
  critical: "Critical",
  high: "High",
  stealth: "Stealth",
};

function RangeControl({
  label, value, display, min, max, step, onChange,
}: {
  label: string; value: number; display: string; min: number; max: number; step: number; onChange: (value: number) => void;
}) {
  return (
    <label className="attack-range">
      <span className="attack-range-head"><span>{label}</span><strong>{display}</strong></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

interface Props {
  kind: AttackKind;
  scenario: AttackScenario;
  scale: number;
  intensity: number;
  capacity: number;
  defense: number;
  seed: number;
  onKind: (kind: AttackKind) => void;
  onScale: (value: number) => void;
  onIntensity: (value: number) => void;
  onCapacity: (value: number) => void;
  onDefense: (value: number) => void;
  onSeed: (value: number) => void;
  onReset: () => void;
}

/** Scenario picker, campaign description and the primary tuning sliders. */
export function AttackConfigure({
  kind, scenario, scale, intensity, capacity, defense, seed,
  onKind, onScale, onIntensity, onCapacity, onDefense, onSeed, onReset,
}: Props) {
  const capacityStep = kind === "worm" ? 5 : kind === "ddos" ? 1 : 0.1;
  const moveScenario = (event: KeyboardEvent<HTMLButtonElement>, current: AttackKind) => {
    const index = ATTACK_ORDER.indexOf(current);
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (index + 1) % ATTACK_ORDER.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (index - 1 + ATTACK_ORDER.length) % ATTACK_ORDER.length
        : event.key === "Home" ? 0
          : event.key === "End" ? ATTACK_ORDER.length - 1 : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = ATTACK_ORDER[nextIndex];
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
    onKind(next);
  };
  return (
    <section className="attack-configure" aria-label="Configure campaign">
      <div className="attack-scenarios" role="radiogroup" aria-label="Attack scenario">
        {ATTACK_ORDER.map((id) => {
          const definition = ATTACK_SCENARIOS[id];
          return (
            <button key={id} type="button" role="radio" aria-checked={kind === id}
              tabIndex={kind === id ? 0 : -1}
              className={`attack-scenario ${kind === id ? "is-active" : ""}`}
              style={{ "--attack-accent": definition.accent } as CSSProperties}
              onClick={() => onKind(id)}
              onKeyDown={(event) => moveScenario(event, id)}>
              <span className="attack-scenario-icon">{SCENARIO_ICONS[id]}</span>
              <span className="attack-scenario-copy">
                <small>{definition.codename}</small>
                <strong>{definition.label}</strong>
                <em>{definition.tagline}</em>
              </span>
              <span className={`attack-severity severity-${definition.severity}`}>{severityLabel[definition.severity]}</span>
            </button>
          );
        })}
      </div>

      <p className="attack-brief">{scenario.description}</p>

      <div className="attack-tune">
        <RangeControl label={scenario.scaleLabel} value={scale} display={compact(scale, 1)} min={500} max={200_000} step={500} onChange={onScale} />
        <RangeControl label="Attack intensity" value={intensity} display={`${intensity.toFixed(0)} / 10`} min={1} max={10} step={1} onChange={onIntensity} />
        <RangeControl label={scenario.capacityLabel} value={capacity} display={`${compact(capacity, 1)} ${scenario.unit}`}
          min={capacityStep} max={scenario.defaultCapacity * 4} step={capacityStep} onChange={onCapacity} />
        <RangeControl label="Defensive posture" value={defense} display={`${defense}%`} min={0} max={100} step={5} onChange={onDefense} />
        <label className="attack-seed">
          <span>Campaign seed</span>
          <div>
            <input type="number" min={0} step={1} value={seed} onChange={(event) => onSeed(Math.max(0, Math.round(Number(event.target.value) || 0)))} />
            <button type="button" className="icon-button" title="New random seed" aria-label="New random seed" onClick={() => onSeed(Math.floor(Math.random() * 1_000_000))}>
              <RotateCcw size={15} />
            </button>
          </div>
        </label>
        <button type="button" className="ghost-button attack-reset" onClick={onReset}>Reset tuning</button>
      </div>
    </section>
  );
}
