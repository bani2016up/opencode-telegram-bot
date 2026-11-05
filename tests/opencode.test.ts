import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { PromptActivity } from "../src/opencode.js";
import { SdkOpenCodeGateway } from "../src/opencode.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function event(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

describe("SdkOpenCodeGateway", () => {
  it("authenticates SSE and correlates output to the submitted message", async () => {
    const expectedAuthorization = `Basic ${Buffer.from("opencode:secure-password-123").toString("base64")}`;
    let stream: ServerResponse | undefined;
    let streamAuthenticated = false;
    let streamClosed = false;
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.headers.authorization !== expectedAuthorization) {
        response.writeHead(401).end();
        return;
      }
      if (url.pathname === "/event") {
        streamAuthenticated = true;
        stream = response;
        response.on("close", () => {
          streamClosed = true;
        });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.flushHeaders();
        event(response, { type: "server.connected", properties: {} });
        return;
      }
      if (url.pathname === "/session/session-1/prompt_async") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messageID: string };
        if (!body.messageID.startsWith("msg")) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "Expected a message ID starting with msg" }));
          return;
        }
        response.writeHead(204).end();

        event(stream!, {
          type: "message.updated",
          properties: {
            info: {
              id: "unrelated-assistant",
              sessionID: "session-1",
              role: "assistant",
              time: { created: 1 },
              parentID: "some-other-message",
              modelID: "model",
              providerID: "provider",
              mode: "build",
              path: { cwd: "/workspace", root: "/workspace" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          },
        });
        event(stream!, {
          type: "message.part.updated",
          properties: {
            part: {
              id: "unrelated-part",
              sessionID: "session-1",
              messageID: "unrelated-assistant",
              type: "text",
              text: "must not leak",
            },
          },
        });
        const assistant = {
          id: "target-assistant",
          sessionID: "session-1",
          role: "assistant",
          time: { created: 1 },
          parentID: body.messageID,
          modelID: "model",
          providerID: "provider",
          mode: "build",
          path: { cwd: "/workspace", root: "/workspace" },
          cost: 0,
          tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        };
        event(stream!, { type: "message.updated", properties: { info: assistant } });
        event(stream!, {
          type: "message.part.updated",
          properties: {
            part: {
              id: "target-part",
              sessionID: "session-1",
              messageID: "target-assistant",
              type: "text",
              text: "expected answer",
            },
          },
        });
        event(stream!, {
          type: "message.updated",
          properties: { info: { ...assistant, time: { created: 1, completed: 2 } } },
        });
        return;
      }
      response.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP address");

    const gateway = new SdkOpenCodeGateway(
      `http://127.0.0.1:${address.port}`,
      "opencode",
      "secure-password-123",
    );
    const result = await gateway.runPrompt({
      sessionId: "session-1",
      directory: "/workspace",
      text: "test",
      selection: {},
      signal: new AbortController().signal,
      onActivity: () => undefined,
    });

    expect(streamAuthenticated).toBe(true);
    expect(result).toBe("expected answer");
    await expect.poll(() => streamClosed).toBe(true);
  }, 10_000);
});

interface Fixture {
  gateway: SdkOpenCodeGateway;
  send(value: unknown): void;
  closed(): boolean;
  promptReceived: Promise<void>;
  permissionReplies: unknown[];
}

async function fixture(
  onPrompt: (messageId: string, response: ServerResponse, send: Fixture["send"]) => void,
): Promise<Fixture> {
  let stream: ServerResponse | undefined;
  let closed = false;
  let received!: () => void;
  const promptReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const permissionReplies: unknown[] = [];
  const send = (value: unknown) => event(stream!, value);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/event") {
      stream = response;
      response.on("close", () => {
        closed = true;
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      send({ type: "server.connected", properties: {} });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (url.pathname === "/session/ses_test/prompt_async") {
      onPrompt(body.messageID, response, send);
      received();
      return;
    }
    if (url.pathname === "/session/ses_test/permissions/per_test") {
      permissionReplies.push(body);
      response.writeHead(200, { "content-type": "application/json" }).end("true");
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    gateway: new SdkOpenCodeGateway(
      `http://127.0.0.1:${address.port}`,
      "opencode",
      "test-password",
    ),
    send,
    closed: () => closed,
    promptReceived,
    permissionReplies,
  };
}

function assistant(parentID: string, id = "msg_assistant") {
  return { id, parentID, role: "assistant", sessionID: "ses_test", time: { created: 1 } };
}

function part(type: "text" | "reasoning", id: string, text: string) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id,
        sessionID: "ses_test",
        messageID: "msg_assistant",
        type,
        text,
      },
    },
  };
}

