export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "--";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatNumber(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return value.toFixed(digits);
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value.toFixed(digits)}%`;
}

export function formatSpeedup(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}×`;
}

const compact = (value: number) => Number(value.toFixed(2)).toString();

/** Human-readable M/M/1 load line: arrival rate, service rate and utilisation. */
export function describeQueueLoad(lambda: number, mu: number, rho: number): string {
  if (![lambda, mu, rho].every(Number.isFinite)) return "--";
  return `~${compact(lambda)} requests/s in · service ~${compact(mu)}/s · ~${Math.round(rho * 100)}% loaded`;
}

const PDES_METRIC_LABELS: Record<string, string> = {
  sent: "Sent (packets)",
  delivered: "Delivered (packets)",
  dropped: "Dropped (packets)",
  loss_rate: "Loss rate (%)",
  mean_delay: "Mean delay (s)",
  p95_delay: "95th percentile delay (s)",
  throughput: "Throughput (packets/s)",
  utilization: "Utilization (%)",
  ci95_low: "Lower bound",
  ci95_high: "Upper bound",
  ci95_half_width: "95% CI half-width",
};

export function pdesMetricLabel(key: string): string {
  return PDES_METRIC_LABELS[key] ?? key.replaceAll("_", " ");
}

export function formatPdesMetricValue(key: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  if (key === "loss_rate" || key === "utilization") return `${(value * 100).toFixed(2)}%`;
  return Number.isInteger(value) ? value.toLocaleString() : value.toPrecision(5);
}

/** Parses "#/route/id?key=value" into its parts. */
export function parseHash(hash: string): { route: string; id: string | null; query: URLSearchParams } {
  const [path, search = ""] = hash.replace(/^#\/?/, "").split("?", 2);
  const [route = "", rawId] = path.split("/");
  let id: string | null = null;
  if (rawId) {
    try {
      id = decodeURIComponent(rawId);
    } catch {
      id = rawId;
    }
  }
  return { route: route || "cluster", id, query: new URLSearchParams(search) };
}
