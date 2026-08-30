import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export type AccessRequestStatus = "pending" | "approved" | "denied" | "expired";

export interface AccessRequest {
  id: string;
  userId: number;
  username?: string;
  createdAt: number;
  expiresAt: number;
  status: AccessRequestStatus;
}

export interface CreatedAccessRequest {
  request: AccessRequest;
  created: boolean;
}

export interface AuthorizedUser {
  userId: number;
  username?: string;
}

export interface ChatState {
  userId: number;
  directory: string;
  sessionId?: string;
  providerId?: string;
  modelId?: string;
  agent?: string;
  awaiting: "workspace" | null;
}

export interface ChatStateChanges {
  directory?: string;
  sessionId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  agent?: string | null;
  awaiting?: "workspace" | null;
}

export interface CallbackAction<T = unknown> {
  id: string;
  kind: string;
  payload: T;
  targetUserId: number;
  expiresAt: number;
}

interface AccessRequestRow {
  id: string;
  user_id: number;
  username: string | null;
  created_at: number;
  expires_at: number;
  status: AccessRequestStatus;
}

interface ActionRow {
  id: string;
  kind: string;
  payload: string;
  target_user_id: number;
  expires_at: number;
  used_at: number | null;
}

interface ChatStateRow {
  user_id: number;
  directory: string;
  session_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  agent: string | null;
  awaiting: "workspace" | null;
}

