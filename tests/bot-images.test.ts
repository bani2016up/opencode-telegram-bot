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
import { DiagnosticError } from "../src/observability.js";

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
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const bot = createTelegramBot(config, {
    store,
    opencode,
    imageLoader,
    logger,
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
          ? {
              file_id: "image",
              file_unique_id: "unique",
              file_path: `photos/${(payload as { file_id: string }).file_id}.png`,
            }
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
  return {
    store,
    opencode,
    imageLoader,
    image,
    calls,
    send,
    photo,
    click,
    finished,
    directory,
    logger,
    bot,
  };
}

describe("image messages", () => {
  it("correlates an album from collection through response delivery without logging contents", async () => {
    const test = await setup();
    await test.photo(111, "private", { media_group_id: "album-log", caption: "PRIVATE CAPTION" });
    await test.photo(111, "private", { media_group_id: "album-log", caption: undefined });
    await expect
      .poll(() => test.calls.some((call) => call.method === "sendRichMessage"), { timeout: 3000 })
      .toBe(true);
    await expect
      .poll(() => test.logger.info.mock.calls.some(([event]) => event === "request.completed"))
      .toBe(true);
    for (const event of [
      "request.started",
      "images.collected",
      "image.downloaded",
      "opencode.completed",
      "request.completed",
    ])
      expect(test.logger.info).toHaveBeenCalledWith(
        event,
        expect.objectContaining({ requestId: "telegram:111:album:album-log" }),
      );
    expect(test.logger.info).toHaveBeenCalledWith(
      "image.downloaded",
      expect.objectContaining({ imageIndex: 2, imageCount: 2 }),
    );
    expect(JSON.stringify(test.logger.info.mock.calls)).not.toMatch(
      /PRIVATE CAPTION|aW1hZ2U=|Record today's expenses/,
    );
  });

  it("logs the original image failure before a failed error reply and releases the request", async () => {
    const test = await setup();
    test.imageLoader.load.mockRejectedValueOnce(
      new DiagnosticError("Could not download the image from Telegram.", {
        httpStatus: 503,
        operation: "telegram.image.download",
        receivedBytes: 0,
      }),
    );
    test.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === "sendMessage") {
        expect(test.logger.error).toHaveBeenCalledWith(
          "request.failed",
          expect.objectContaining({
            requestId: "telegram:111:message:1",
            stage: "telegram.image.download",
            imageIndex: 1,
            httpStatus: 503,
            modelCompleted: false,
          }),
        );
        throw Object.assign(new Error("private-token"), { error_code: 429 });
      }
      return previous(method, payload, signal);
    });
    await test.photo();
    await expect
      .poll(() =>
        test.logger.error.mock.calls.some(([event]) => event === "request.delivery.failed"),
      )
      .toBe(true);
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
    expect(test.logger.error).toHaveBeenCalledWith(
      "telegram.error_reply.failed",
      expect.objectContaining({ httpStatus: 429 }),
    );
    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain("private-token");
    await test.photo();
    await test.finished();
    expect(test.opencode.runPrompt).toHaveBeenCalledTimes(1);
  });

  it("distinguishes failed response delivery from a successful model run", async () => {
    const test = await setup();
    test.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === "sendRichMessage" || method === "sendMessage")
        throw Object.assign(new Error("private response"), { error_code: 403 });
      return previous(method, payload, signal);
    });
    await test.photo();
    await expect
      .poll(() => test.logger.error.mock.calls.some(([event]) => event === "request.failed"))
      .toBe(true);
    expect(test.logger.error).toHaveBeenCalledWith(
      "request.failed",
      expect.objectContaining({
        stage: "telegram.response.send",
        modelCompleted: true,
        httpStatus: 403,
      }),
    );
    expect(test.logger.info.mock.calls.some(([event]) => event === "request.completed")).toBe(
      false,
    );
    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain("private response");
  });

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

function albumPhoto(id: number, group = "album", caption = "") {
  return {
    message_id: id,
    media_group_id: group,
    caption,
    photo: [
      {
        file_id: `photo-${id}`,
        file_unique_id: `unique-${id}`,
        width: 1000,
        height: 1000,
        file_size: 1000,
      },
    ],
  };
}

async function albumFinished(test: Awaited<ReturnType<typeof setup>>, count = 1) {
  await expect
    .poll(() => test.calls.filter((call) => call.method === "sendRichMessage").length, {
      timeout: 5000,
    })
    .toBe(count);
}

async function imageFailed(test: Awaited<ReturnType<typeof setup>>, message: string) {
  await expect
    .poll(() => test.calls.some((call) => String(call.payload.text).includes(message)), {
      timeout: 5000,
    })
    .toBe(true);
}

