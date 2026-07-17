import { describe, expect, test } from "bun:test";

process.env.CODEX_BRIDGE_NO_SERVER = "1";

const { __testing } = await import("./index.js");
const { startTurnSubagentRefreshForTesting, subscribeForTesting } = __testing;

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-refresh",
    conversationMode: "build",
    fastMode: false,
    threadOptions: {},
    messages: [],
    status: "running",
    currentItems: new Map(),
    currentItemOrder: [],
    fileChangeBaselines: new Map(),
    fileChangeDiffCache: new Map(),
    pendingAttachments: [],
    lastAccessed: 0,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await Bun.sleep(10);
  }
}

describe("startTurnSubagentRefresh", () => {
  test("emits message updates when a periodic rebuild changes the parts", async () => {
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
        ["item-1", { id: "item-1", type: "agent_message", text: "First snapshot" }],
      ]),
    });
    const events: Array<{ type: string }> = [];
    const unsubscribe = subscribeForTesting((event) => {
      events.push(event as { type: string });
    });
    const timer = startTurnSubagentRefreshForTesting(session, () => true, 10);

    try {
      await waitFor(() => events.some((event) => event.type === "message.updated"));
      const emittedAfterFirstChange = events.length;

      // No state change: additional ticks must not re-emit the same snapshot.
      await Bun.sleep(80);
      expect(events.length).toBe(emittedAfterFirstChange);

      session.currentItems.set("item-1", {
        id: "item-1",
        type: "agent_message",
        text: "Second snapshot",
      });
      await waitFor(() => events.length > emittedAfterFirstChange);
      expect(message.parts).toEqual([{ type: "text", content: "Second snapshot" }]);
    } finally {
      clearInterval(timer);
      unsubscribe();
    }
  });

  test("does not rebuild or emit once the turn is no longer current", async () => {
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
        ["item-1", { id: "item-1", type: "agent_message", text: "Stale turn" }],
      ]),
    });
    const events: Array<{ type: string }> = [];
    const unsubscribe = subscribeForTesting((event) => {
      events.push(event as { type: string });
    });
    const timer = startTurnSubagentRefreshForTesting(session, () => false, 10);

    try {
      await Bun.sleep(80);
      expect(events).toEqual([]);
      expect(message.parts).toEqual([]);
    } finally {
      clearInterval(timer);
      unsubscribe();
    }
  });
});
