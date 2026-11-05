import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Session } from "@opencode-ai/sdk/client";
import type { InlineKeyboardMarkup, Update } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelegramBot } from "../src/bot.js";
import { parseConfig } from "../src/config.js";
import type { OpenCodeGateway } from "../src/opencode.js";
import { Store } from "../src/store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "permission-buttons-")));
  const config = parseConfig({
    TELEGRAM_BOT_TOKEN: "111111:test-token-that-is-long-enough",
    TELEGRAM_ADMIN_USER_IDS: "111",
    OPENCODE_SERVER_PASSWORD: "test-server-password",
    DEFAULT_WORKDIR: directory,
    AGENT_HOME: directory,
    ALLOWED_WORKSPACE_ROOTS: directory,
  });
  const store = new Store(":memory:");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const opencode = {
    health: vi.fn<OpenCodeGateway["health"]>(),
    createSession: vi
      .fn<OpenCodeGateway["createSession"]>()
      .mockResolvedValue({ id: "ses_test" } as Session),
    listSessions: vi.fn<OpenCodeGateway["listSessions"]>(),
    listModels: vi.fn<OpenCodeGateway["listModels"]>(),
    listAgents: vi.fn<OpenCodeGateway["listAgents"]>(),
    abort: vi.fn<OpenCodeGateway["abort"]>(),
    answerPermission: vi.fn<OpenCodeGateway["answerPermission"]>().mockResolvedValue(),
    runPrompt: vi.fn<OpenCodeGateway["runPrompt"]>().mockImplementation(async (options) => {
      await options.onActivity({
        type: "permission",
        request: {
          id: "per_test",
          sessionId: "ses_test",
          title: "bash",
          type: "bash",
          pattern: ["pwd"],
          always: ["pwd *"],
          metadata: {},
        },
      });
      await pending;
      return "Done";
    }),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const bot = createTelegramBot(config, { store, opencode, logger });
  bot.botInfo = {
    id: 333,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const failures = new Set<string>();
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (failures.has(method)) throw new Error("Simulated Telegram failure");
    return {
      ok: true,
      result:
        method === "sendMessage" || method === "sendRichMessage"
          ? { message_id: 77, date: 1, chat: { id: 111, type: "private" }, text: "test" }
          : true,
    } as never;
  });
  cleanups.push(async () => {
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private", first_name: "Test" },
      from: { id: 111, is_bot: false, first_name: "Test" },
      text: "test",
    },
  });
  const permission = () =>
    calls.find(
      (call) =>
        call.method === "sendMessage" &&
        String(call.payload.text).startsWith("OpenCode requests permission"),
    );
  await expect.poll(permission).toBeDefined();
  const markup = permission()!.payload.reply_markup as InlineKeyboardMarkup;
  const buttons = markup.inline_keyboard.flat();
  expect(buttons.map((button) => button.text)).toEqual(["Allow once", "Allow always", "Deny"]);
  expect(permission()!.payload.text).toContain("Always allows: pwd * (this session)");
  let updateId = 1;
  const click = async (label: string, userId = 111) => {
    const button = buttons.find((candidate) => candidate.text === label);
    if (!button || !("callback_data" in button)) throw new Error("Missing permission button");
    const update: Update = {
      update_id: ++updateId,
      callback_query: {
        id: String(updateId),
        chat_instance: "test-chat",
        data: button.callback_data,
        from: { id: userId, is_bot: false, first_name: "Test" },
        message: {
          message_id: 77,
          date: 1,
          chat: { id: userId, type: "private", first_name: "Test" },
          text: "Permission",
        },
      },
    };
    await bot.handleUpdate(update);
  };
  return { opencode, calls, failures, logger, click, directory };
}

describe("permission buttons", () => {
  it.each([
    ["Allow once", "once"],
    ["Allow always", "always"],
  ] as const)("%s is owner-bound, used once, and removes its message", async (label, response) => {
    const test = await setup();
    await test.click(label, 222);
    expect(test.opencode.answerPermission).not.toHaveBeenCalled();
    expect(test.calls.some((call) => call.method === "deleteMessage")).toBe(false);
    await test.click(label);
    expect(test.opencode.answerPermission).toHaveBeenCalledExactlyOnceWith(
      "ses_test",
      "per_test",
      test.directory,
      response,
    );
    expect(test.calls.filter((call) => call.method === "deleteMessage")).toEqual([
      { method: "deleteMessage", payload: { chat_id: 111, message_id: 77 } },
    ]);
    expect(test.calls.some((call) => call.method === "editMessageText")).toBe(false);
    await test.click(label);
    expect(test.opencode.answerPermission).toHaveBeenCalledTimes(1);
  });

  it("keeps a denial visible", async () => {
    const test = await setup();
    await test.click("Deny");
    expect(test.opencode.answerPermission).toHaveBeenCalledExactlyOnceWith(
      "ses_test",
      "per_test",
      test.directory,
      "reject",
    );
    expect(test.calls.some((call) => call.method === "deleteMessage")).toBe(false);
    expect(test.calls.find((call) => call.method === "editMessageText")?.payload.text).toBe(
      "Permission denied.",
    );
  });

  it("does not delete a message when OpenCode rejects the decision", async () => {
    const test = await setup();
    test.opencode.answerPermission.mockRejectedValueOnce(new Error("OpenCode unavailable"));
    await expect(test.click("Allow always")).rejects.toThrow("OpenCode unavailable");
    expect(test.calls.some((call) => call.method === "deleteMessage")).toBe(false);
  });

  it("removes the buttons if Telegram cannot delete the approved message", async () => {
    const test = await setup();
    test.failures.add("deleteMessage");
    await test.click("Allow always");
    expect(test.opencode.answerPermission).toHaveBeenCalledTimes(1);
    expect(
      test.calls.find((call) => call.method === "editMessageReplyMarkup")?.payload.reply_markup,
    ).toEqual({ inline_keyboard: [] });
    expect(test.logger.warn).toHaveBeenCalledOnce();
  });
});