describe("image albums", () => {
  it("combines out-of-order photos and captions in one request with an album source ID", async () => {
    const test = await setup();
    await test.send(albumPhoto(30, "photos", "Third receipt"));
    await test.send(albumPhoto(10, "photos", "First receipt"));
    await test.send(albumPhoto(20, "photos"));
    await test.send(albumPhoto(40, "photos"));
    await albumFinished(test);
    expect(test.opencode.runPrompt).toHaveBeenCalledOnce();
    const prompt = test.opencode.runPrompt.mock.calls[0]![0];
    expect(prompt).toMatchObject({
      sessionId: "existing-session",
      directory: test.directory,
      sourceId: "telegram:111:album:photos",
      text: "Image 1: First receipt\n\nImage 3: Third receipt",
    });
    expect(prompt.images?.map((image) => image.filename)).toEqual([
      "image-1.png",
      "image-2.png",
      "image-3.png",
      "image-4.png",
    ]);
    expect(
      test.calls.filter((call) => call.method === "getFile").map((call) => call.payload.file_id),
    ).toEqual(["photo-10", "photo-20", "photo-30", "photo-40"]);
    expect(test.calls.some((call) => String(call.payload.text).includes("already running"))).toBe(
      false,
    );
  });

  it("collects document images and retains a caption on a later item", async () => {
    const test = await setup();
    await test.send({
      message_id: 10,
      media_group_id: "docs",
      document: { file_id: "one", file_unique_id: "one", mime_type: "image/png" },
    });
    await test.send({
      message_id: 20,
      media_group_id: "docs",
      document: { file_id: "two", file_unique_id: "two", mime_type: "image/jpeg" },
      caption: "Read both receipts.",
    });
    await albumFinished(test);
    expect(test.opencode.runPrompt.mock.calls[0]![0]).toMatchObject({
      text: "Read both receipts.",
      images: [expect.any(Object), expect.any(Object)],
    });
  });

  it("ignores duplicate deliveries and warns once for late items without starting another task", async () => {
    const test = await setup();
    await test.send(albumPhoto(10));
    await test.send(albumPhoto(10));
    await test.send(albumPhoto(20));
    await albumFinished(test);
    await test.send(albumPhoto(10));
    await test.send(albumPhoto(30));
    await test.send(albumPhoto(40));
    expect(test.opencode.runPrompt).toHaveBeenCalledOnce();
    expect(test.imageLoader.load).toHaveBeenCalledTimes(2);
    expect(
      test.calls.filter((call) =>
        String(call.payload.text).includes("late image was not included"),
      ),
    ).toHaveLength(1);
  });

  it("aborts a collecting album without downloading and does not restart it for remaining updates", async () => {
    const test = await setup();
    await test.send({ text: "/start" });
    await test.send(albumPhoto(10));
    await test.send(albumPhoto(20));
    await test.click("Abort");
    await imageFailed(test, "OpenCode was stopped.");
    await test.send(albumPhoto(30));
    expect(test.imageLoader.load).not.toHaveBeenCalled();
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
    await test.send({ text: "Next request" });
    await test.finished();
  });

  it("rejects the complete album when any download fails", async () => {
    const test = await setup();
    test.imageLoader.load
      .mockResolvedValueOnce(test.image)
      .mockRejectedValueOnce(new Error("Download failed"));
    await test.send(albumPhoto(10));
    await test.send(albumPhoto(20));
    await imageFailed(test, "Download failed");
    expect(test.imageLoader.load).toHaveBeenCalledTimes(2);
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
  });

  it("enforces the combined byte budget before downloading", async () => {
    const test = await setup();
    for (const id of [10, 20])
      await test.send({
        ...albumPhoto(id),
        document: undefined,
        photo: [
          {
            file_id: String(id),
            file_unique_id: String(id),
            width: 1000,
            height: 1000,
            file_size: 11_000_000,
          },
        ],
      });
    await imageFailed(test, "total at most 20 MB");
    expect(test.imageLoader.load).not.toHaveBeenCalled();
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
  });

  it("refuses a mixed photo/video album instead of submitting only its photos", async () => {
    const test = await setup();
    await test.send(albumPhoto(10));
    await test.send({
      message_id: 20,
      media_group_id: "album",
      video: { file_id: "video", file_unique_id: "video", duration: 1, width: 100, height: 100 },
    });
    await imageFailed(test, "not a supported image");
    expect(test.imageLoader.load).not.toHaveBeenCalled();
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
  });

  it("keeps different albums and users isolated without busy-message spam", async () => {
    const test = await setup();
    test.store.authorize(222, undefined, 111);
    await test.send(albumPhoto(10, "shared"));
    await test.send(albumPhoto(20, "shared"));
    await test.send(albumPhoto(30, "other"));
    await test.send(albumPhoto(40, "other"));
    await test.send(albumPhoto(50, "shared"), 222);
    await test.send(albumPhoto(60, "shared"), 222);
    await albumFinished(test, 2);
    const prompts = test.opencode.runPrompt.mock.calls.map(([prompt]) => prompt);
    expect(prompts.map((prompt) => prompt.sourceId).sort()).toEqual([
      "telegram:111:album:shared",
      "telegram:222:album:shared",
    ]);
    expect(prompts.every((prompt) => prompt.images?.length === 2)).toBe(true);
    expect(
      test.calls.filter((call) => String(call.payload.text).includes("already running")),
    ).toHaveLength(1);
  });

  it("rechecks access after collection and before any download", async () => {
    const test = await setup();
    test.store.authorize(222, undefined, 111);
    await test.send(albumPhoto(10), 222);
    await test.send(albumPhoto(20), 222);
    test.store.revoke(222);
    await imageFailed(test, "Access was revoked");
    expect(test.imageLoader.load).not.toHaveBeenCalled();
    expect(test.opencode.runPrompt).not.toHaveBeenCalled();
  });
});
