import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";

import type { AppConfig } from "./config.js";
import { ThinkingDraft } from "./draft.js";
import type { Logger } from "./logger.js";
import { sanitizeRichMarkdown, splitRichMarkdown } from "./markdown.js";
import type {
  ModelOption,
  OpenCodeGateway,
  PermissionRequest,
  PromptActivity,
} from "./opencode.js";
import { discoverSkills, parseSkillInvocation, skillPrompt } from "./skills.js";
import type { CallbackAction, ChatState } from "./store.js";
import { Store } from "./store.js";
import { resolveWorkspace } from "./workspaces.js";

interface Dependencies {
  store: Store;
  opencode: OpenCodeGateway;
  logger: Logger;
}

interface ActiveRun {
  controller: AbortController;
  directory: string;
  sessionId: string | undefined;
  draftId: number;
}

interface AccessPayload {
  requestId: string;
}

interface PagePayload {
  page: number;
}

interface ModelPayload {
  providerId: string;
  modelId: string;
}

interface SessionPayload {
  sessionId: string;
}

interface AgentPayload {
  agent: string;
}

interface PermissionPayload {
  sessionId: string;
  permissionId: string;
  directory: string;
  response: "once" | "always" | "reject";
}

interface UserPayload {
  userId: number;
}

const PAGE_SIZE = 8;

