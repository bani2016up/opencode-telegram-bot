import { performance } from "node:perf_hooks";

import type { Logger } from "./logger.js";

const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "AggregateError",
  "GrammyError",
  "HttpError",
  "APIError",
  "DiagnosticError",
]);
const networkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ABORT_ERR",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "UND_ERR_RESPONSE_STATUS_CODE",
]);

export class DiagnosticError extends Error {
  override readonly name = "DiagnosticError";

  // Details must contain only application-owned labels and numeric metadata.
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Never serialize upstream messages, stacks, request bodies, URLs, or headers. */
export function errorDetails(error: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const codes = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return;
    seen.add(value);
    const entry = value as Record<string, unknown>;
    if (depth === 0)
      result.errorType =
        typeof entry.name === "string" && errorNames.has(entry.name) ? entry.name : "Error";
    if (typeof entry.code === "string" && networkCodes.has(entry.code)) codes.add(entry.code);
    for (const status of [entry.status, entry.statusCode, entry.error_code]) {
      if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599)
        result.httpStatus ??= status;
    }
    const parameters = entry.parameters as { retry_after?: unknown } | undefined;
    if (typeof parameters?.retry_after === "number" && Number.isFinite(parameters.retry_after))
      result.retryAfterSeconds = parameters.retry_after;
    visit(entry.cause, depth + 1);
    visit(entry.error, depth + 1); // grammY HttpError wraps its transport error here.
    visit(entry.data, depth + 1); // OpenCode APIError metadata.
    if (Array.isArray(entry.errors))
      for (const child of entry.errors.slice(0, 4)) visit(child, depth + 1);
  };
  visit(error);
  result.errorType ??= "UnknownError";
  if (codes.size) result.networkCodes = [...codes];
  if (error instanceof DiagnosticError) Object.assign(result, error.details);
  return result;
}

export class RequestTrace {
  private readonly started = performance.now();
  private stageStarted = this.started;
  private stage = "prepare";
  private stageFields: Record<string, unknown> = {};
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly logger: Logger,
    private readonly context: Record<string, unknown>,
  ) {
    this.log("request.started");
    this.timer = setInterval(() => this.log("request.waiting"), 30_000);
    this.timer.unref();
  }

  setStage(stage: string, fields: Record<string, unknown> = {}): void {
    const previousStage = this.stage;
    const previousStageElapsedMs = Math.round(performance.now() - this.stageStarted);
    this.stage = stage;
    this.stageFields = fields;
    this.stageStarted = performance.now();
    this.log("request.stage", { previousStage, previousStageElapsedMs });
  }

  annotate(fields: Record<string, unknown>): void {
    Object.assign(this.context, fields);
  }

  log(
    event: string,
    fields: Record<string, unknown> = {},
    level: "info" | "warn" | "error" = "info",
  ): void {
    this.logger[level](event, {
      ...this.context,
      ...this.stageFields,
      stage: this.stage,
      elapsedMs: Math.round(performance.now() - this.started),
      stageElapsedMs: Math.round(performance.now() - this.stageStarted),
      ...fields,
    });
  }

  close(): void {
    clearInterval(this.timer);
  }
}
