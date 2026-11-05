import { randomUUID } from "node:crypto";

import { createOpencodeClient } from "@opencode-ai/sdk/client";
import type { Agent, Event, Part, Session } from "@opencode-ai/sdk/client";
import type { EventMessagePartDelta, EventPermissionAsked } from "@opencode-ai/sdk/v2/client";

export interface ModelOption {
  providerId: string;
  modelId: string;
  label: string;
  reasoning: boolean;
}

export interface PromptSelection {
  providerId?: string;
  modelId?: string;
  agent?: string;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  title: string;
  type: string;
  pattern?: string | string[];
  always?: string[];
  metadata: Record<string, unknown>;
}

export type PromptActivity =
  | { type: "reasoning"; text: string }
  | { type: "tool"; text: string }
  | { type: "retry"; text: string }
  | { type: "permission"; request: PermissionRequest };

export interface RunPromptOptions {
  sessionId: string;
  directory: string;
  text: string;
  selection: PromptSelection;
  signal: AbortSignal;
  onActivity(activity: PromptActivity): Promise<void> | void;
}

export interface OpenCodeGateway {
  health(): Promise<string>;
  createSession(directory: string): Promise<Session>;
  listSessions(directory: string): Promise<Session[]>;
  listModels(directory: string): Promise<ModelOption[]>;
  listAgents(directory: string): Promise<Agent[]>;
  runPrompt(options: RunPromptOptions): Promise<string>;
  abort(sessionId: string, directory: string): Promise<void>;
  answerPermission(
    sessionId: string,
    permissionId: string,
    directory: string,
    response: "once" | "always" | "reject",
  ): Promise<void>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "OpenCode request failed";
}

function sessionIdForPart(part: Part): string {
  return part.sessionID;
}

export class SdkOpenCodeGateway implements OpenCodeGateway {
  private readonly client;
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(baseUrl: string, username: string, password: string) {
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    this.baseUrl = baseUrl;
    this.authorization = authorization;
    this.client = createOpencodeClient({
      baseUrl,
      throwOnError: true,
      headers: { authorization },
      fetch: (request) => {
        const headers = new Headers(request.headers);
        headers.set("authorization", authorization);
        return fetch(new Request(request, { headers }));
      },
    });
  }

