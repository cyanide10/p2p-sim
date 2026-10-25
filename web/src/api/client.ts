import type {
  ClusterSnapshot,
  GatewayConfig,
  HealthResponse,
  MockScenario,
  NetworkReport,
  NodeReport,
  NodeStatus,
  RunCreated,
  RunList,
  RunParameters,
  RunRecord,
} from "./types";
import type { NetStreamEvent, Scenario } from "../lib/network";
import { createSseParser, type TrafficEvent, type TrafficParams } from "../lib/traffic";
import { MockApiClient } from "./mock/MockApiClient";

/** Receives live traffic events; returns nothing. Closing is via the returned function. */
export type TrafficHandler = (event: TrafficEvent) => void;

export interface ApiClient {
  getConfig(): Promise<GatewayConfig>;
  getCluster(): Promise<ClusterSnapshot>;
  createRun(coordinator: string, params: RunParameters): Promise<RunCreated>;
  listRuns(limit: number, offset: number): Promise<RunList>;
  getRun(runId: string): Promise<RunRecord>;
  getStatus(runId: string): Promise<NodeStatus>;
  getReport(runId: string): Promise<NodeReport | NetworkReport>;
  getHealth(): Promise<HealthResponse>;
  /** Streams one live replication run on params.node. Returns a function that stops it. */
  openTraffic(params: TrafficParams, onEvent: TrafficHandler): () => void;
  /** Starts a network-scenario batch distributed over the pool. */
  createNetworkRun(coordinator: string, scenario: Scenario, replications: number, baseSeed: number): Promise<RunCreated>;
  /** Streams one live run of a network scenario on node. Returns a function that stops it. */
  openNetworkTraffic(node: string, scenario: Scenario, speed: number, seed: number, start: number, onEvent: (event: NetStreamEvent) => void): () => void;
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

  openTraffic(params: TrafficParams, onEvent: TrafficHandler) {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    return readEventStream<TrafficEvent>(`/api/stream?${query}`, undefined, onEvent);
  }

  createNetworkRun(coordinator: string, scenario: Scenario, replications: number, baseSeed: number) {
    return this.request<RunCreated>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ coordinator, kind: "network", scenario, replications, base_seed: baseSeed }),
    });
  }

  openNetworkTraffic(node: string, scenario: Scenario, speed: number, seed: number, start: number, onEvent: (event: NetStreamEvent) => void) {
    return readEventStream<NetStreamEvent>("/api/netstream", JSON.stringify({ node, scenario, speed, seed, start }), onEvent);
  }
}

/** Reads a Server-Sent Events response with fetch, so error bodies keep their message. */
function readEventStream<E>(url: string, body: string | undefined, onEvent: (event: E | { type: "error"; message: string }) => void): () => void {
  const controller = new AbortController();
  const fail = (message: string) => onEvent({ type: "error", message });
  void (async () => {
    try {
      const response = await fetch(url, {
        method: body ? "POST" : "GET",
        body,
        signal: controller.signal,
        headers: { Accept: "text/event-stream", ...(body ? { "Content-Type": "application/json" } : {}) },
      });
      if (!response.ok || !response.body) {
        let message = `Stream request failed (${response.status}).`;
        try {
          const err = await response.json() as { error?: string };
          if (err.error) message = err.error;
        } catch { /* keep the generic message */ }
        fail(message);
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      const push = createSseParser((data) => {
        try {
          onEvent(JSON.parse(data) as E);
        } catch {
          fail("The node sent an unreadable event.");
        }
      });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        push(value);
      }
    } catch (cause) {
      if (!controller.signal.aborted) fail(cause instanceof Error ? cause.message : "The stream was interrupted.");
    }
  })();
  return () => controller.abort();
}

export function createApiClient(scenario: MockScenario): ApiClient {
  return import.meta.env.VITE_USE_MOCK === "false"
    ? new HttpApiClient()
    : new MockApiClient(scenario);
}