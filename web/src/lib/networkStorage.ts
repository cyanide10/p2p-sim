import { cloneScenario, parseScenario, DEFAULT_SAMPLE, SAMPLES, type Scenario } from "./network";

const STORAGE_KEY = "p2p-sim-network-v2";

export function loadSavedNetwork(): Scenario {
  try {
    const saved = parseScenario(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
    if (saved) return saved;
  } catch {
    // Fall through to the current sample when saved data is unavailable or invalid.
  }
  return cloneScenario((SAMPLES.find((sample) => sample.id === DEFAULT_SAMPLE) ?? SAMPLES[0]).scenario);
}

export function saveNetworkScenario(scenario: Scenario): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scenario));
  } catch {
    // Keep the editor usable when browser storage is unavailable.
  }
}