export function createTelegramBot(config: AppConfig, dependencies: Dependencies): Bot {
  const bot = new Bot(config.telegramToken);
  const activeRuns = new Map<number, ActiveRun>();
  const busyUsers = new Set<number>();
  const activeSessionIds = new Set<string>();

  const authorized = (userId: number) =>
    config.adminUserIds.has(userId) || dependencies.store.isAuthorized(userId);

  const action = <T>(kind: string, payload: T, targetUserId: number) =>
    `a:${dependencies.store.issueAction(kind, payload, targetUserId, config.callbackTtlMs).id}`;

  const privateUser = (ctx: Context): number | undefined => {
    if (ctx.chat?.type !== "private" || !ctx.from || ctx.from.is_bot) return undefined;
    return ctx.from.id;
  };

  async function sendMenu(ctx: Context, userId: number): Promise<void> {
    const state = await getValidatedState(userId);
    const keyboard = new InlineKeyboard()
      .text("Status", action("menu.status", {}, userId))
      .text("Abort", action("run.abort", {}, userId))
      .row()
      .text("New session", action("session.new", {}, userId))
      .text("Sessions", action("session.list", { page: 0 }, userId))
      .row()
      .text("Models", action("model.list", { page: 0 }, userId))
      .text("Agents", action("agent.list", { page: 0 }, userId))
      .row()
      .text("Workspace", action("workspace.prompt", {}, userId))
      .text("Skills", action("skill.list", { page: 0 }, userId));
    if (config.adminUserIds.has(userId)) {
      keyboard.row().text("Authorized users", action("admin.users", {}, userId));
    }
    await ctx.reply(
      `OpenCode control\n\nWorkspace: ${state.directory}\nSession: ${state.sessionId ?? "new on next prompt"}\nModel: ${state.providerId && state.modelId ? `${state.providerId}/${state.modelId}` : "OpenCode default"}\nAgent: ${state.agent ?? "OpenCode default"}`,
      { reply_markup: keyboard },
    );
  }

  async function syncSkillCommands(userId: number, directory: string): Promise<void> {
    const skills = await discoverSkills(directory, config.agentHome);
    await bot.api.setMyCommands(
      [
        { command: "start", description: "Open the control menu" },
        ...skills.slice(0, 99).map((skill) => ({
          command: skill.alias,
          description: skill.description.slice(0, 256),
        })),
      ],
      { scope: { type: "chat", chat_id: userId } },
    );
  }

  bot.command("start", async (ctx) => {
    const userId = privateUser(ctx);
    if (!userId) {
      await ctx.reply("This bot accepts commands only in private chats.");
      return;
    }
    if (authorized(userId)) {
      await syncSkillCommands(userId, (await getValidatedState(userId)).directory);
      await sendMenu(ctx, userId);
      return;
    }

    const { request, created } = dependencies.store.createAccessRequest(
      userId,
      ctx.from?.username,
      config.accessRequestTtlMs,
    );
    if (!created) {
      await ctx.reply("An access request is already pending.");
      return;
    }
    let delivered = 0;
    for (const adminId of config.adminUserIds) {
      const keyboard = new InlineKeyboard()
        .text("Approve", action("access.approve", { requestId: request.id }, adminId))
        .text("Deny", action("access.deny", { requestId: request.id }, adminId));
      try {
        await bot.api.sendMessage(
          adminId,
          `Access request\n\nUser ID: ${userId}\nUsername: ${ctx.from?.username ? `@${ctx.from.username}` : "not set"}\nExpires: ${new Date(request.expiresAt).toISOString()}`,
          { reply_markup: keyboard },
        );
        delivered += 1;
      } catch (error) {
        dependencies.logger.warn("Could not deliver an access request to an administrator", {
          adminId,
          error: String(error),
        });
      }
    }
    await ctx.reply(
      delivered > 0
        ? "Access requested. An administrator must approve it before this bot can run OpenCode."
        : "Access could not be requested because no configured administrator is reachable.",
    );
  });

  bot.on("stopped_message_generation", async (ctx) => {
    const userId = ctx.update.stopped_message_generation.chat.id;
    const running = activeRuns.get(userId);
    if (
      !running ||
      !authorized(userId) ||
      running.draftId !== ctx.update.stopped_message_generation.draft_id
    )
      return;
    running.controller.abort();
    if (running.sessionId) {
      await dependencies.opencode
        .abort(running.sessionId, running.directory)
        .catch(() => undefined);
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const userId = privateUser(ctx);
    if (!userId || !ctx.callbackQuery.data.startsWith("a:")) return;
    const selected = dependencies.store.consumeAction(ctx.callbackQuery.data.slice(2), userId);
    if (!selected) {
      await ctx.answerCallbackQuery({
        text: "This action expired or was already used.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();

    if (selected.kind === "access.approve" || selected.kind === "access.deny") {
      if (!config.adminUserIds.has(userId)) return;
      const payload = selected.payload as AccessPayload;
      const status = selected.kind === "access.approve" ? "approved" : "denied";
      const request = dependencies.store.resolveAccessRequest(payload.requestId, status, userId);
      if (!request) {
        await ctx.editMessageText("This access request is no longer pending.");
        return;
      }
      if (status === "approved") {
        dependencies.store.authorize(request.userId, request.username, userId);
        await bot.api.sendMessage(request.userId, "Access approved. Send /start to open OpenCode.");
      }
      await ctx.editMessageText(`Access ${status} for Telegram user ${request.userId}.`);
      return;
    }

    if (!authorized(userId)) return;
    const state = await getValidatedState(userId);
    await handleAuthorizedAction(ctx, userId, state, selected);
  });

  async function getValidatedState(userId: number): Promise<ChatState> {
    const state = dependencies.store.getChatState(userId, config.defaultWorkdir);
    const resolution = await resolveWorkspace(
      state.directory,
      config.agentHome,
      config.allowedRoots,
    );
    if (resolution.directory) {
      return resolution.directory === state.directory
        ? state
        : dependencies.store.updateChatState(userId, config.defaultWorkdir, {
            directory: resolution.directory,
          });
    }
    dependencies.logger.warn("Resetting invalid persisted workspace", {
      userId,
      directory: state.directory,
    });
    return dependencies.store.updateChatState(userId, config.defaultWorkdir, {
      directory: config.defaultWorkdir,
      sessionId: null,
      awaiting: null,
    });
  }

  async function handleAuthorizedAction(
    ctx: Context,
    userId: number,
    state: ChatState,
    selected: CallbackAction,
  ): Promise<void> {
    const mutationActions = new Set([
      "workspace.prompt",
      "session.new",
      "session.select",
      "model.select",
      "agent.select",
    ]);
    if (busyUsers.has(userId) && mutationActions.has(selected.kind)) {
      await ctx.reply("This setting cannot change while OpenCode is processing a request.");
      return;
    }
    switch (selected.kind) {
      case "menu.status": {
        const version = await dependencies.opencode.health();
        await ctx.reply(
          `OpenCode ${version}\nWorkspace: ${state.directory}\nSession: ${state.sessionId ?? "none"}\nRunning: ${activeRuns.has(userId) ? "yes" : "no"}`,
        );
        return;
      }
      case "run.abort": {
        const running = activeRuns.get(userId);
        if (!running) {
          await ctx.reply("No OpenCode operation is running.");
          return;
        }
        running.controller.abort();
        if (running.sessionId) {
          await dependencies.opencode.abort(running.sessionId, running.directory);
        }
        await ctx.reply("Abort requested.");
        return;
      }
      case "workspace.prompt":
        dependencies.store.updateChatState(userId, config.defaultWorkdir, {
          awaiting: "workspace",
        });
        await ctx.reply("Send an absolute workspace path or a path beginning with ~/.");
        return;
      case "session.new":
        dependencies.store.updateChatState(userId, config.defaultWorkdir, { sessionId: null });
        await ctx.reply("A new session will be created for the next prompt.");
        return;
      case "session.list":
        await showSessions(ctx, userId, state, (selected.payload as PagePayload).page);
        return;
      case "session.select": {
        const payload = selected.payload as SessionPayload;
        dependencies.store.updateChatState(userId, config.defaultWorkdir, {
          sessionId: payload.sessionId,
        });
        await ctx.reply(`Session selected: ${payload.sessionId}`);
        return;
      }
      case "model.list":
        await showModels(ctx, userId, state, (selected.payload as PagePayload).page);
        return;
      case "model.select": {
        const payload = selected.payload as ModelPayload;
        dependencies.store.updateChatState(userId, config.defaultWorkdir, payload);
        await ctx.reply(`Model selected: ${payload.providerId}/${payload.modelId}`);
        return;
      }
      case "agent.list":
        await showAgents(ctx, userId, state, (selected.payload as PagePayload).page);
        return;
      case "agent.select": {
        const payload = selected.payload as AgentPayload;
        dependencies.store.updateChatState(userId, config.defaultWorkdir, payload);
        await ctx.reply(`Agent selected: ${payload.agent}`);
        return;
      }
      case "skill.list":
        await showSkills(ctx, userId, state, (selected.payload as PagePayload).page);
        return;
      case "permission.answer": {
        const payload = selected.payload as PermissionPayload;
        await dependencies.opencode.answerPermission(
          payload.sessionId,
          payload.permissionId,
          payload.directory,
          payload.response,
        );
        if (payload.response === "reject") {
          await ctx.editMessageText("Permission denied.");
        } else {
          try {
            await ctx.deleteMessage();
          } catch (error) {
            dependencies.logger.warn("Could not remove an approved permission message", {
              error: safeError(error),
            });
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
          }
        }
        return;
      }
      case "admin.users": {
        if (!config.adminUserIds.has(userId)) return;
        const users = dependencies.store.listAuthorizedUsers();
        const keyboard = new InlineKeyboard();
        for (const user of users) {
          keyboard
            .text(
              `Revoke ${user.username ? `@${user.username}` : user.userId}`.slice(0, 50),
              action("admin.revoke", { userId: user.userId }, userId),
            )
            .row();
        }
        await ctx.reply(users.length ? "Select a user to revoke:" : "No approved users.", {
          reply_markup: keyboard,
        });
        return;
      }
      case "admin.revoke": {
        if (!config.adminUserIds.has(userId)) return;
        const payload = selected.payload as UserPayload;
        dependencies.store.revoke(payload.userId);
        await ctx.reply(`Access revoked for Telegram user ${payload.userId}.`);
        return;
      }
      default:
        await ctx.reply("Unsupported action.");
    }
  }

  async function showSessions(
    ctx: Context,
    userId: number,
    state: ChatState,
    page: number,
  ): Promise<void> {
    const sessions = await dependencies.opencode.listSessions(state.directory);
    const keyboard = pagedKeyboard(
      sessions,
      page,
      (session) => session.title || session.id,
      (session) => action("session.select", { sessionId: session.id }, userId),
      (nextPage) => action("session.list", { page: nextPage }, userId),
    );
    await ctx.reply(
      sessions.length ? "Select a session:" : "No sessions exist in this workspace.",
      {
        reply_markup: keyboard,
      },
    );
  }

  async function showModels(
    ctx: Context,
    userId: number,
    state: ChatState,
    page: number,
  ): Promise<void> {
    const models = await dependencies.opencode.listModels(state.directory);
    const keyboard = pagedKeyboard(
      models,
      page,
      (model) => model.label,
      (model) =>
        action("model.select", { providerId: model.providerId, modelId: model.modelId }, userId),
      (nextPage) => action("model.list", { page: nextPage }, userId),
    );
    await ctx.reply(
      models.length ? "Select a model:" : "No connected models were reported by OpenCode.",
      {
        reply_markup: keyboard,
      },
    );
  }

  async function showAgents(
    ctx: Context,
    userId: number,
    state: ChatState,
    page: number,
  ): Promise<void> {
    const agents = await dependencies.opencode.listAgents(state.directory);
    const keyboard = pagedKeyboard(
      agents,
      page,
      (agent) => agent.name,
      (agent) => action("agent.select", { agent: agent.name }, userId),
      (nextPage) => action("agent.list", { page: nextPage }, userId),
    );
    await ctx.reply(
      agents.length ? "Select an agent:" : "No primary agents were reported by OpenCode.",
      {
        reply_markup: keyboard,
      },
    );
  }

  async function showSkills(
    ctx: Context,
    userId: number,
    state: ChatState,
    page: number,
  ): Promise<void> {
    const skills = await discoverSkills(state.directory, config.agentHome);
    const start = Math.max(0, page) * PAGE_SIZE;
    const body = skills
      .slice(start, start + PAGE_SIZE)
      .map((skill) => `/${skill.alias} — ${skill.description}`)
      .join("\n\n");
    const keyboard = paginationOnly(skills.length, page, (nextPage) =>
      action("skill.list", { page: nextPage }, userId),
    );
    await ctx.reply(body || "No OpenCode skills were discovered for this workspace.", {
      reply_markup: keyboard,
    });
  }

  bot.on("message:text", async (ctx) => {
    const userId = privateUser(ctx);
    if (!userId || /^\/start(?:@[a-zA-Z0-9_]+)?(?:\s|$)/u.test(ctx.message.text)) return;
    if (!authorized(userId)) {
      await ctx.reply("Access is not approved. Send /start to request access.");
      return;
    }
    if (busyUsers.has(userId)) {
      await ctx.reply(
        "OpenCode is already processing a request. Use Abort before sending another.",
      );
      return;
    }
    const state = await getValidatedState(userId);
    if (state.awaiting === "workspace") {
      await handleWorkspaceInput(ctx, userId, ctx.message.text);
      return;
    }
    if (ctx.message.text.length > config.maxPromptLength) {
      await ctx.reply(`Prompt too long. The limit is ${config.maxPromptLength} characters.`);
      return;
    }

    let prompt = ctx.message.text;
    if (prompt.startsWith("/")) {
      const skills = await discoverSkills(state.directory, config.agentHome);
      const invocation = parseSkillInvocation(prompt, skills);
      if (!invocation) {
        await ctx.reply("Unknown skill command. Use the Skills button to list commands.");
        return;
      }
      prompt = skillPrompt(invocation.skill, invocation.arguments);
    }
    busyUsers.add(userId);
    void processPrompt(ctx, userId, state, prompt);
  });

  async function handleWorkspaceInput(ctx: Context, userId: number, input: string): Promise<void> {
    const result = await resolveWorkspace(input, config.agentHome, config.allowedRoots);
    if (result.directory) {
      dependencies.store.updateChatState(userId, config.defaultWorkdir, {
        directory: result.directory,
        sessionId: null,
        awaiting: null,
      });
      await syncSkillCommands(userId, result.directory);
      await ctx.reply(
        `Workspace changed to ${result.directory}. A new session will start with the next prompt.`,
      );
      return;
    }
    if (result.nearestDirectory) {
      const listing = result.entries?.join("\n") || "(empty)";
      await ctx.reply(
        `Directory not found.\n\nDeepest existing directory: ${result.nearestDirectory}\nMissing segment: ${result.missingSegment}\n\nContents:\n${listing}`,
      );
      return;
    }
    await ctx.reply(result.error ?? "The workspace could not be selected.");
  }

  async function processPrompt(
    ctx: Context,
    userId: number,
    initialState: ChatState,
    prompt: string,
  ): Promise<void> {
    const draft = new ThinkingDraft(bot.api, userId, config.streamIntervalMs);
    const controller = new AbortController();
    activeRuns.set(userId, {
      controller,
      directory: initialState.directory,
      sessionId: initialState.sessionId,
      draftId: draft.draftId,
    });
    let state = initialState;
    let lockedSessionId: string | undefined;
    try {
      await draft.start();
      if (!state.sessionId) {
        const session = await dependencies.opencode.createSession(state.directory);
        if (controller.signal.aborted)
          throw new DOMException("The operation was aborted", "AbortError");
        state = dependencies.store.updateChatState(userId, config.defaultWorkdir, {
          sessionId: session.id,
        });
      }
      const sessionId = state.sessionId;
      if (!sessionId) throw new Error("OpenCode session creation did not return a session ID");
      if (activeSessionIds.has(sessionId)) {
        throw new Error("This OpenCode session is already processing another request");
      }
      activeSessionIds.add(sessionId);
      lockedSessionId = sessionId;
      activeRuns.set(userId, {
        controller,
        directory: state.directory,
        sessionId,
        draftId: draft.draftId,
      });
      const final = await dependencies.opencode.runPrompt({
        sessionId,
        directory: state.directory,
        text: prompt,
        selection: {
          ...(state.providerId ? { providerId: state.providerId } : {}),
          ...(state.modelId ? { modelId: state.modelId } : {}),
          ...(state.agent ? { agent: state.agent } : {}),
        },
        signal: controller.signal,
        onActivity: async (activity) =>
          handleActivity(ctx, userId, state.directory, activity, draft),
      });
      draft.finish();
      await sendFinal(ctx, final);
    } catch (error) {
      draft.finish();
      const aborted = error instanceof Error && error.name === "AbortError";
      await ctx.reply(aborted ? "OpenCode was stopped." : `OpenCode failed: ${safeError(error)}`);
      dependencies.logger.error("OpenCode prompt failed", { userId, error: safeError(error) });
    } finally {
      activeRuns.delete(userId);
      busyUsers.delete(userId);
      if (lockedSessionId) activeSessionIds.delete(lockedSessionId);
    }
  }

  async function handleActivity(
    ctx: Context,
    userId: number,
    directory: string,
    activity: PromptActivity,
    draft: ThinkingDraft,
  ): Promise<void> {
    if (activity.type === "reasoning") draft.update(activity.text);
    else if (activity.type === "tool") draft.update(`Working\n${activity.text}`);
    else if (activity.type === "retry") draft.update(activity.text);
    else await sendPermission(ctx, userId, directory, activity.request, draft);
  }

  async function sendPermission(
    ctx: Context,
    userId: number,
    directory: string,
    request: PermissionRequest,
    draft: ThinkingDraft,
  ): Promise<void> {
    draft.update(`Waiting for permission\n${request.title}`);
    const allow: PermissionPayload = {
      sessionId: request.sessionId,
      permissionId: request.id,
      directory,
      response: "once",
    };
    const always: PermissionPayload = { ...allow, response: "always" };
    const deny: PermissionPayload = { ...allow, response: "reject" };
    const keyboard = new InlineKeyboard()
      .text("Allow once", action("permission.answer", allow, userId))
      .text("Allow always", action("permission.answer", always, userId))
      .text("Deny", action("permission.answer", deny, userId));
    const pattern = request.pattern
      ? `\nPattern: ${Array.isArray(request.pattern) ? request.pattern.join(", ") : request.pattern}`
      : "";
    const alwaysScope = request.always?.length
      ? `\nAlways allows: ${request.always.join(", ")} (this session)`
      : "";
    await ctx.reply(
      `OpenCode requests permission\n\n${request.title}\nType: ${request.type}${pattern}${alwaysScope}`.slice(
        0,
        3500,
      ),
      {
        reply_markup: keyboard,
      },
    );
  }

  async function sendFinal(ctx: Context, markdown: string): Promise<void> {
    const safeMarkdown = sanitizeRichMarkdown(markdown);
    const chunks = splitRichMarkdown(safeMarkdown || "OpenCode completed without a text response.");
    try {
      for (const [index, chunk] of chunks.entries()) {
        await ctx.replyWithRichMessage(
          { markdown: chunk },
          {
            disable_notification: index > 0,
            ...(index === 0 && ctx.message
              ? { reply_parameters: { message_id: ctx.message.message_id } }
              : {}),
          },
        );
      }
    } catch {
      for (const [index, chunk] of plainChunks(safeMarkdown).entries()) {
        await ctx.reply(chunk, { disable_notification: index > 0 });
      }
    }
  }

  bot.catch((error) => {
    dependencies.logger.error("Telegram update failed", {
      updateId: error.ctx.update.update_id,
      error: safeError(error.error),
    });
  });

  return bot;
}

function pagedKeyboard<T>(
  values: readonly T[],
  page: number,
  label: (value: T) => string,
  data: (value: T) => string,
  pageData: (page: number) => string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const start = Math.max(0, page) * PAGE_SIZE;
  for (const value of values.slice(start, start + PAGE_SIZE))
    keyboard.text(label(value).slice(0, 50), data(value)).row();
  return addPagination(keyboard, values.length, page, pageData);
}

function paginationOnly(
  total: number,
  page: number,
  pageData: (page: number) => string,
): InlineKeyboard {
  return addPagination(new InlineKeyboard(), total, page, pageData);
}

function addPagination(
  keyboard: InlineKeyboard,
  total: number,
  page: number,
  pageData: (page: number) => string,
): InlineKeyboard {
  if (page > 0) keyboard.text("Previous", pageData(page - 1));
  if ((page + 1) * PAGE_SIZE < total) keyboard.text("Next", pageData(page + 1));
  return keyboard;
}

function plainChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += 4000)
    chunks.push(text.slice(offset, offset + 4000));
  return chunks.length ? chunks : ["OpenCode completed without a text response."];
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}
