import { createServer } from "node:http";
import type { Server } from "node:http";
import { performance } from "node:perf_hooks";

import type { Transformer } from "grammy";

import type { Logger } from "./logger.js";
import { errorDetails } from "./observability.js";

export class PollingHealth {
  private lastSuccess: number | undefined;
  private failed = false;
  private reportedReason: string | undefined;
  stopping = false;

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly logger?: Logger,
  ) {}

  get reason(): string {
    const reason = this.stopping
      ? "stopping"
      : this.failed
        ? "polling_failed"
        : this.lastSuccess === undefined
          ? "starting"
          : this.clock() - this.lastSuccess > 90_000
            ? "polling_stale"
            : "ready";
    if (reason !== this.reportedReason) {
      this.logger?.[reason === "polling_failed" || reason === "polling_stale" ? "warn" : "info"](
        "telegram.polling.state",
        { reason, previousReason: this.reportedReason },
      );
      this.reportedReason = reason;
    }
    return reason;
  }

  readonly track: Transformer = async (previous, method, payload, signal) => {
    try {
      const result = await previous(method, payload, signal);
      if (method === "getUpdates") {
        if (!result.ok && !this.failed)
          this.logger?.warn("telegram.polling.failed", errorDetails(result));
        this.failed = !result.ok;
        if (result.ok) this.lastSuccess = this.clock();
        void this.reason;
      }
      return result;
    } catch (error) {
      if (method === "getUpdates") {
        if (!this.failed) this.logger?.warn("telegram.polling.failed", errorDetails(error));
        this.failed = true;
        void this.reason;
      }
      throw error;
    }
  };
}

export function createHealthServer(health: PollingHealth): Server {
  return createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
    } else if (request.url === "/healthz") {
      response.end(JSON.stringify({ status: "alive" }));
    } else if (request.url === "/readyz") {
      const reason = health.reason;
      response.statusCode = reason === "ready" ? 200 : 503;
      response.end(JSON.stringify({ status: reason === "ready" ? "ready" : "not_ready", reason }));
    } else {
      response.writeHead(404).end();
    }
  });
}

export async function startHealthServer(
  health: PollingHealth,
  portValue: string | undefined,
): Promise<Server | undefined> {
  if (!portValue?.trim()) return undefined;
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HEALTH_PORT must be between 1 and 65535");
  }
  const server = createHealthServer(health);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
