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
