import type {
  ClusterSnapshot,
  GatewayConfig,
  HealthResponse,
  MockScenario,
  NodeReport,
  NodeStatus,
  RunCreated,
  RunList,
  RunParameters,
  RunRecord,
} from "./types";
import { MockApiClient } from "./mock/MockApiClient";

export interface ApiClient {
  getConfig(): Promise<GatewayConfig>;
  getCluster(): Promise<ClusterSnapshot>;
  createRun(coordinator: string, params: RunParameters): Promise<RunCreated>;
  listRuns(limit: number, offset: number): Promise<RunList>;
  getRun(runId: string): Promise<RunRecord>;
  getStatus(runId: string): Promise<NodeStatus>;
  getReport(runId: string): Promise<NodeReport>;
  getHealth(): Promise<HealthResponse>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class HttpApiClient implements ApiClient {
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiError("The server returned invalid JSON.", response.status);
    }
    if (!response.ok) {
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? String(body.error)
          : `Request failed (${response.status}).`;
      throw new ApiError(message, response.status);
    }
    return body as T;
  }

  getConfig() {
    return this.request<GatewayConfig>("/api/config");
  }

  getCluster() {
    return this.request<ClusterSnapshot>("/api/cluster");
  }

  createRun(coordinator: string, params: RunParameters) {
    return this.request<RunCreated>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ coordinator, ...params }),
    });
  }

  listRuns(limit: number, offset: number) {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return this.request<RunList>(`/api/runs?${query}`);
  }

  getRun(runId: string) {
    return this.request<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`);
  }

  getStatus(runId: string) {
    return this.request<NodeStatus>(`/api/runs/${encodeURIComponent(runId)}/status`);
  }

  getReport(runId: string) {
    return this.request<NodeReport>(`/api/runs/${encodeURIComponent(runId)}/report`);
  }

  getHealth() {
    return this.request<HealthResponse>("/healthz");
  }
}

export function createApiClient(scenario: MockScenario): ApiClient {
  return import.meta.env.VITE_USE_MOCK === "false"
    ? new HttpApiClient()
    : new MockApiClient(scenario);
}