import { describe, expect, it } from "vitest";

import { Store } from "../src/store.js";

describe("Store", () => {
  it("authorizes and revokes users", () => {
    const store = new Store(":memory:");
    expect(store.isAuthorized(100)).toBe(false);
    store.authorize(100, "owner", 200, 1_000);
    expect(store.isAuthorized(100)).toBe(true);
    expect(store.listAuthorizedUsers()).toEqual([{ userId: 100, username: "owner" }]);
    store.revoke(100, 2_000);
    expect(store.isAuthorized(100)).toBe(false);
    store.close();
  });

  it("reuses pending requests and resolves each request once", () => {
    const store = new Store(":memory:");
    const first = store.createAccessRequest(100, "owner", 10_000, 1_000);
    const duplicate = store.createAccessRequest(100, "owner", 10_000, 2_000);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.request.id).toBe(first.request.id);
    expect(store.resolveAccessRequest(first.request.id, "approved", 200, 3_000)?.status).toBe(
      "approved",
    );
    expect(store.resolveAccessRequest(first.request.id, "denied", 200, 4_000)).toBeUndefined();
    store.close();
  });

  it("binds callback actions to one user and one use", () => {
    const store = new Store(":memory:");
    const issued = store.issueAction("test", { value: 42 }, 100, 10_000, 1_000);
    expect(store.consumeAction(issued.id, 999, 2_000)).toBeUndefined();
    expect(store.consumeAction<{ value: number }>(issued.id, 100, 2_000)?.payload.value).toBe(42);
    expect(store.consumeAction(issued.id, 100, 3_000)).toBeUndefined();
    store.close();
  });

  it("persists chat selection and can clear a session", () => {
    const store = new Store(":memory:");
    store.updateChatState(100, "/default", {
      directory: "/workspace",
      sessionId: "session-1",
      providerId: "provider",
      modelId: "model",
    });
    expect(store.getChatState(100, "/default")).toMatchObject({
      directory: "/workspace",
      sessionId: "session-1",
      providerId: "provider",
      modelId: "model",
    });
    expect(store.updateChatState(100, "/default", { sessionId: null }).sessionId).toBeUndefined();
    store.close();
  });
});