const prompt = {
  sessionId: "ses_test",
  directory: "/workspace",
  text: "test",
  selection: {},
  signal: new AbortController().signal,
  onActivity: () => undefined,
};

describe("current OpenCode events", () => {
  it("accumulates text and reasoning deltas only for the current reply", async () => {
    const activities: PromptActivity[] = [];
    const test = await fixture((messageId, response, send) => {
      response.writeHead(204).end();
      const message = assistant(messageId);
      send({ type: "message.updated", properties: { info: message } });
      send(part("text", "prt_text", ""));
      send(part("reasoning", "prt_reasoning", ""));
      const delta = {
        sessionID: "ses_test",
        messageID: "msg_assistant",
        partID: "prt_text",
        field: "text",
        delta: "hello",
      };
      send({
        type: "message.part.delta",
        properties: { ...delta, messageID: "msg_unrelated", delta: "must not leak" },
      });
      send({ type: "message.part.delta", properties: delta });
      send({ type: "message.part.delta", properties: { ...delta, delta: " world" } });
      send({
        type: "message.part.delta",
        properties: { ...delta, partID: "prt_reasoning", delta: "thinking" },
      });
      send({
        type: "message.updated",
        properties: { info: { ...message, time: { created: 1, completed: 2 }, finish: "stop" } },
      });
    });
    expect(
      await test.gateway.runPrompt({
        ...prompt,
        onActivity: (activity) => {
          activities.push(activity);
        },
      }),
    ).toBe("hello world");
    expect(activities).toContainEqual({ type: "reasoning", text: "thinking" });
    await expect.poll(test.closed).toBe(true);
  });

  it.each(["permission.asked", "permission.updated"])(
    "handles %s without ending at a tool call",
    async (kind) => {
      const activities: PromptActivity[] = [];
      let parentID = "";
      const test = await fixture((messageId, response, send) => {
        parentID = messageId;
        response.writeHead(204).end();
        const message = assistant(messageId);
        send({ type: "message.updated", properties: { info: message } });
        const properties =
          kind === "permission.asked"
            ? {
                id: "per_test",
                sessionID: "ses_test",
                permission: "bash",
                patterns: ["pwd"],
                metadata: {},
                always: [],
                tool: { messageID: message.id, callID: "call_test" },
              }
            : {
                id: "per_test",
                sessionID: "ses_test",
                messageID: message.id,
                title: "bash",
                type: "bash",
                pattern: ["pwd"],
                metadata: {},
              };
        send({ type: kind, properties: { ...properties, sessionID: "ses_other" } });
        send({ type: kind, properties });
        send({
          type: "message.updated",
          properties: {
            info: { ...message, time: { created: 1, completed: 2 }, finish: "tool-calls" },
          },
        });
      });
      const result = await test.gateway.runPrompt({
        ...prompt,
        onActivity: async (activity) => {
          activities.push(activity);
          if (activity.type !== "permission") return;
          await test.gateway.answerPermission(
            "ses_test",
            activity.request.id,
            "/workspace",
            "once",
          );
          const message = assistant(parentID, "msg_final");
          test.send({ type: "message.updated", properties: { info: message } });
          test.send({
            type: "message.part.updated",
            properties: {
              part: {
                id: "prt_final",
                sessionID: "ses_test",
                messageID: message.id,
                type: "text",
                text: "tool finished",
              },
            },
          });
          test.send({
            type: "message.updated",
            properties: {
              info: { ...message, time: { created: 3, completed: 4 }, finish: "stop" },
            },
          });
        },
      });
      expect(result).toBe("tool finished");
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        type: "permission",
        request: { id: "per_test", type: "bash", pattern: ["pwd"] },
      });
      expect(test.permissionReplies).toEqual([{ response: "once" }]);
      await expect.poll(test.closed).toBe(true);
    },
  );

  it("closes the event stream when submitting a prompt fails", async () => {
    const test = await fixture((_messageId, response) => {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ message: "Rejected prompt" }));
    });
    await expect(test.gateway.runPrompt(prompt)).rejects.toBeDefined();
    await expect.poll(test.closed).toBe(true);
  });

  it("closes the event stream when the caller cancels", async () => {
    const controller = new AbortController();
    const test = await fixture((_messageId, response) => {
      response.writeHead(204).end();
    });
    const result = test.gateway.runPrompt({ ...prompt, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await test.promptReceived;
    controller.abort();
    await rejected;
    await expect.poll(test.closed).toBe(true);
  });
});