export class Store {
  private readonly database: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      const parent = dirname(path);
      const existed = existsSync(parent);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (!existed) chmodSync(parent, 0o700);
      if ((statSync(parent).mode & 0o077) !== 0) {
        throw new Error(
          `Database directory must not be accessible by group or other users: ${parent}`,
        );
      }
    }
    this.database = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  isAuthorized(userId: number): boolean {
    const row = this.database
      .prepare("SELECT 1 FROM authorized_users WHERE user_id = ? AND revoked_at IS NULL")
      .get(userId);
    return row !== undefined;
  }

  authorize(
    userId: number,
    username: string | undefined,
    approvedBy: number,
    now = Date.now(),
  ): void {
    this.database
      .prepare(
        `INSERT INTO authorized_users (user_id, username, approved_at, approved_by, revoked_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET
           username = excluded.username,
           approved_at = excluded.approved_at,
           approved_by = excluded.approved_by,
           revoked_at = NULL`,
      )
      .run(userId, username ?? null, now, approvedBy);
  }

  revoke(userId: number, now = Date.now()): void {
    this.database
      .prepare("UPDATE authorized_users SET revoked_at = ? WHERE user_id = ?")
      .run(now, userId);
  }

  listAuthorizedUsers(): AuthorizedUser[] {
    const rows = this.database
      .prepare(
        "SELECT user_id, username FROM authorized_users WHERE revoked_at IS NULL ORDER BY approved_at DESC",
      )
      .all() as Array<{ user_id: number; username: string | null }>;
    return rows.map((row) => ({
      userId: row.user_id,
      ...(row.username ? { username: row.username } : {}),
    }));
  }

  createAccessRequest(
    userId: number,
    username: string | undefined,
    ttlMs: number,
    now = Date.now(),
  ): CreatedAccessRequest {
    this.expireRequests(now);
    this.database
      .prepare("DELETE FROM access_requests WHERE status != 'pending' AND expires_at < ?")
      .run(now - 7 * 24 * 60 * 60 * 1000);
    const current = this.database
      .prepare(
        "SELECT * FROM access_requests WHERE user_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(userId, now) as AccessRequestRow | undefined;
    if (current) return { request: mapAccessRequest(current), created: false };

    const request: AccessRequest = {
      id: randomBytes(16).toString("hex"),
      userId,
      ...(username ? { username } : {}),
      createdAt: now,
      expiresAt: now + ttlMs,
      status: "pending",
    };
    this.database
      .prepare(
        "INSERT INTO access_requests (id, user_id, username, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      )
      .run(request.id, userId, username ?? null, request.createdAt, request.expiresAt);
    return { request, created: true };
  }

  resolveAccessRequest(
    id: string,
    status: "approved" | "denied",
    handledBy: number,
    now = Date.now(),
  ): AccessRequest | undefined {
    const transaction = this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM access_requests WHERE id = ?").get(id) as
        AccessRequestRow | undefined;
      if (!row || row.status !== "pending" || row.expires_at <= now) return undefined;
      this.database
        .prepare(
          "UPDATE access_requests SET status = ?, handled_at = ?, handled_by = ? WHERE id = ?",
        )
        .run(status, now, handledBy, id);
      return { ...row, status };
    });
    const result = transaction();
    return result ? mapAccessRequest(result) : undefined;
  }

  issueAction<T>(
    kind: string,
    payload: T,
    targetUserId: number,
    ttlMs: number,
    now = Date.now(),
  ): CallbackAction<T> {
    this.database
      .prepare("DELETE FROM callback_actions WHERE expires_at <= ? OR used_at IS NOT NULL")
      .run(now);
    const action: CallbackAction<T> = {
      id: randomBytes(16).toString("base64url"),
      kind,
      payload,
      targetUserId,
      expiresAt: now + ttlMs,
    };
    this.database
      .prepare(
        "INSERT INTO callback_actions (id, kind, payload, target_user_id, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(action.id, kind, JSON.stringify(payload), targetUserId, action.expiresAt);
    return action;
  }

  consumeAction<T>(
    id: string,
    actorUserId: number,
    now = Date.now(),
  ): CallbackAction<T> | undefined {
    const transaction = this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM callback_actions WHERE id = ?").get(id) as
        ActionRow | undefined;
      if (
        !row ||
        row.used_at !== null ||
        row.expires_at <= now ||
        row.target_user_id !== actorUserId
      ) {
        return undefined;
      }
      this.database.prepare("UPDATE callback_actions SET used_at = ? WHERE id = ?").run(now, id);
      return row;
    });
    const row = transaction();
    if (!row) return undefined;
    return {
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload) as T,
      targetUserId: row.target_user_id,
      expiresAt: row.expires_at,
    };
  }

  getChatState(userId: number, defaultDirectory: string): ChatState {
    const row = this.database.prepare("SELECT * FROM chat_state WHERE user_id = ?").get(userId) as
      ChatStateRow | undefined;
    if (row) return mapChatState(row);
    this.database
      .prepare("INSERT INTO chat_state (user_id, directory) VALUES (?, ?)")
      .run(userId, defaultDirectory);
    return { userId, directory: defaultDirectory, awaiting: null };
  }

  updateChatState(userId: number, defaultDirectory: string, changes: ChatStateChanges): ChatState {
    const current = this.getChatState(userId, defaultDirectory);
    const next: ChatState = {
      userId,
      directory: changes.directory ?? current.directory,
      ...(changes.sessionId === null ? {} : { sessionId: changes.sessionId ?? current.sessionId }),
      ...(changes.providerId === null
        ? {}
        : { providerId: changes.providerId ?? current.providerId }),
      ...(changes.modelId === null ? {} : { modelId: changes.modelId ?? current.modelId }),
      ...(changes.agent === null ? {} : { agent: changes.agent ?? current.agent }),
      awaiting: changes.awaiting === undefined ? current.awaiting : changes.awaiting,
    };
    this.database
      .prepare(
        `UPDATE chat_state SET directory = ?, session_id = ?, provider_id = ?, model_id = ?, agent = ?, awaiting = ?
         WHERE user_id = ?`,
      )
      .run(
        next.directory,
        next.sessionId ?? null,
        next.providerId ?? null,
        next.modelId ?? null,
        next.agent ?? null,
        next.awaiting,
        userId,
      );
    return next;
  }

  private expireRequests(now: number): void {
    this.database
      .prepare(
        "UPDATE access_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
      )
      .run(now);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS authorized_users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        approved_at INTEGER NOT NULL,
        approved_by INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS access_requests (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        username TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'expired')),
        handled_at INTEGER,
        handled_by INTEGER
      );
      CREATE INDEX IF NOT EXISTS access_requests_user_status ON access_requests(user_id, status);
      CREATE TABLE IF NOT EXISTS callback_actions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        target_user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS chat_state (
        user_id INTEGER PRIMARY KEY,
        directory TEXT NOT NULL,
        session_id TEXT,
        provider_id TEXT,
        model_id TEXT,
        agent TEXT,
        awaiting TEXT CHECK(awaiting IS NULL OR awaiting IN ('workspace'))
      );
    `);
  }
}

function mapAccessRequest(row: AccessRequestRow): AccessRequest {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.username ? { username: row.username } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

function mapChatState(row: ChatStateRow): ChatState {
  return {
    userId: row.user_id,
    directory: row.directory,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    awaiting: row.awaiting,
  };
}
