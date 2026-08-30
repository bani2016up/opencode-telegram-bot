import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

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
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.headers.authorization !== expectedAuthorization) {
        response.writeHead(401).end();
        return;
      }
      if (url.pathname === "/event") {
        streamAuthenticated = true;
        stream = response;
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
  }, 10_000);
});
