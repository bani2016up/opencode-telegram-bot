import { accessSync, constants, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  TELEGRAM_ADMIN_USER_IDS: z.string().min(1),
  TELEGRAM_ADMIN_USERNAMES: z.string().optional().default(""),
  OPENCODE_BASE_URL: z.url().default("http://127.0.0.1:4096"),
  OPENCODE_SERVER_USERNAME: z.string().min(1).default("opencode"),
  OPENCODE_SERVER_PASSWORD: z.string().min(16),
  DATABASE_PATH: z.string().min(1).default("./data/bot.sqlite"),
  DEFAULT_WORKDIR: z.string().min(1),
  AGENT_HOME: z.string().min(1),
  ALLOWED_WORKSPACE_ROOTS: z.string().min(1),
  ACCESS_REQUEST_TTL_SECONDS: positiveInteger.default(900),
  CALLBACK_TTL_SECONDS: positiveInteger.default(600),
  MAX_PROMPT_LENGTH: positiveInteger.default(12_000),
  STREAM_INTERVAL_MS: positiveInteger.default(500),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = ReturnType<typeof parseConfig>;

function parseIds(value: string): ReadonlySet<number> {
  const ids = value.split(",").map((item) => Number(item.trim()));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("TELEGRAM_ADMIN_USER_IDS must contain positive numeric Telegram IDs");
  }
  return new Set(ids);
}

function validateLoopbackBaseUrl(value: string): string {
  const url = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error("OPENCODE_BASE_URL must use HTTP on a loopback address");
  }
  return url.toString().replace(/\/$/, "");
}

function isWithin(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

export function parseConfig(environment: NodeJS.ProcessEnv) {
  const values = schema.parse(environment);
  const defaultWorkdir = realpathSync(resolve(values.DEFAULT_WORKDIR));
  const agentHome = realpathSync(resolve(values.AGENT_HOME));
  const rootValues = values.ALLOWED_WORKSPACE_ROOTS.split(",").map((root) => root.trim());
  if (rootValues.some((root) => !root))
    throw new Error("ALLOWED_WORKSPACE_ROOTS contains an empty path");
  const allowedRoots = rootValues.map((root) => realpathSync(resolve(root)));

  if (!isAbsolute(defaultWorkdir) || !isAbsolute(agentHome)) {
    throw new Error("DEFAULT_WORKDIR and AGENT_HOME must be absolute paths");
  }
  accessSync(defaultWorkdir, constants.R_OK | constants.X_OK);
  if (!allowedRoots.some((root) => isWithin(defaultWorkdir, root))) {
    throw new Error("DEFAULT_WORKDIR must be contained by ALLOWED_WORKSPACE_ROOTS");
  }

  return {
    telegramToken: values.TELEGRAM_BOT_TOKEN,
    adminUserIds: parseIds(values.TELEGRAM_ADMIN_USER_IDS),
    adminUsernames: values.TELEGRAM_ADMIN_USERNAMES.split(",")
      .map((name) => name.trim().replace(/^@/, ""))
      .filter(Boolean),
    opencodeBaseUrl: validateLoopbackBaseUrl(values.OPENCODE_BASE_URL),
    opencodeUsername: values.OPENCODE_SERVER_USERNAME,
    opencodePassword: values.OPENCODE_SERVER_PASSWORD,
    databasePath: resolve(values.DATABASE_PATH),
    defaultWorkdir,
    agentHome,
    allowedRoots,
    accessRequestTtlMs: values.ACCESS_REQUEST_TTL_SECONDS * 1000,
    callbackTtlMs: values.CALLBACK_TTL_SECONDS * 1000,
    maxPromptLength: values.MAX_PROMPT_LENGTH,
    streamIntervalMs: values.STREAM_INTERVAL_MS,
    logLevel: values.LOG_LEVEL,
  } as const;
}

export function loadConfig(): AppConfig {
  loadDotenv();
  return parseConfig(process.env);
}