  async health(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/global/health`, {
      headers: { authorization: this.authorization },
    });
    if (!response.ok) throw new Error(`OpenCode health check failed with HTTP ${response.status}`);
    const result = (await response.json()) as { healthy?: boolean; version?: string };
    if (!result.healthy || !result.version)
      throw new Error("OpenCode returned an invalid health response");
    return result.version;
  }

  async createSession(directory: string): Promise<Session> {
    const result = await this.client.session.create({ query: { directory }, throwOnError: true });
    return result.data;
  }

  async listSessions(directory: string): Promise<Session[]> {
    const result = await this.client.session.list({ query: { directory }, throwOnError: true });
    return result.data;
  }

  async listModels(directory: string): Promise<ModelOption[]> {
    const result = await this.client.provider.list({ query: { directory }, throwOnError: true });
    return result.data.all
      .filter((provider) => result.data.connected.includes(provider.id))
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          providerId: provider.id,
          modelId: model.id,
          label: `${provider.name}: ${model.name}`,
          reasoning: model.reasoning,
        })),
      )
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  async listAgents(directory: string): Promise<Agent[]> {
    const result = await this.client.app.agents({ query: { directory }, throwOnError: true });
    return result.data.filter((agent) => agent.mode !== "subagent");
  }

  async runPrompt(options: RunPromptOptions): Promise<string> {
    const eventController = new AbortController();
    const subscription = await this.client.event.subscribe({
      query: { directory: options.directory },
      signal: AbortSignal.any([options.signal, eventController.signal]),
      sseMaxRetryAttempts: 1,
    });
    const iterator = subscription.stream[Symbol.asyncIterator]();
    const textParts = new Map<string, string>();
    const reasoningParts = new Map<string, string>();
    const assistantMessageIds = new Set<string>();
    const messageId = `msg_${randomUUID()}`;

    const body: {
      parts: [{ type: "text"; text: string }];
      messageID: string;
      model?: { providerID: string; modelID: string };
      agent?: string;
    } = { messageID: messageId, parts: [{ type: "text", text: options.text }] };
    if (options.selection.providerId && options.selection.modelId) {
      body.model = {
        providerID: options.selection.providerId,
        modelID: options.selection.modelId,
      };
    }
    if (options.selection.agent) body.agent = options.selection.agent;

    try {
      const connected = await iterator.next();
      if (connected.done) throw new Error("OpenCode event stream closed before connecting");
      await this.client.session.promptAsync({
        path: { id: options.sessionId },
        query: { directory: options.directory },
        body,
        throwOnError: true,
        signal: options.signal,
      });

      while (true) {
        const result = await iterator.next();
        if (result.done) {
          if (options.signal.aborted)
            throw new DOMException("The operation was aborted", "AbortError");
          throw new Error("OpenCode event stream closed before the response completed");
        }
        const event = result.value as Event | EventMessagePartDelta | EventPermissionAsked;
        if (event.type === "message.updated") {
          const message = event.properties.info;
          if (
            message.role === "assistant" &&
            message.sessionID === options.sessionId &&
            message.parentID === messageId
          ) {
            assistantMessageIds.add(message.id);
            if (message.time.completed && message.finish !== "tool-calls") {
              return (
                [...textParts.values()].join("\n\n").trim() ||
                "OpenCode completed without a text response."
              );
            }
          }
        } else if (event.type === "message.part.updated") {
          const { part } = event.properties;
          if (
            sessionIdForPart(part) !== options.sessionId ||
            !assistantMessageIds.has(part.messageID)
          )
            continue;
          if (part.type === "reasoning") {
            reasoningParts.set(part.id, part.text);
            await options.onActivity({
              type: "reasoning",
              text: [...reasoningParts.values()].join("\n\n"),
            });
          } else if (part.type === "text") {
            textParts.set(part.id, part.text);
          } else if (
            part.type === "tool" &&
            (part.state.status === "running" || part.state.status === "completed")
          ) {
            const title = part.state.title ?? part.tool;
            await options.onActivity({ type: "tool", text: title });
          } else if (part.type === "retry") {
            await options.onActivity({
              type: "retry",
              text: `Retry ${part.attempt}: ${part.error.data.message}`,
            });
          }
        } else if (event.type === "message.part.delta") {
          const delta = event.properties;
          if (
            delta.sessionID !== options.sessionId ||
            !assistantMessageIds.has(delta.messageID) ||
            delta.field !== "text"
          )
            continue;
          if (textParts.has(delta.partID)) {
            textParts.set(delta.partID, textParts.get(delta.partID)! + delta.delta);
          } else if (reasoningParts.has(delta.partID)) {
            reasoningParts.set(delta.partID, reasoningParts.get(delta.partID)! + delta.delta);
            await options.onActivity({
              type: "reasoning",
              text: [...reasoningParts.values()].join("\n\n"),
            });
          }
        } else if (
          event.type === "permission.asked" &&
          event.properties.sessionID === options.sessionId &&
          (!event.properties.tool || assistantMessageIds.has(event.properties.tool.messageID))
        ) {
          await options.onActivity({
            type: "permission",
            request: {
              id: event.properties.id,
              sessionId: event.properties.sessionID,
              title: event.properties.permission,
              type: event.properties.permission,
              pattern: event.properties.patterns,
              always: event.properties.always,
              metadata: event.properties.metadata,
            },
          });
        } else if (
          event.type === "permission.updated" &&
          event.properties.sessionID === options.sessionId &&
          assistantMessageIds.has(event.properties.messageID)
        ) {
          await options.onActivity({
            type: "permission",
            request: {
              id: event.properties.id,
              sessionId: event.properties.sessionID,
              title: event.properties.title,
              type: event.properties.type,
              ...(event.properties.pattern ? { pattern: event.properties.pattern } : {}),
              metadata: event.properties.metadata,
            },
          });
        } else if (
          event.type === "session.error" &&
          event.properties.sessionID === options.sessionId
        ) {
          throw new Error(getErrorMessage(event.properties.error));
        }
      }
    } finally {
      eventController.abort();
      await iterator.return?.(undefined);
    }
  }

  async abort(sessionId: string, directory: string): Promise<void> {
    await this.client.session.abort({
      path: { id: sessionId },
      query: { directory },
      throwOnError: true,
    });
  }

  async answerPermission(
    sessionId: string,
    permissionId: string,
    directory: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    await this.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      query: { directory },
      body: { response },
      throwOnError: true,
    });
  }
}
