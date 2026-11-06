import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Session } from "@opencode-ai/sdk/client";
import type { InlineKeyboardMarkup, Update } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelegramBot } from "../src/bot.js";
import { parseConfig } from "../src/config.js";
import type { OpenCodeGateway } from "../src/opencode.js";
import { Store } from "../src/store.js";
import type { Transcriber } from "../src/transcription.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(enabled = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bot-voice-")));
  const configPath = join(directory, "transcription.json");
  await writeFile(
    configPath,
    JSON.stringify({
      defaultModel: "balanced",
      models: [
        { id: "balanced", label: "Balanced", path: "/models/base.bin" },
        { id: "fast", label: "Fast", path: "/models/tiny.bin" },
      ],
    }),
  );
  const config = parseConfig({
    TELEGRAM_BOT_TOKEN: "111111:test-token-that-is-long-enough",
    TELEGRAM_ADMIN_USER_IDS: "111",
    OPENCODE_SERVER_PASSWORD: "test-server-password",
    DEFAULT_WORKDIR: directory,
    AGENT_HOME: directory,
    ALLOWED_WORKSPACE_ROOTS: directory,
    ...(enabled ? { TRANSCRIPTION_CONFIG: configPath } : {}),
  });
  const store = new Store(":memory:");
  store.updateChatState(111, directory, {
    sessionId: "existing-session",
    modelId: "agent-model",
    providerId: "openai",
  });
  const opencode = {
    health: vi.fn<OpenCodeGateway["health"]>(),
    createSession: vi
      .fn<OpenCodeGateway["createSession"]>()
      .mockResolvedValue({ id: "new-session" } as Session),
    listSessions: vi.fn<OpenCodeGateway["listSessions"]>(),
    listModels: vi.fn<OpenCodeGateway["listModels"]>(),
    listAgents: vi.fn<OpenCodeGateway["listAgents"]>(),
    abort: vi.fn<OpenCodeGateway["abort"]>(),
    answerPermission: vi.fn<OpenCodeGateway["answerPermission"]>(),
    runPrompt: vi.fn<OpenCodeGateway["runPrompt"]>().mockResolvedValue("Done"),
  };
  const transcriber = {
    transcribe: vi
      .fn<Transcriber["transcribe"]>()
      .mockResolvedValue("Проверь сервер. Check Docker."),
  };
  const bot = createTelegramBot(config, {
    store,
    opencode,
    transcriber,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
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
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return {
      ok: true,
      result:
        method === "getFile"
          ? { file_id: "voice", file_unique_id: "unique", file_path: "voice/test.oga" }
          : method === "sendMessage" || method === "sendRichMessage"
            ? {
                message_id: calls.length,
                date: 1,
                chat: { id: 111, type: "private" },
                text: "test",
              }
            : true,
    } as never;
  });
  let updateId = 0;
  const send = (content: Record<string, unknown>, userId = 111, type = "private") =>
    bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: 1,
        chat: { id: userId, type, first_name: "Test" },
        from: { id: userId, is_bot: false, first_name: "Test" },
        ...(content.text === "/start"
          ? { entities: [{ type: "bot_command", offset: 0, length: 6 }] }
          : {}),
        ...content,
      },
    } as Update);
  const voice = (userId = 111, duration = 10, type = "private") =>
    send(
      { voice: { file_id: "voice", file_unique_id: "unique", duration, file_size: 100 } },
      userId,
      type,
    );
  const click = async (label: string, userId = 111) => {
    const button = calls
      .flatMap(
        (call) =>
          (call.payload.reply_markup as InlineKeyboardMarkup | undefined)?.inline_keyboard.flat() ??
          [],
      )
      .findLast((candidate) => candidate.text === label);
    if (!button || !("callback_data" in button)) throw new Error(`Missing button: ${label}`);
    await bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: String(updateId),
        chat_instance: "test",
        data: button.callback_data,
        from: { id: userId, is_bot: false, first_name: "Test" },
        message: {
          message_id: 77,
          date: 1,
          chat: { id: userId, type: "private", first_name: "Test" },
          text: "Menu",
        },
      },
    });
  };
  const finished = () =>
    expect.poll(() => calls.some((call) => call.method === "sendRichMessage")).toBe(true);
  cleanups.push(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, opencode, transcriber, calls, send, voice, click, finished, directory };
}

