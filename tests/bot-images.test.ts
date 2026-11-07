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
import type { ImageLoader } from "../src/images.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bot-images-")));
  const config = parseConfig({
    TELEGRAM_BOT_TOKEN: "111111:test-token-that-is-long-enough",
    TELEGRAM_ADMIN_USER_IDS: "111",
    OPENCODE_SERVER_PASSWORD: "test-server-password",
    DEFAULT_WORKDIR: directory,
    AGENT_HOME: directory,
    ALLOWED_WORKSPACE_ROOTS: directory,
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
  const image = {
    mime: "image/png" as const,
    filename: "image.png",
    url: "data:image/png;base64,aW1hZ2U=",
  };
  const imageLoader = { load: vi.fn<ImageLoader["load"]>().mockResolvedValue(image) };
  const bot = createTelegramBot(config, {
    store,
    opencode,
    imageLoader,
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
          ? { file_id: "image", file_unique_id: "unique", file_path: "photos/test.png" }
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
  const photo = (userId = 111, type = "private", extra: Record<string, unknown> = {}) =>
    send(
      {
        photo: [
          { file_id: "small", file_unique_id: "small", width: 90, height: 90, file_size: 100 },
          { file_id: "large", file_unique_id: "large", width: 1280, height: 960, file_size: 1000 },
        ],
        caption: "Record today's expenses.",
        ...extra,
      },
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
  return { store, opencode, imageLoader, image, calls, send, photo, click, finished, directory };
}

describe("image messages", () => {
  it("submits the largest photo and caption in the existing session with a stable source ID", async () => {
    const test = await setup();
    await test.photo();
    await test.finished();
    expect(test.calls.find((call) => call.method === "getFile")?.payload.file_id).toBe("large");
    expect(test.opencode.createSession).not.toHaveBeenCalled();
    expect(test.opencode.runPrompt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: "existing-session",
        directory: test.directory,
        text: "Record today's expenses.",
        sourceId: "telegram:111:1",
        images: [test.image],
        selection: expect.objectContaining({ modelId: "agent-model" }),
      }),
    );
  });

  it("accepts an image sent as a document with a caption", async () => {
    const test = await setup();
    await test.send({
      document: {
        file_id: "document",
        file_unique_id: "doc",
        file_name: "receipt.png",
        mime_type: "image/png",
      },
      caption: "Read this receipt.",
    });
    await test.finished();
    expect(test.calls.find((call) => call.method === "getFile")?.payload.file_id).toBe("document");
    expect(test.opencode.runPrompt.mock.calls[0]![0]).toMatchObject({
      text: "Read this receipt.",
      images: [test.image],
    });
  });

  it("uses a descriptive request for an image without a caption", async () => {
    const test = await setup();
    await test.photo(111, "private", { caption: "" });
    await test.finished();
    expect(test.opencode.runPrompt.mock.calls[0]![0].text).toBe("Describe this image.");
  });

  it("does not download unauthorized, group, oversized, or overlong requests", async () => {
    const test = await setup();
    await test.photo(222);
    await test.photo(111, "group");
    await test.send({ document: { file_id: "big", file_unique_id: "big", file_size: 20_000_001 } });
    await test.photo(111, "private", { caption: "x".repeat(12_001) });
    expect(test.calls.some((call) => call.method === "getFile")).toBe(false);
    expect(test.imageLoader.load).not.toHaveBeenCalled();
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
  });

  it("waits for a workspace path before downloading images", async () => {
    const test = await setup();
    test.store.updateChatState(111, test.directory, { awaiting: "workspace" });
    await test.photo();
    expect(test.imageLoader.load).not.toHaveBeenCalled();
    expect(
      test.calls.some((call) => String(call.payload.text).includes("workspace path as text")),
    ).toBe(true);
  });

  it("reports a rejected file and releases the user for the next request", async () => {
    const test = await setup();
    test.imageLoader.load.mockRejectedValueOnce(
      new Error("Please send a JPEG, PNG, or WebP image."),
    );
    await test.photo();
    await expect
      .poll(() =>
        test.calls.some((call) => String(call.payload.text).includes("Please send a JPEG")),
      )
      .toBe(true);
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
    await test.send({ text: "Next request" });
    await test.finished();
    expect(test.opencode.runPrompt).toHaveBeenCalledOnce();
  });

  it("rechecks authorization after downloading", async () => {
    const test = await setup();
    test.store.authorize(222, undefined, 111);
    test.imageLoader.load.mockImplementation(async () => {
      test.store.revoke(222);
      return test.image;
    });
    await test.photo(222);
    await expect
      .poll(() =>
        test.calls.some((call) => String(call.payload.text).includes("Access was revoked")),
      )
      .toBe(true);
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
  });

  it("supports Abort during download and prevents concurrent submissions", async () => {
    const test = await setup();
    await test.send({ text: "/start" });
    test.imageLoader.load.mockImplementation(
      (_path, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    );
    await test.photo();
    await expect.poll(() => test.imageLoader.load.mock.calls.length).toBe(1);
    await test.photo();
    await test.send({ text: "Concurrent request" });
    expect(test.imageLoader.load).toHaveBeenCalledOnce();
    await test.click("Abort");
    await expect
      .poll(() => test.calls.some((call) => call.payload.text === "OpenCode was stopped."))
      .toBe(true);
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
    expect(test.opencode.abort).not.toHaveBeenCalled();
    test.imageLoader.load.mockResolvedValue(test.image);
    await test.photo();
    await test.finished();
    expect(test.opencode.runPrompt).toHaveBeenCalledOnce();
  });
});
