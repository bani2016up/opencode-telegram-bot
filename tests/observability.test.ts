import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/logger.js";
import { DiagnosticError, errorDetails, RequestTrace } from "../src/observability.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("safe diagnostics", () => {
  it("extracts HTTP and nested transport codes without credentials or user content", () => {
    const secret = "sensitive-token-and-private-message";
    const transport = Object.assign(new Error(`https://host/${secret}`), { code: "ECONNRESET" });
    const error = Object.assign(new Error(secret), {
      name: "HttpError",
      error: new AggregateError([transport], secret),
      statusCode: 502,
      headers: { authorization: secret },
      payload: { text: secret },
    });
    const details = errorDetails(error);
    expect(details).toEqual({
      errorType: "HttpError",
      httpStatus: 502,
      networkCodes: ["ECONNRESET"],
    });
    expect(JSON.stringify(details)).not.toContain(secret);
  });

  it("handles Telegram rate limits, cycles, primitives, and untrusted labels", () => {
    const error = {
      name: "private-token",
      code: "PRIVATE_TOKEN",
      error_code: 429,
      parameters: { retry_after: 30, migrate_to_chat_id: "private" },
      cause: {},
    };
    error.cause = error;
    expect(errorDetails(error)).toEqual({
      errorType: "Error",
      httpStatus: 429,
      retryAfterSeconds: 30,
    });
    expect(errorDetails("private-token")).toEqual({ errorType: "UnknownError" });
  });

  it("retains sanitized metadata when an error is wrapped", () => {
    const error = new DiagnosticError("User-facing message", {
      ...errorDetails(Object.assign(new Error("secret"), { code: "ETIMEDOUT" })),
      operation: "telegram.image.download",
      httpStatus: 503,
      imageIndex: 2,
    });
    expect(errorDetails(error)).toMatchObject({
      networkCodes: ["ETIMEDOUT"],
      httpStatus: 503,
      imageIndex: 2,
    });
    expect(JSON.stringify(errorDetails(error))).not.toContain("secret");
  });
});

describe("request tracing", () => {
  it("correlates stages and waiting events, retaining the image index, then stops its timer", () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const trace = new RequestTrace(logger, { requestId: "album:1" });
    trace.setStage("telegram.image.download", { imageIndex: 3, imageCount: 4 });
    vi.advanceTimersByTime(30_000);
    expect(logger.info).toHaveBeenLastCalledWith(
      "request.waiting",
      expect.objectContaining({
        requestId: "album:1",
        stage: "telegram.image.download",
        imageIndex: 3,
        imageCount: 4,
        elapsedMs: expect.any(Number),
        stageElapsedMs: expect.any(Number),
      }),
    );
    trace.close();
    const count = logger.info.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(logger.info).toHaveBeenCalledTimes(count);
  });

  it("keeps JSON output and log-level filtering", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createLogger("warn");
    logger.info("hidden");
    logger.warn("request.failed", { requestId: "album:1", ...errorDetails(new Error("secret")) });
    expect(log).not.toHaveBeenCalled();
    expect(JSON.parse(warn.mock.calls[0]![0])).toMatchObject({
      level: "warn",
      requestId: "album:1",
      errorType: "Error",
    });
    expect(warn.mock.calls[0]![0]).not.toContain("secret");
  });
});
