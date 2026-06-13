import { describe, expect, test } from "bun:test";

process.env.CODEX_BRIDGE_NO_SERVER = "1";

const { __testing } = await import("./index.js");
const { rebuildAssistantMessage } = __testing;

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    conversationMode: "build",
    fastMode: false,
    threadOptions: {},
    messages: [],
    status: "idle",
    currentItems: new Map(),
    currentItemOrder: [],
    fileChangeBaselines: new Map(),
    fileChangeDiffCache: new Map(),
    pendingAttachments: [],
    lastAccessed: 0,
    ...overrides,
  };
}

describe("rebuildAssistantMessage", () => {
  test("returns null when there is no current assistant message id", async () => {
    const session = createSession();
    expect(await rebuildAssistantMessage(session)).toBeNull();
  });

  test("returns null when the current assistant message is not in the session", async () => {
    const session = createSession({ currentAssistantMessageId: "missing" });
    expect(await rebuildAssistantMessage(session)).toBeNull();
  });

  test("returns the rebuilt message reference with content derived from items", async () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      parts: [],
      createdAt: new Date(0).toISOString(),
    };
    const session = createSession({
      currentAssistantMessageId: "assistant-1",
      messages: [message],
      currentItemOrder: ["item-1"],
      currentItems: new Map([
        ["item-1", { id: "item-1", type: "agent_message", text: "Hello from Codex" }],
      ]),
    });

    const result = await rebuildAssistantMessage(session);

    // Same reference as the message stored on the session (so emit payloads and
    // session state stay in sync).
    expect(result).toBe(session.messages[0]);
    expect(result?.content).toBe("Hello from Codex");
    expect(result?.parts).toEqual([{ type: "text", content: "Hello from Codex" }]);
  });
});
