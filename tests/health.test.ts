import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { createHealthServer, PollingHealth, startHealthServer } from "../src/health.js";

describe("polling readiness", () => {
  it("logs polling failure and recovery once per transition without Telegram payloads", async () => {
    let now = 0;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const health = new PollingHealth(() => now, logger);
    const request = vi.fn().mockResolvedValue({ ok: true, result: [{ text: "private text" }] });
    await health.track(request, "getUpdates", {});
    await health.track(request, "getUpdates", {});
    expect(logger.info).toHaveBeenCalledTimes(1);
    const error = Object.assign(new Error("private-token"), { code: "ECONNRESET" });
    request.mockRejectedValue(error);
    for (let i = 0; i < 2; i++)
      await expect(health.track(request, "getUpdates", {})).rejects.toThrow();
    expect(
      logger.warn.mock.calls.filter(([event]) => event === "telegram.polling.failed"),
    ).toHaveLength(1);
    request.mockResolvedValue({ ok: true, result: [] });
    await health.track(request, "getUpdates", {});
    expect(logger.info).toHaveBeenLastCalledWith("telegram.polling.state", {
      reason: "ready",
      previousReason: "polling_failed",
    });
    now = 90_001;
    expect(health.reason).toBe("polling_stale");
    expect(logger.warn).toHaveBeenLastCalledWith("telegram.polling.state", {
      reason: "polling_stale",
      previousReason: "ready",
    });
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toContain(
      "private",
    );
  });

  it("reports startup, polling failures, recovery, stale polling, and shutdown", async () => {
    let now = 0;
    const health = new PollingHealth(() => now);
    const request = vi.fn().mockResolvedValue({ ok: true, result: [] });
    const server = createHealthServer(health);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${url}/readyz`)).status).toBe(503);
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
      await health.track(request, "getUpdates", {});
      expect((await fetch(`${url}/readyz`)).status).toBe(200);

      request.mockRejectedValueOnce(new Error("sensitive upstream error"));
      await expect(health.track(request, "getUpdates", {})).rejects.toThrow();
      const failed = await fetch(`${url}/readyz`);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ status: "not_ready", reason: "polling_failed" });
      expect((await fetch(`${url}/healthz`)).status).toBe(200);

      await health.track(request, "getUpdates", {});
      expect((await fetch(`${url}/readyz`)).status).toBe(200);
      now = 90_001;
      const stale = await fetch(`${url}/readyz`);
      expect(stale.status).toBe(503);
      expect((await stale.json()).reason).toBe("polling_stale");
      health.stopping = true;
      expect((await (await fetch(`${url}/readyz`)).json()).reason).toBe("stopping");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not let other API methods or rejected Telegram responses indicate readiness", async () => {
    const health = new PollingHealth();
    const request = vi.fn().mockResolvedValue({ ok: true, result: [] });
    await health.track(request, "getMe", {});
    expect(health.reason).toBe("starting");
    request.mockResolvedValueOnce({ ok: false, error_code: 409, description: "Conflict" });
    await health.track(request, "getUpdates", {});
    expect(health.reason).toBe("polling_failed");
    await health.track(request, "getMe", {});
    expect(health.reason).toBe("polling_failed");
  });

  it("keeps monitoring opt-in and rejects invalid ports", async () => {
    const health = new PollingHealth();
    expect(await startHealthServer(health, undefined)).toBeUndefined();
    await expect(startHealthServer(health, "0")).rejects.toThrow("HEALTH_PORT");
    await expect(startHealthServer(health, "65536")).rejects.toThrow("HEALTH_PORT");
  });
});
