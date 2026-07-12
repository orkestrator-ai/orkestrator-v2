import { beforeEach, describe, expect, test } from "bun:test";
import {
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
});
