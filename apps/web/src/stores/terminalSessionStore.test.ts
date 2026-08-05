import { beforeEach, describe, expect, test } from "bun:test";
import {
  createSessionKey,
  type TerminalComposeDraftImage,
  useTerminalSessionStore,
} from "./terminalSessionStore";

function resetTerminalSessionStore() {
  useTerminalSessionStore.setState({
    sessions: new Map(),
    composeDraftText: new Map(),
    composeDraftImages: new Map(),
  });
}

function createDraftImage(id: string): TerminalComposeDraftImage {
  return {
    id,
    dataUrl: "data:image/png;base64,ZmFrZQ==",
    base64Data: "ZmFrZQ==",
    width: 100,
    height: 50,
  };
}

describe("terminalSessionStore compose drafts", () => {
  beforeEach(() => {
    resetTerminalSessionStore();
  });

  test("stores and clears compose draft text", () => {
    const store = useTerminalSessionStore.getState();
    const sessionKey = "container-1:tab-1";

    store.setComposeDraftText(sessionKey, "draft command");
    expect(useTerminalSessionStore.getState().getComposeDraftText(sessionKey)).toBe("draft command");

    store.setComposeDraftText(sessionKey, "");
    expect(useTerminalSessionStore.getState().getComposeDraftText(sessionKey)).toBe("");
  });

  test("appends and removes compose draft images without overwriting existing images", () => {
    const store = useTerminalSessionStore.getState();
    const sessionKey = "container-1:tab-1";
    const imageA = createDraftImage("img-a");
    const imageB = createDraftImage("img-b");

    store.appendComposeDraftImage(sessionKey, imageA);
    store.appendComposeDraftImage(sessionKey, imageB);

    expect(useTerminalSessionStore.getState().getComposeDraftImages(sessionKey)).toEqual([
      imageA,
      imageB,
    ]);

    store.removeComposeDraftImage(sessionKey, "img-a");
    expect(useTerminalSessionStore.getState().getComposeDraftImages(sessionKey)).toEqual([imageB]);

    store.removeComposeDraftImage(sessionKey, "img-b");
    expect(useTerminalSessionStore.getState().getComposeDraftImages(sessionKey)).toEqual([]);
  });

  test("removeSession clears persisted compose drafts", () => {
    const store = useTerminalSessionStore.getState();
    const sessionKey = "container-2:tab-3";

    store.setSession(sessionKey, { sessionId: "pty-1" });
    store.setComposeDraftText(sessionKey, "hello");
    store.appendComposeDraftImage(sessionKey, createDraftImage("img-1"));

    store.removeSession(sessionKey);

    expect(useTerminalSessionStore.getState().getSession(sessionKey)).toBeUndefined();
    expect(useTerminalSessionStore.getState().getComposeDraftText(sessionKey)).toBe("");
    expect(useTerminalSessionStore.getState().getComposeDraftImages(sessionKey)).toEqual([]);
  });

  test("creates container, local, and fallback session keys", () => {
    expect(createSessionKey("container-1", "tab-1", "env-1")).toBe("container-1:tab-1");
    expect(createSessionKey(null, "tab-1", "env-1")).toBe("local-env-1:tab-1");
    expect(createSessionKey(null, "tab-1")).toBe("local:tab-1");
  });

  test("reads and updates every session identifier and buffer field", () => {
    const store = useTerminalSessionStore.getState();
    store.setSession("tab", { sessionId: "pty", persistentSessionId: "persist", serializedBuffer: "old" });
    expect(store.getSessionId("tab")).toBe("pty");
    expect(store.getPersistentSessionId("tab")).toBe("persist");

    store.setSerializedBuffer("tab", "new");
    store.setPersistentSessionId("tab", "persist-2");
    expect(useTerminalSessionStore.getState().getSession("tab")).toEqual({
      sessionId: "pty",
      persistentSessionId: "persist-2",
      serializedBuffer: "new",
    });

    const before = useTerminalSessionStore.getState().sessions;
    store.setSerializedBuffer("missing", "ignored");
    store.setPersistentSessionId("missing", "ignored");
    expect(useTerminalSessionStore.getState().sessions).toBe(before);
  });

  test("sets image collections and clears every store map", () => {
    const store = useTerminalSessionStore.getState();
    const image = createDraftImage("img");
    store.setSession("tab", { sessionId: "pty" });
    store.setComposeDraftText("tab", "draft");
    store.setComposeDraftImages("tab", [image]);
    expect(store.getComposeDraftImages("tab")).toEqual([image]);
    store.setComposeDraftImages("tab", []);
    expect(store.getComposeDraftImages("tab")).toEqual([]);
    store.clearComposeDraft("tab");
    store.clearAllSessions();
    const state = useTerminalSessionStore.getState();
    expect(state.sessions.size).toBe(0);
    expect(state.composeDraftText.size).toBe(0);
    expect(state.composeDraftImages.size).toBe(0);
  });
});