describe("voice messages", () => {
  it("submits recognized text to the existing session, workspace, and agent model", async () => {
    const test = await setup();
    await test.voice();
    await test.finished();
    expect(test.opencode.createSession).not.toHaveBeenCalled();
    expect(test.opencode.runPrompt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: "existing-session",
        directory: test.directory,
        text: "Проверь сервер. Check Docker.",
        selection: expect.objectContaining({ modelId: "agent-model" }),
      }),
    );
    expect(test.calls.some((call) => String(call.payload.text).startsWith("Heard:\n"))).toBe(true);
    expect(test.transcriber.transcribe).toHaveBeenCalledWith(
      "voice/test.oga",
      "balanced",
      expect.any(AbortSignal),
    );
  });

  it("uses an owner-bound model setting and falls back when a model is removed", async () => {
    const test = await setup();
    await test.send({ text: "/start" });
    await test.click("Voice settings");
    await test.click("Fast", 222);
    expect(test.store.getTranscriptionModel(111)).toBeUndefined();
    await test.click("Fast");
    expect(test.store.getTranscriptionModel(111)).toBe("fast");
    await test.voice();
    await test.finished();
    expect(test.transcriber.transcribe.mock.calls[0]![1]).toBe("fast");
    await new Promise<void>((resolve) => setImmediate(resolve));
    test.store.setTranscriptionModel(111, "removed");
    await test.voice();
    await expect.poll(() => test.transcriber.transcribe.mock.calls.length).toBe(2);
    expect(test.transcriber.transcribe.mock.calls[1]![1]).toBe("balanced");
  });

  it("does not download voice notes from strangers or groups, or notes above the limit", async () => {
    const test = await setup();
    await test.voice(222);
    await test.voice(111, 10, "group");
    await test.voice(111, 181);
    expect(test.calls.some((call) => call.method === "getFile")).toBe(false);
    expect(test.transcriber.transcribe).not.toHaveBeenCalled();
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
  });

  it("keeps voice disabled when unconfigured, while ordinary text still works", async () => {
    const test = await setup(false);
    await test.voice();
    expect(test.transcriber.transcribe).not.toHaveBeenCalled();
    await test.send({ text: "Plain text" });
    await test.finished();
    expect(test.opencode.runPrompt.mock.calls[0]![0].text).toBe("Plain text");
  });

  it("cancels transcription through Abort without submitting a prompt or aborting an idle agent session", async () => {
    const test = await setup();
    await test.send({ text: "/start" });
    test.transcriber.transcribe.mockImplementation(
      (_path, _model, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    );
    await test.voice();
    await expect.poll(() => test.transcriber.transcribe.mock.calls.length).toBe(1);
    await test.voice();
    await test.send({ text: "Another prompt" });
    expect(test.transcriber.transcribe).toHaveBeenCalledTimes(1);
    await test.click("Abort");
    await expect
      .poll(() => test.calls.some((call) => call.payload.text === "OpenCode was stopped."))
      .toBe(true);
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
    expect(test.opencode.abort).not.toHaveBeenCalled();
    test.transcriber.transcribe.mockResolvedValue("Try again");
    await test.voice();
    await test.finished();
    expect(test.opencode.runPrompt).toHaveBeenCalledOnce();
  });

  it.each(["", "x".repeat(12_001)])(
    "never forwards an empty or overlong transcript",
    async (transcript) => {
      const test = await setup();
      test.transcriber.transcribe.mockResolvedValue(transcript);
      await test.voice();
      await expect
        .poll(() =>
          test.calls.some((call) => String(call.payload.text).startsWith("OpenCode failed:")),
        )
        .toBe(true);
      expect(test.opencode.runPrompt).not.toHaveBeenCalled();
    },
  );

  it("rechecks authorization after transcription", async () => {
    const test = await setup();
    test.store.authorize(222, undefined, 111);
    test.transcriber.transcribe.mockImplementation(async () => {
      test.store.revoke(222);
      return "Deploy";
    });
    await test.voice(222);
    await expect
      .poll(() =>
        test.calls.some((call) => String(call.payload.text).includes("Access was revoked")),
      )
      .toBe(true);
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
  });
});
