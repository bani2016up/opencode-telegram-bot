import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("parseConfig", () => {
  it("parses numeric admin IDs and loopback OpenCode settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-config-"));
    temporaryDirectories.push(directory);
    const config = parseConfig({
      TELEGRAM_BOT_TOKEN: "test-token-that-is-long-enough",
      TELEGRAM_ADMIN_USER_IDS: "123,456",
      OPENCODE_BASE_URL: "http://127.0.0.1:4096",
      OPENCODE_SERVER_PASSWORD: "a-secure-random-password",
      DEFAULT_WORKDIR: directory,
      AGENT_HOME: directory,
      ALLOWED_WORKSPACE_ROOTS: directory,
    });
    expect(config.adminUserIds).toEqual(new Set([123, 456]));
  });

  it("rejects usernames in the administrator ID field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-config-"));
    temporaryDirectories.push(directory);
    expect(() =>
      parseConfig({
        TELEGRAM_BOT_TOKEN: "test-token-that-is-long-enough",
        TELEGRAM_ADMIN_USER_IDS: "@owner",
        OPENCODE_SERVER_PASSWORD: "a-secure-random-password",
        DEFAULT_WORKDIR: directory,
        AGENT_HOME: directory,
        ALLOWED_WORKSPACE_ROOTS: directory,
      }),
    ).toThrow("numeric Telegram IDs");
  });

  it("rejects a remotely exposed OpenCode endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-config-"));
    temporaryDirectories.push(directory);
    expect(() =>
      parseConfig({
        TELEGRAM_BOT_TOKEN: "test-token-that-is-long-enough",
        TELEGRAM_ADMIN_USER_IDS: "123",
        OPENCODE_BASE_URL: "https://agent.example.com",
        OPENCODE_SERVER_PASSWORD: "a-secure-random-password",
        DEFAULT_WORKDIR: directory,
        AGENT_HOME: directory,
        ALLOWED_WORKSPACE_ROOTS: directory,
      }),
    ).toThrow("loopback");
  });

  it("rejects a default workspace outside the allowed roots", async () => {
    const defaultDirectory = await mkdtemp(join(tmpdir(), "opencode-default-"));
    const allowedDirectory = await mkdtemp(join(tmpdir(), "opencode-allowed-"));
    temporaryDirectories.push(defaultDirectory, allowedDirectory);
    expect(() =>
      parseConfig({
        TELEGRAM_BOT_TOKEN: "test-token-that-is-long-enough",
        TELEGRAM_ADMIN_USER_IDS: "123",
        OPENCODE_SERVER_PASSWORD: "a-secure-random-password",
        DEFAULT_WORKDIR: defaultDirectory,
        AGENT_HOME: defaultDirectory,
        ALLOWED_WORKSPACE_ROOTS: allowedDirectory,
      }),
    ).toThrow("DEFAULT_WORKDIR");
  });
});
