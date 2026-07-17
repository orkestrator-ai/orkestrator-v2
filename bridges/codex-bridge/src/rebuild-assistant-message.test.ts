import { afterEach, describe, expect, test } from "bun:test";

process.env.CODEX_BRIDGE_NO_SERVER = "1";

const { __testing } = await import("./index.js");
const { rebuildAssistantMessage } = __testing;

afterEach(() => {
  __testing.setBeforeAssistantMessageCommitForTesting(null);
});

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

  test("updates the assistant timestamp only when a stream receipt time is provided", async () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      parts: [],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    const session = createSession({
      currentAssistantMessageId: "assistant-1",
      messages: [message],
      currentItemOrder: ["item-1"],
      currentItems: new Map([
        ["item-1", { id: "item-1", type: "agent_message", text: "Still working" }],
      ]),
    });

    await rebuildAssistantMessage(session);
    expect(message.createdAt).toBe("2026-04-15T10:00:00.000Z");

    await rebuildAssistantMessage(session, {
      receivedAt: "2026-04-15T10:03:00.000Z",
    });
    expect(message.createdAt).toBe("2026-04-15T10:03:00.000Z");
  });

  test("does not let an older same-turn rebuild overwrite a newer item snapshot", async () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      parts: [],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    const session = createSession({
      currentAssistantMessageId: "assistant-1",
      currentTimelineGeneration: 1,
      messages: [message],
      currentItemOrder: ["answer"],
      currentTimelineOrder: ["item:answer"],
      currentItems: new Map([
        ["answer", { id: "answer", type: "agent_message", text: "Older snapshot" }],
      ]),
      currentSubagentParts: new Map(),
      currentSubagentFingerprints: new Map(),
    });
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let rebuildCount = 0;
    __testing.setBeforeAssistantMessageCommitForTesting(async () => {
      rebuildCount += 1;
      if (rebuildCount === 1) {
        enteredFirst();
        await release;
      }
    });

    const olderRebuild = rebuildAssistantMessage(session);
    await entered;
    __testing.recordCurrentItemForTesting(session, {
      id: "answer",
      type: "agent_message",
      text: "Newer snapshot",
    });
    const newerRebuild = await rebuildAssistantMessage(session);
    expect(newerRebuild?.content).toBe("Newer snapshot");

    releaseFirst();
    expect(await olderRebuild).toBeNull();
    expect(message.content).toBe("Newer snapshot");
    expect(message.parts).toEqual([{ type: "text", content: "Newer snapshot" }]);
  });

  test("lets a later rebuild request supersede an overlapping rebuild", async () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      parts: [],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    const session = createSession({
      currentAssistantMessageId: message.id,
      messages: [message],
      currentItemOrder: ["answer"],
      currentItems: new Map([
        ["answer", { id: "answer", type: "agent_message", text: "Same snapshot" }],
      ]),
    });
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let rebuildCount = 0;
    __testing.setBeforeAssistantMessageCommitForTesting(async () => {
      rebuildCount += 1;
      if (rebuildCount === 1) {
        enteredFirst();
        await release;
      }
    });

    const olderRebuild = rebuildAssistantMessage(session);
    await entered;
    expect((await rebuildAssistantMessage(session))?.content).toBe("Same snapshot");
    releaseFirst();
    expect(await olderRebuild).toBeNull();
  });

  test("does not commit a rebuild after a new turn resets the timeline", async () => {
    const oldMessage = {
      id: "assistant-old",
      role: "assistant",
      content: "",
      parts: [],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    const newMessage = {
      id: "assistant-new",
      role: "assistant",
      content: "",
      parts: [],
      createdAt: "2026-04-15T10:01:00.000Z",
    };
    const session = createSession({
      currentAssistantMessageId: "assistant-old",
      currentTimelineGeneration: 1,
      messages: [oldMessage],
      currentItemOrder: ["old-answer"],
      currentTimelineOrder: ["item:old-answer"],
      currentItems: new Map([
        ["old-answer", { id: "old-answer", type: "agent_message", text: "Old turn" }],
      ]),
      currentSubagentParts: new Map(),
      currentSubagentFingerprints: new Map(),
    });
    let releaseCommit!: () => void;
    let enteredCommit!: () => void;
    const entered = new Promise<void>((resolve) => { enteredCommit = resolve; });
    const release = new Promise<void>((resolve) => { releaseCommit = resolve; });
    __testing.setBeforeAssistantMessageCommitForTesting(async () => {
      enteredCommit();
      await release;
    });

    const staleRebuild = rebuildAssistantMessage(session);
    await entered;
    __testing.resetCurrentTurnTimelineForTesting(session);
    session.messages.push(newMessage);
    session.currentAssistantMessageId = "assistant-new";
    __testing.recordCurrentItemForTesting(session, {
      id: "new-answer",
      type: "agent_message",
      text: "New turn",
    });
    releaseCommit();

    expect(await staleRebuild).toBeNull();
    expect(oldMessage).toMatchObject({ content: "", parts: [] });
    expect(session.currentItemOrder).toEqual(["new-answer"]);
    expect(session.currentTimelineOrder).toEqual(["item:new-answer"]);
  });
});
