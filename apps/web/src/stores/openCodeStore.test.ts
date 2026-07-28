import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  ERROR_MESSAGE_PREFIX,
  type OpenCodeMessage,
  type OpenCodeRuntimeHealth,
  type PermissionRequest,
} from "../lib/opencode-client";
import { OPTIMISTIC_MESSAGE_PREFIX } from "../lib/chat/client-only-messages";
import { type OpenCodeAttachment, useOpenCodeStore } from "./openCodeStore";
import type { ContextUsageSnapshot } from "../lib/context-usage";
import {
  openCodeQuestionDraftKey,
  usePromptDraftStore,
} from "./promptDraftStore";

function resetOpenCodeStore() {
  usePromptDraftStore.getState().reset();
  useOpenCodeStore.setState({
    serverStatus: new Map(),
    sessions: new Map(),
    clients: new Map(),
    models: new Map(),
    modelSource: new Map(),
    slashCommands: new Map(),
    selectedModel: new Map(),
    selectedVariant: new Map(),
    selectedMode: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    isComposing: new Map(),
    pendingQuestions: new Map(),
    pendingPermissions: new Map(),
    eventSubscriptions: new Map(),
    contextUsage: new Map(),
    // Every map the store owns has to be reset here. A map left out is a map
    // that carries state between test files, which makes the first test anyone
    // writes for that action order-dependent.
    runtimeHealth: new Map(),
    selectedAgent: new Map(),
  });
}

function createTextMessage(id: string, createdAt: string): OpenCodeMessage {
  return {
    id,
    role: "assistant",
    content: id,
    parts: [{ type: "text", content: id }],
    createdAt,
  };
}

describe("openCodeStore setMessages", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("preserves client-side error messages once during refresh", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-1:tab-1";

    const serverMessage = createTextMessage("msg-1", "2026-02-11T00:00:00.000Z");
    const errorMessage = createTextMessage(
      `${ERROR_MESSAGE_PREFIX}msg-1`,
      "2026-02-11T00:01:00.000Z"
    );

    store.setSession(sessionKey, {
      sessionId: "session-1",
      messages: [serverMessage, errorMessage],
      isLoading: false,
    });

    store.setMessages(sessionKey, [serverMessage]);

    const messages = useOpenCodeStore.getState().getSession(sessionKey)?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages.filter((m) => m.id === errorMessage.id)).toHaveLength(1);
  });

  test("does not duplicate error messages already included in incoming payload", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-2:tab-1";

    const serverMessage = createTextMessage("msg-2", "2026-02-11T00:00:00.000Z");
    const errorMessage = createTextMessage(
      `${ERROR_MESSAGE_PREFIX}msg-2`,
      "2026-02-11T00:01:00.000Z"
    );

    store.setSession(sessionKey, {
      sessionId: "session-2",
      messages: [serverMessage, errorMessage],
      isLoading: false,
    });

    store.setMessages(sessionKey, [serverMessage, errorMessage]);

    const messages = useOpenCodeStore.getState().getSession(sessionKey)?.messages ?? [];
    expect(messages.filter((m) => m.id === errorMessage.id)).toHaveLength(1);
  });

  test("preserves optimistic user messages until the server echoes them", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-3:tab-1";

    const optimisticUserMessage: OpenCodeMessage = {
      id: `${OPTIMISTIC_MESSAGE_PREFIX}msg-1`,
      role: "user",
      content: "Rename the environment",
      parts: [{ type: "text", content: "Rename the environment" }],
      createdAt: "2026-02-11T00:01:00.000Z",
    };

    store.setSession(sessionKey, {
      sessionId: "session-3",
      messages: [optimisticUserMessage],
      isLoading: true,
    });

    store.setMessages(sessionKey, []);

    const messages = useOpenCodeStore.getState().getSession(sessionKey)?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(optimisticUserMessage.id);
  });

  test("drops optimistic user messages once the server returns the matching prompt", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-4:tab-1";

    const optimisticUserMessage: OpenCodeMessage = {
      id: `${OPTIMISTIC_MESSAGE_PREFIX}msg-2`,
      role: "user",
      content: "Rename the environment",
      parts: [{ type: "text", content: "Rename the environment" }],
      createdAt: "2026-02-11T00:01:00.000Z",
    };
    const serverUserMessage: OpenCodeMessage = {
      id: "msg-2",
      role: "user",
      content: "Rename the environment",
      parts: [{ type: "text", content: "Rename the environment" }],
      createdAt: "2026-02-11T00:01:02.000Z",
    };

    store.setSession(sessionKey, {
      sessionId: "session-4",
      messages: [optimisticUserMessage],
      isLoading: true,
    });

    store.setMessages(sessionKey, [serverUserMessage]);

    const messages = useOpenCodeStore.getState().getSession(sessionKey)?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(serverUserMessage.id);
  });
});

describe("openCodeStore attachment cleanup", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("clearEnvironment removes attachments for every tab in the environment", () => {
    const store = useOpenCodeStore.getState();

    const attachmentA: OpenCodeAttachment = {
      id: "att-a",
      type: "image",
      path: "/workspace/a.png",
      name: "a.png",
    };
    const attachmentB: OpenCodeAttachment = {
      id: "att-b",
      type: "image",
      path: "/workspace/b.png",
      name: "b.png",
    };
    const attachmentOther: OpenCodeAttachment = {
      id: "att-c",
      type: "image",
      path: "/workspace/c.png",
      name: "c.png",
    };

    store.addAttachment("env-env-123:tab-1", attachmentA);
    store.addAttachment("env-env-123:tab-2", attachmentB);
    store.addAttachment("env-env-999:tab-1", attachmentOther);

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getAttachments("env-env-123:tab-1")).toHaveLength(0);
    expect(useOpenCodeStore.getState().getAttachments("env-env-123:tab-2")).toHaveLength(0);
    expect(useOpenCodeStore.getState().getAttachments("env-env-999:tab-1")).toHaveLength(1);
  });
});

describe("openCodeStore clearSession", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("drops every session-keyed entry for one closed tab", () => {
    /**
     * Closing a tab used to clear only its session and queue, so its draft,
     * model, variant, mode and attachments were orphaned for the life of the
     * process — and tab ids are UUIDs, so nothing ever reclaimed them.
     */
    const store = useOpenCodeStore.getState();
    const closed = "env-env-123:tab-1";
    const kept = "env-env-123:tab-2";

    for (const key of [closed, kept]) {
      store.setSession(key, {
        sessionId: key === closed ? "session-closed" : "session-kept",
        messages: [],
        isLoading: false,
      });
      store.setDraftText(key, "draft");
      store.setDraftMentions(key, [
        { path: `/workspace/${key}.ts`, name: `${key}.ts` },
      ] as never);
      store.setSelectedModel(key, "gpt-5");
      store.setSelectedVariant(key, "fast");
      store.setSelectedMode(key, "plan");
      store.setComposing(key, true);
      store.setContextUsage(key, {
        usedTokens: 100,
        totalTokens: 1_000,
        percentUsed: 10,
      });
      store.addToQueue(key, { id: `q-${key}`, text: "queued" } as never);
      store.addAttachment(key, {
        id: `att-${key}`,
        type: "image",
        path: "/workspace/a.png",
        name: "a.png",
      } as never);
    }
    store.addPendingQuestion({
      id: "question-closed",
      sessionId: "session-closed",
      questions: [],
    });
    store.addPendingPermission({
      id: "permission-closed",
      sessionId: "session-closed",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    });
    store.addPendingQuestion({
      id: "question-kept",
      sessionId: "session-kept",
      questions: [],
    });
    usePromptDraftStore.getState().setDraftValue(
      openCodeQuestionDraftKey("question-closed"),
      "answer",
      "target",
    );
    usePromptDraftStore.getState().setDraftValue(
      openCodeQuestionDraftKey("question-kept"),
      "answer",
      "other",
    );
    store.addPendingPermission({
      id: "permission-kept",
      sessionId: "session-kept",
      permission: "read",
      patterns: [],
      metadata: {},
      always: [],
    });

    store.clearSession(closed);

    const next = useOpenCodeStore.getState();
    expect(next.getSession(closed)).toBeUndefined();
    expect(next.getDraftText(closed)).toBe("");
    expect(next.getDraftMentions(closed)).toEqual([]);
    expect(next.getSelectedModel(closed)).toBeUndefined();
    expect(next.getSelectedVariant(closed)).toBeUndefined();
    expect(next.getSelectedMode(closed)).toBe("build");
    expect(next.isComposingFor(closed)).toBe(false);
    expect(next.getContextUsage(closed)).toBeUndefined();
    expect(next.getQueueLength(closed)).toBe(0);
    expect(next.getAttachments(closed)).toHaveLength(0);
    expect(next.getPendingQuestion("question-closed")).toBeUndefined();
    expect(next.getPendingPermission("permission-closed")).toBeUndefined();

    // The sibling tab in the same environment is untouched.
    expect(next.getDraftText(kept)).toBe("draft");
    expect(next.getDraftMentions(kept)).toHaveLength(1);
    expect(next.getSelectedModel(kept)).toBe("gpt-5");
    expect(next.getSelectedVariant(kept)).toBe("fast");
    expect(next.getSelectedMode(kept)).toBe("plan");
    expect(next.isComposingFor(kept)).toBe(true);
    expect(next.getContextUsage(kept)?.percentUsed).toBe(10);
    expect(next.getAttachments(kept)).toHaveLength(1);
    expect(next.getPendingQuestion("question-kept")).toBeTruthy();
    expect(next.getPendingPermission("permission-kept")).toBeTruthy();
    expect(
      usePromptDraftStore.getState().drafts.has(
        openCodeQuestionDraftKey("question-closed"),
      ),
    ).toBe(false);
    expect(
      usePromptDraftStore.getState().drafts.has(
        openCodeQuestionDraftKey("question-kept"),
      ),
    ).toBe(true);
  });

  test("sweeps pending requests belonging to the closed tab's session", () => {
    // Pending requests are keyed by requestId, so a session-key sweep alone
    // would leave a card pointing at a tab that no longer exists.
    const store = useOpenCodeStore.getState();
    const closed = "env-env-123:tab-1";

    store.setSession(closed, {
      sessionId: "session-closed",
      messages: [],
      isLoading: false,
    } as never);
    store.addPendingQuestion({
      id: "req-1",
      sessionId: "session-closed",
      questions: [],
    } as never);
    store.addPendingQuestion({
      id: "req-2",
      sessionId: "session-other",
      questions: [],
    } as never);
    usePromptDraftStore.getState().setDraftValue(
      openCodeQuestionDraftKey("req-1"),
      "answer",
      "target",
    );
    usePromptDraftStore.getState().setDraftValue(
      openCodeQuestionDraftKey("req-2"),
      "answer",
      "other",
    );

    store.clearSession(closed);

    const next = useOpenCodeStore.getState();
    expect(next.getPendingQuestion("req-1")).toBeUndefined();
    expect(next.getPendingQuestion("req-2")).toBeTruthy();
    expect(
      usePromptDraftStore.getState().drafts.has(
        openCodeQuestionDraftKey("req-1"),
      ),
    ).toBe(false);
    expect(
      usePromptDraftStore.getState().drafts.has(
        openCodeQuestionDraftKey("req-2"),
      ),
    ).toBe(true);
  });

  test("clears a tab with no session id without sweeping pending requests", () => {
    // A tab closed before its OpenCode session was created has nothing to sweep
    // by: an empty session id matches every unrelated request, so the sweep is
    // skipped entirely and only the session-keyed maps are pruned.
    const store = useOpenCodeStore.getState();
    const neverStarted = "env-env-123:tab-1";
    const neverOpened = "env-env-123:tab-2";

    store.setSession(neverStarted, {
      sessionId: "",
      messages: [],
      isLoading: false,
    });
    store.setDraftText(neverStarted, "draft");
    store.setSelectedModel(neverStarted, "openai/gpt-5");
    store.setDraftText(neverOpened, "unopened draft");
    store.addPendingQuestion({
      id: "req-unrelated",
      sessionId: "",
      questions: [],
    });
    store.addPendingPermission({
      id: "perm-unrelated",
      sessionId: "",
      permission: "read",
      patterns: [],
      metadata: {},
      always: [],
    });

    store.clearSession(neverStarted);

    let next = useOpenCodeStore.getState();
    expect(next.getSession(neverStarted)).toBeUndefined();
    expect(next.getDraftText(neverStarted)).toBe("");
    expect(next.getSelectedModel(neverStarted)).toBeUndefined();
    expect(next.getPendingQuestion("req-unrelated")).toBeTruthy();
    expect(next.getPendingPermission("perm-unrelated")).toBeTruthy();

    // Same branch when the tab never had a session record at all.
    store.clearSession(neverOpened);

    next = useOpenCodeStore.getState();
    expect(next.getDraftText(neverOpened)).toBe("");
    expect(next.getPendingQuestion("req-unrelated")).toBeTruthy();
    expect(next.getPendingPermission("perm-unrelated")).toBeTruthy();
  });
});

describe("openCodeStore same-environment tab isolation", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("keeps model, variant, mode, composing, queue, title, and context state per tab", () => {
    const store = useOpenCodeStore.getState();
    const tabA = "env-env-123:tab-a";
    const tabB = "env-env-123:tab-b";

    store.setSession(tabA, {
      sessionId: "session-a",
      messages: [],
      isLoading: false,
    });
    store.setSession(tabB, {
      sessionId: "session-b",
      messages: [],
      isLoading: false,
    });
    store.setSelectedModel(tabA, "openai/gpt-5");
    store.setSelectedModel(tabB, "anthropic/claude-sonnet");
    store.setSelectedVariant(tabA, "high");
    store.setSelectedVariant(tabB, "low");
    store.setSelectedMode(tabA, "plan");
    store.setSelectedMode(tabB, "build");
    store.setComposing(tabA, true);
    store.setComposing(tabB, false);
    store.addToQueue(tabA, {
      id: "queued-a",
      text: "Plan A",
      attachments: [],
      model: "openai/gpt-5",
      variant: "high",
      mode: "plan",
    });
    store.addToQueue(tabB, {
      id: "queued-b",
      text: "Build B",
      attachments: [],
      model: "anthropic/claude-sonnet",
      variant: "low",
      mode: "build",
    });
    store.setSessionTitle(tabA, "Planning tab");
    store.setSessionTitle(tabB, "Build tab");
    store.setContextUsage(tabA, {
      usedTokens: 100,
      totalTokens: 1_000,
      percentUsed: 10,
      modelId: "openai/gpt-5",
    });
    store.setContextUsage(tabB, {
      usedTokens: 600,
      totalTokens: 2_000,
      percentUsed: 30,
      modelId: "anthropic/claude-sonnet",
    });

    const state = useOpenCodeStore.getState();
    expect(state.getSelectedModel(tabA)).toBe("openai/gpt-5");
    expect(state.getSelectedModel(tabB)).toBe("anthropic/claude-sonnet");
    expect(state.getSelectedVariant(tabA)).toBe("high");
    expect(state.getSelectedVariant(tabB)).toBe("low");
    expect(state.getSelectedMode(tabA)).toBe("plan");
    expect(state.getSelectedMode(tabB)).toBe("build");
    expect(state.isComposingFor(tabA)).toBe(true);
    expect(state.isComposingFor(tabB)).toBe(false);
    expect(state.getQueueLength(tabA)).toBe(1);
    expect(state.getQueueLength(tabB)).toBe(1);
    expect(state.getSession(tabA)?.title).toBe("Planning tab");
    expect(state.getSession(tabB)?.title).toBe("Build tab");
    expect(state.getContextUsage(tabA)?.modelId).toBe("openai/gpt-5");
    expect(state.getContextUsage(tabB)?.modelId).toBe(
      "anthropic/claude-sonnet",
    );

    store.clearSession(tabA);

    const afterClose = useOpenCodeStore.getState();
    expect(afterClose.getSession(tabA)).toBeUndefined();
    expect(afterClose.getSelectedModel(tabA)).toBeUndefined();
    expect(afterClose.getSelectedVariant(tabA)).toBeUndefined();
    expect(afterClose.getSelectedMode(tabA)).toBe("build");
    expect(afterClose.isComposingFor(tabA)).toBe(false);
    expect(afterClose.getQueueLength(tabA)).toBe(0);
    expect(afterClose.getContextUsage(tabA)).toBeUndefined();

    expect(afterClose.getSession(tabB)?.title).toBe("Build tab");
    expect(afterClose.getSelectedModel(tabB)).toBe("anthropic/claude-sonnet");
    expect(afterClose.getSelectedVariant(tabB)).toBe("low");
    expect(afterClose.getSelectedMode(tabB)).toBe("build");
    expect(afterClose.getQueueLength(tabB)).toBe(1);
    expect(afterClose.getContextUsage(tabB)?.percentUsed).toBe(30);
  });
});

describe("openCodeStore draft text", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("setDraftText stores and clears draft text per tab session", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-123:tab-1";

    store.setDraftText(sessionKey, "draft message");
    expect(useOpenCodeStore.getState().getDraftText(sessionKey)).toBe("draft message");

    store.setDraftText(sessionKey, "");
    expect(useOpenCodeStore.getState().getDraftText(sessionKey)).toBe("");
  });

  test("clearEnvironment removes draft text for every tab in the environment", () => {
    const store = useOpenCodeStore.getState();

    store.setDraftText("env-env-123:tab-1", "draft a");
    store.setDraftText("env-env-123:tab-2", "draft b");
    store.setDraftText("env-env-999:tab-1", "keep");

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getDraftText("env-env-123:tab-1")).toBe("");
    expect(useOpenCodeStore.getState().getDraftText("env-env-123:tab-2")).toBe("");
    expect(useOpenCodeStore.getState().getDraftText("env-env-999:tab-1")).toBe("keep");
  });
});

describe("openCodeStore selected mode", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("stores mode per tab session key", () => {
    const store = useOpenCodeStore.getState();

    store.setSelectedMode("env-env-123:tab-1", "plan");
    store.setSelectedMode("env-env-123:tab-2", "build");

    expect(useOpenCodeStore.getState().getSelectedMode("env-env-123:tab-1")).toBe("plan");
    expect(useOpenCodeStore.getState().getSelectedMode("env-env-123:tab-2")).toBe("build");
    expect(useOpenCodeStore.getState().getSelectedMode("env-env-123:tab-3")).toBe("build");
  });

  test("clearEnvironment removes tab-scoped mode keys for the environment", () => {
    const store = useOpenCodeStore.getState();

    store.setSelectedMode("env-env-123:tab-1", "plan");
    store.setSelectedMode("env-env-123:tab-2", "plan");
    store.setSelectedMode("env-env-999:tab-1", "plan");

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getSelectedMode("env-env-123:tab-1")).toBe("build");
    expect(useOpenCodeStore.getState().getSelectedMode("env-env-123:tab-2")).toBe("build");
    expect(useOpenCodeStore.getState().getSelectedMode("env-env-999:tab-1")).toBe("plan");
  });
});

describe("openCodeStore slash commands", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("stores slash commands per environment", () => {
    const store = useOpenCodeStore.getState();

    store.setSlashCommands("env-123", [
      { name: "/build", description: "Build" },
      { name: "/fix", description: "Fix" },
    ]);
    store.setSlashCommands("env-999", [{ name: "/test", description: "Test" }]);

    expect(store.getSlashCommands("env-123")).toEqual([
      { name: "/build", description: "Build" },
      { name: "/fix", description: "Fix" },
    ]);
    expect(store.getSlashCommands("env-999")).toEqual([
      { name: "/test", description: "Test" },
    ]);
  });

  test("clearEnvironment removes slash commands for that environment", () => {
    const store = useOpenCodeStore.getState();

    store.setSlashCommands("env-123", [{ name: "/build", description: "Build" }]);
    store.setSlashCommands("env-999", [{ name: "/test", description: "Test" }]);

    store.clearEnvironment("env-123");

    expect(store.getSlashCommands("env-123")).toEqual([]);
    expect(store.getSlashCommands("env-999")).toEqual([
      { name: "/test", description: "Test" },
    ]);
  });
});

describe("openCodeStore models", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("stores models per environment", () => {
    const store = useOpenCodeStore.getState();

    store.setModels("env-123", [
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
    ]);
    store.setModels("env-999", [
      { id: "openai/gpt-5", name: "GPT-5", provider: "openai" },
    ]);

    expect(store.getModels("env-123")).toEqual([
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
    ]);
    expect(store.getModels("env-999")).toEqual([
      { id: "openai/gpt-5", name: "GPT-5", provider: "openai" },
    ]);
  });

  test("clearEnvironment removes models only for that environment", () => {
    const store = useOpenCodeStore.getState();

    store.setModels("env-123", [
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
    ]);
    store.setModels("env-999", [
      { id: "openai/gpt-5", name: "GPT-5", provider: "openai" },
    ]);

    store.clearEnvironment("env-123");

    expect(store.getModels("env-123")).toEqual([]);
    expect(store.getModels("env-999")).toEqual([
      { id: "openai/gpt-5", name: "GPT-5", provider: "openai" },
    ]);
  });

  test("treats a catalogue as live only when a server reported it", () => {
    const store = useOpenCodeStore.getState();
    const model = { id: "openai/gpt-5", name: "GPT-5", provider: "openai" };

    // Default source is the live server fetch, which is the common caller.
    store.setModels("env-live", [model]);
    store.setModels("env-cached", [model], "cache");
    store.setModels("env-explicit", [model], "server");

    expect(store.hasLiveModels("env-live")).toBe(true);
    expect(store.hasLiveModels("env-explicit")).toBe(true);
    expect(store.hasLiveModels("env-cached")).toBe(false);
    // Never populated at all.
    expect(store.hasLiveModels("env-unknown")).toBe(false);
  });

  test("an empty catalogue is never live, whatever it claims", () => {
    const store = useOpenCodeStore.getState();

    store.setModels("env-123", [], "server");

    expect(store.hasLiveModels("env-123")).toBe(false);
  });

  test("provenance is upgraded and downgraded with the catalogue it describes", () => {
    const store = useOpenCodeStore.getState();
    const cached = { id: "openai/cached", name: "Cached", provider: "openai" };
    const live = { id: "openai/live", name: "Live", provider: "openai" };

    store.setModels("env-123", [cached], "cache");
    expect(store.hasLiveModels("env-123")).toBe(false);

    store.setModels("env-123", [live], "server");
    expect(store.hasLiveModels("env-123")).toBe(true);

    // A later cache rehydration must not keep claiming to be authoritative.
    store.setModels("env-123", [cached], "cache");
    expect(store.hasLiveModels("env-123")).toBe(false);
  });

  test("clearEnvironment drops provenance with the models", () => {
    const store = useOpenCodeStore.getState();
    const model = { id: "openai/gpt-5", name: "GPT-5", provider: "openai" };

    store.setModels("env-123", [model], "server");
    store.setModels("env-999", [model], "server");
    store.clearEnvironment("env-123");

    expect(store.hasLiveModels("env-123")).toBe(false);
    expect(useOpenCodeStore.getState().modelSource.has("env-123")).toBe(false);
    expect(store.hasLiveModels("env-999")).toBe(true);
  });
});

describe("openCodeStore queue", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("queues prompts per tab and dequeues in FIFO order", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-123:tab-1";

    store.addToQueue(sessionKey, {
      id: "queue-1",
      text: "First prompt",
      attachments: [],
      mode: "build",
    });
    store.addToQueue(sessionKey, {
      id: "queue-2",
      text: "Second prompt",
      attachments: [],
      mode: "plan",
    });

    expect(useOpenCodeStore.getState().getQueueLength(sessionKey)).toBe(2);

    const first = store.removeFromQueue(sessionKey);
    const second = store.removeFromQueue(sessionKey);
    const third = store.removeFromQueue(sessionKey);

    expect(first?.id).toBe("queue-1");
    expect(second?.id).toBe("queue-2");
    expect(third).toBeUndefined();
    expect(useOpenCodeStore.getState().getQueueLength(sessionKey)).toBe(0);
  });

  test("clearEnvironment removes queued prompts for every tab session", () => {
    const store = useOpenCodeStore.getState();

    store.addToQueue("env-env-123:tab-1", {
      id: "queue-a",
      text: "A",
      attachments: [],
      mode: "build",
    });
    store.addToQueue("env-env-123:tab-2", {
      id: "queue-b",
      text: "B",
      attachments: [],
      mode: "build",
    });
    store.addToQueue("env-env-999:tab-1", {
      id: "queue-c",
      text: "C",
      attachments: [],
      mode: "build",
    });

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getQueueLength("env-env-123:tab-1")).toBe(0);
    expect(useOpenCodeStore.getState().getQueueLength("env-env-123:tab-2")).toBe(0);
    expect(useOpenCodeStore.getState().getQueueLength("env-env-999:tab-1")).toBe(1);
  });

  test("removeQueueItem removes only the targeted queued prompt", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-123:tab-1";

    store.addToQueue(sessionKey, {
      id: "queue-1",
      text: "First",
      attachments: [],
      mode: "build",
    });
    store.addToQueue(sessionKey, {
      id: "queue-2",
      text: "Second",
      attachments: [],
      mode: "build",
    });

    store.removeQueueItem(sessionKey, "queue-1");

    expect(useOpenCodeStore.getState().getQueueLength(sessionKey)).toBe(1);
    expect(store.removeFromQueue(sessionKey)?.id).toBe("queue-2");
  });

  test("moveQueueItem reorders queued prompts", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-123:tab-1";

    store.addToQueue(sessionKey, {
      id: "queue-1",
      text: "First",
      attachments: [],
      mode: "build",
    });
    store.addToQueue(sessionKey, {
      id: "queue-2",
      text: "Second",
      attachments: [],
      mode: "build",
    });
    store.addToQueue(sessionKey, {
      id: "queue-3",
      text: "Third",
      attachments: [],
      mode: "build",
    });

    store.moveQueueItem(sessionKey, 2, 0);

    expect(store.removeFromQueue(sessionKey)?.id).toBe("queue-3");
    expect(store.removeFromQueue(sessionKey)?.id).toBe("queue-1");
    expect(store.removeFromQueue(sessionKey)?.id).toBe("queue-2");
  });
});

describe("openCodeStore pending permissions", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("tracks pending permissions per session", () => {
    const store = useOpenCodeStore.getState();

    const permission: PermissionRequest = {
      id: "perm-1",
      sessionId: "session-1",
      permission: "read",
      patterns: ["/workspace/**"],
      metadata: {},
      always: ["/workspace/**"],
    };

    store.addPendingPermission(permission);

    const permissions = useOpenCodeStore
      .getState()
      .getPendingPermissionsForSession("session-1");

    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.id).toBe("perm-1");
  });

  test("removePendingPermission drops only the answered request", () => {
    const store = useOpenCodeStore.getState();

    store.addPendingPermission({
      id: "perm-1",
      sessionId: "session-1",
      permission: "read",
      patterns: ["/workspace/**"],
      metadata: {},
      always: ["/workspace/**"],
    });
    store.addPendingPermission({
      id: "perm-2",
      sessionId: "session-1",
      permission: "bash",
      patterns: ["*"],
      metadata: {},
      always: [],
    });

    expect(store.getPendingPermissionsForSession("session-1")).toHaveLength(2);

    store.removePendingPermission("perm-1");

    expect(store.getPendingPermission("perm-1")).toBeUndefined();
    expect(store.getPendingPermission("perm-2")?.id).toBe("perm-2");
    expect(store.getPendingPermissionsForSession("session-1")).toHaveLength(1);

    // Removing an id nobody is holding must not throw or disturb the rest.
    store.removePendingPermission("perm-missing");
    expect(store.getPendingPermission("perm-2")?.id).toBe("perm-2");
  });

  test("returns the same empty array for a session with no pending permissions", () => {
    // useSyncExternalStore compares snapshots by reference, so a fresh [] on every
    // read would rerender forever.
    const first = useOpenCodeStore
      .getState()
      .getPendingPermissionsForSession("session-none");
    const second = useOpenCodeStore
      .getState()
      .getPendingPermissionsForSession("session-none");

    expect(first).toBe(second);
    expect(first).toEqual([]);
  });

  test("clearEnvironment removes pending permissions for every tab session", () => {
    const store = useOpenCodeStore.getState();

    store.setSession("env-env-123:tab-1", {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    });
    store.setSession("env-env-123:tab-2", {
      sessionId: "session-2",
      messages: [],
      isLoading: false,
    });
    store.setSession("env-env-999:tab-1", {
      sessionId: "session-3",
      messages: [],
      isLoading: false,
    });

    store.addPendingPermission({
      id: "perm-a",
      sessionId: "session-1",
      permission: "read",
      patterns: ["/workspace/a/**"],
      metadata: {},
      always: ["/workspace/a/**"],
    });
    store.addPendingPermission({
      id: "perm-b",
      sessionId: "session-2",
      permission: "bash",
      patterns: ["*"],
      metadata: {},
      always: [],
    });
    store.addPendingPermission({
      id: "perm-c",
      sessionId: "session-3",
      permission: "read",
      patterns: ["/workspace/c/**"],
      metadata: {},
      always: ["/workspace/c/**"],
    });
    store.addPendingQuestion({
      id: "question-a",
      sessionId: "session-1",
      questions: [],
    });
    store.addPendingQuestion({
      id: "question-c",
      sessionId: "session-3",
      questions: [],
    });
    usePromptDraftStore.getState().setDraftValue(
      openCodeQuestionDraftKey("question-a"),
      "answer",
      "target",
    );
    usePromptDraftStore.getState().setDraftValue(
      openCodeQuestionDraftKey("question-c"),
      "answer",
      "other",
    );

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getPendingPermission("perm-a")).toBeUndefined();
    expect(useOpenCodeStore.getState().getPendingPermission("perm-b")).toBeUndefined();
    expect(useOpenCodeStore.getState().getPendingPermission("perm-c")).toBeDefined();
    expect(
      usePromptDraftStore.getState().drafts.has(
        openCodeQuestionDraftKey("question-a"),
      ),
    ).toBe(false);
    expect(
      usePromptDraftStore.getState().drafts.has(
        openCodeQuestionDraftKey("question-c"),
      ),
    ).toBe(true);
  });
});

describe("openCodeStore selectors and session mutations", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("preserves timer metadata across loading transitions", () => {
    const originalNow = Date.now;
    Date.now = () => 1000;

    try {
      const store = useOpenCodeStore.getState();
      store.setSession("env-env-1:tab-1", {
        sessionId: "session-1",
        messages: [],
        isLoading: false,
      });

      store.setSessionLoading("env-env-1:tab-1", true);

      let session = store.getSession("env-env-1:tab-1");
      expect(session?.loadingStartedAt).toBe(1000);
      expect(session?.lastCompletedElapsedSeconds).toBeNull();

      Date.now = () => 6500;
      store.setSessionLoading("env-env-1:tab-1", false);

      session = store.getSession("env-env-1:tab-1");
      expect(session?.loadingStartedAt).toBeUndefined();
      expect(session?.lastCompletedElapsedSeconds).toBe(5);
    } finally {
      Date.now = originalNow;
    }
  });

  test("reconciles timer metadata when a loading session refreshes", () => {
    const originalNow = Date.now;
    Date.now = () => 1000;

    try {
      const store = useOpenCodeStore.getState();
      store.setSession("env-env-1:tab-1", {
        sessionId: "session-1",
        messages: [],
        isLoading: false,
      });
      store.setSessionLoading("env-env-1:tab-1", true);

      Date.now = () => 6500;
      store.setSession("env-env-1:tab-1", {
        sessionId: "session-1",
        messages: [],
        isLoading: false,
      });

      const session = store.getSession("env-env-1:tab-1");
      expect(session?.loadingStartedAt).toBeUndefined();
      expect(session?.lastCompletedElapsedSeconds).toBe(5);
    } finally {
      Date.now = originalNow;
    }
  });

  test("does not carry timer metadata across session id changes", () => {
    const originalNow = Date.now;
    Date.now = () => 1000;

    try {
      const store = useOpenCodeStore.getState();
      store.setSession("env-env-1:tab-1", {
        sessionId: "session-1",
        messages: [],
        isLoading: false,
      });
      store.setSessionLoading("env-env-1:tab-1", true);

      Date.now = () => 8000;
      store.setSession("env-env-1:tab-1", {
        sessionId: "session-2",
        messages: [],
        isLoading: true,
      });

      const session = store.getSession("env-env-1:tab-1");
      expect(session?.sessionId).toBe("session-2");
      expect(session?.loadingStartedAt).toBe(8000);
      expect(session?.lastCompletedElapsedSeconds).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });

  test("stores server status, client, model, variant, and session error state", () => {
    const store = useOpenCodeStore.getState();
    const client = { session: {} } as any;

    store.setServerStatus("env-1", { running: true, hostPort: 4321 });
    store.setClient("env-1", client);
    store.setSelectedModel("env-1", "openai/gpt-5");
    store.setSelectedVariant("env-1", "high");
    store.setSession("env-env-1:tab-1", {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    });
    store.setSessionLoading("env-env-1:tab-1", true);
    store.setSessionError("env-env-1:tab-1", "send failed");

    expect(store.getServerStatus("env-1")).toEqual({ running: true, hostPort: 4321 });
    expect(store.getClient("env-1")).toBe(client);
    expect(store.getSelectedModel("env-1")).toBe("openai/gpt-5");
    expect(store.getSelectedVariant("env-1")).toBe("high");
    expect(store.getSession("env-env-1:tab-1")).toMatchObject({
      isLoading: true,
      error: "send failed",
    });

    store.setClient("env-1", null);
    store.setSelectedVariant("env-1", "");

    expect(store.getClient("env-1")).toBeUndefined();
    expect(store.getSelectedVariant("env-1")).toBeUndefined();
  });

  test("setSelectedVariant treats a blank or whitespace-only value as no variant", () => {
    // A variant is sent verbatim to the model picker, so " " is not a selection —
    // it has to clear the key rather than be stored and later sent as-is.
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.setSelectedVariant(sessionKey, "high");
    expect(useOpenCodeStore.getState().getSelectedVariant(sessionKey)).toBe("high");

    store.setSelectedVariant(sessionKey, "   ");
    expect(useOpenCodeStore.getState().getSelectedVariant(sessionKey)).toBeUndefined();

    store.setSelectedVariant(sessionKey, "low");
    store.setSelectedVariant(sessionKey, "\t\n");
    expect(useOpenCodeStore.getState().getSelectedVariant(sessionKey)).toBeUndefined();

    store.setSelectedVariant(sessionKey, "low");
    store.setSelectedVariant(sessionKey, undefined);
    expect(useOpenCodeStore.getState().getSelectedVariant(sessionKey)).toBeUndefined();

    // A padded but non-blank value is a real selection and is kept verbatim.
    store.setSelectedVariant(sessionKey, " high ");
    expect(useOpenCodeStore.getState().getSelectedVariant(sessionKey)).toBe(" high ");
  });

  test("adds and removes messages from an existing session", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-1:tab-1";
    const message: OpenCodeMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello",
      parts: [{ type: "text", content: "Hello" }],
      createdAt: "2026-04-15T10:00:00.000Z",
    };

    store.setSession(sessionKey, {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    });

    store.addMessage(sessionKey, message);
    expect(store.getSession(sessionKey)?.messages).toHaveLength(1);

    store.removeMessage(sessionKey, message.id);
    expect(store.getSession(sessionKey)?.messages).toHaveLength(0);
  });
});

describe("openCodeStore attachments, drafts, and composing state", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("removes and clears attachments for a tab session", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.addAttachment(sessionKey, {
      id: "att-1",
      type: "image",
      path: "/workspace/a.png",
      name: "a.png",
    });
    store.addAttachment(sessionKey, {
      id: "att-2",
      type: "file",
      path: "/workspace/b.txt",
      name: "b.txt",
    });

    store.removeAttachment(sessionKey, "att-1");
    expect(store.getAttachments(sessionKey).map((attachment) => attachment.id)).toEqual(["att-2"]);

    store.clearAttachments(sessionKey);
    expect(store.getAttachments(sessionKey)).toHaveLength(0);
  });

  test("stores draft mentions and composing state", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-1:tab-1";
    const mentions = [{ path: "/workspace/file.ts", name: "file.ts" }] as any;

    store.setDraftMentions(sessionKey, mentions);
    store.setComposing("env-1", true);

    expect(store.getDraftMentions(sessionKey)).toEqual(mentions);
    expect(store.isComposingFor("env-1")).toBe(true);

    store.setDraftMentions(sessionKey, []);
    store.setComposing("env-1", false);

    expect(store.getDraftMentions(sessionKey)).toEqual([]);
    expect(store.isComposingFor("env-1")).toBe(false);
  });

  test("stores and clears context usage snapshots", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-1:tab-1";
    // Every provider-exact field has to survive the round trip: the store is
    // where the usage panel reads them back from, so a field the store quietly
    // dropped would simply never render.
    const usage: ContextUsageSnapshot = {
      usedTokens: 1200,
      totalTokens: 8000,
      percentUsed: 15,
      modelId: "openai/gpt-5",
      inputTokens: 900,
      outputTokens: 200,
      cacheReadTokens: 100,
      cacheWriteTokens: 40,
      reasoningTokens: 25,
      lastTurnTokens: 1200,
      sessionTokens: 1240,
      costUsd: 0.031,
      durationMs: 4200,
      apiDurationMs: 3900,
      estimated: false,
      source: "opencode",
      updatedAt: "2026-07-26T00:00:00.000Z",
      rateLimits: [
        { label: "5h", usedPercent: 12, resetsAt: "2026-07-26T05:00:00.000Z", windowMinutes: 300 },
      ],
      credits: { hasCredits: true, unlimited: false, balance: "12.00" },
      contextCategories: [{ name: "tools", tokens: 500, color: "#fff" }],
      permissionDenials: 2,
      linesAdded: 30,
      linesRemoved: 4,
    };

    store.setContextUsage(sessionKey, usage);
    expect(store.getContextUsage(sessionKey)).toEqual(usage);

    store.setContextUsage(sessionKey, null);
    expect(store.getContextUsage(sessionKey)).toBeUndefined();
    expect(useOpenCodeStore.getState().contextUsage.has(sessionKey)).toBe(false);
  });

  test("replaces rather than merges an earlier usage snapshot", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.setContextUsage(sessionKey, {
      usedTokens: 1200,
      totalTokens: 8000,
      percentUsed: 15,
      costUsd: 0.5,
    });
    store.setContextUsage(sessionKey, {
      usedTokens: 10,
      totalTokens: 8000,
      percentUsed: 0.125,
    });

    // A stale `costUsd` surviving a replacement would show a cost from a turn
    // that no longer exists.
    expect(store.getContextUsage(sessionKey)).toEqual({
      usedTokens: 10,
      totalTokens: 8000,
      percentUsed: 0.125,
    });
  });
});

describe("openCodeStore questions and event subscriptions", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("tracks pending questions per session", () => {
    const store = useOpenCodeStore.getState();

    store.addPendingQuestion({
      id: "question-1",
      sessionId: "session-1",
      messageID: "msg-1",
      question: {
        header: "Confirm",
        question: "Proceed?",
        options: [{ label: "Yes" }],
      },
    } as any);

    expect(store.getPendingQuestionsForSession("session-1")).toHaveLength(1);
    expect(store.getPendingQuestion("question-1")?.id).toBe("question-1");

    store.removePendingQuestion("question-1");
    expect(store.getPendingQuestion("question-1")).toBeUndefined();
  });

  test("returns the same empty array for a session with no pending questions", () => {
    // Same reference-stability contract as the permissions selector: a new []
    // per read would loop useSyncExternalStore.
    const first = useOpenCodeStore
      .getState()
      .getPendingQuestionsForSession("session-none");
    const second = useOpenCodeStore
      .getState()
      .getPendingQuestionsForSession("session-none");

    expect(first).toBe(second);
    expect(first).toEqual([]);
  });

  test("removes a pending permission without disturbing other requests", () => {
    const store = useOpenCodeStore.getState();
    store.addPendingPermission({
      id: "permission-1",
      sessionId: "session-1",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    });
    store.addPendingPermission({
      id: "permission-2",
      sessionId: "session-2",
      permission: "read",
      patterns: [],
      metadata: {},
      always: [],
    });

    store.removePendingPermission("permission-1");

    expect(store.getPendingPermission("permission-1")).toBeUndefined();
    expect(store.getPendingPermission("permission-2")?.id).toBe("permission-2");
  });

  test("reuses an active event subscription instead of creating a second stream owner", () => {
    const store = useOpenCodeStore.getState();
    const first = store.getOrCreateEventSubscription("env-1");
    const second = store.getOrCreateEventSubscription("env-1");

    expect(second).toBe(first);
    expect(useOpenCodeStore.getState().eventSubscriptions.size).toBe(1);
  });

  test("creates, updates, and closes event subscriptions", async () => {
    const store = useOpenCodeStore.getState();
    let closed = false;
    const stream: AsyncIterable<any> = {
      [Symbol.asyncIterator](): AsyncIterableIterator<any> {
        return {
          async next(): Promise<IteratorResult<any>> {
            return { done: true as const, value: undefined };
          },
          async return(): Promise<IteratorResult<any>> {
            closed = true;
            return { done: true as const, value: undefined };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };

    const subscription = store.getOrCreateEventSubscription("env-1");
    expect(subscription?.isActive).toBe(true);
    expect(store.hasActiveEventSubscription("env-1")).toBe(true);

    store.setEventStream("env-1", stream);
    expect(store.hasActiveEventSubscription("env-1")).toBe(true);

    store.setEventStream("env-1", null);
    expect(store.hasActiveEventSubscription("env-1")).toBe(false);

    const replacement = store.getOrCreateEventSubscription("env-1");
    expect(replacement).not.toBe(subscription);

    store.setEventStream("env-1", stream);
    store.closeEventSubscription("env-1");

    expect(store.hasActiveEventSubscription("env-1")).toBe(false);
    expect(closed).toBe(true);
  });

  test("clearQueue empties only the targeted session queue", () => {
    const store = useOpenCodeStore.getState();
    const queueA = "env-env-1:tab-1";
    const queueB = "env-env-1:tab-2";

    store.addToQueue(queueA, { id: "a", text: "First", attachments: [], mode: "build" });
    store.addToQueue(queueB, { id: "b", text: "Second", attachments: [], mode: "build" });

    store.clearQueue(queueA);

    expect(store.getQueueLength(queueA)).toBe(0);
    expect(store.getQueueLength(queueB)).toBe(1);
  });

  test("clearEnvironment removes legacy mode keys and tolerates stream close failures", async () => {
    const store = useOpenCodeStore.getState();
    const sessionKeyA = "env-env-1:tab-1";
    const sessionKeyB = "env-env-2:tab-1";
    const returnSpy = mock(async () => {
      throw new Error("stream close failed");
    });

    const stream: AsyncIterable<any> = {
      [Symbol.asyncIterator](): AsyncIterableIterator<any> {
        return {
          async next(): Promise<IteratorResult<any>> {
            return { done: true as const, value: undefined };
          },
          return: returnSpy,
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };

    store.setSession(sessionKeyA, {
      sessionId: "session-a",
      messages: [],
      isLoading: false,
    });
    store.setSession(sessionKeyB, {
      sessionId: "session-b",
      messages: [],
      isLoading: false,
    });
    store.addPendingQuestion({ id: "question-a", sessionId: "session-a" } as any);
    store.addPendingQuestion({ id: "question-b", sessionId: "session-b" } as any);
    store.addPendingPermission({ id: "permission-a", sessionId: "session-a" } as any);
    store.addPendingPermission({ id: "permission-b", sessionId: "session-b" } as any);
    store.setSelectedMode(sessionKeyA, "plan");
    store.setSelectedMode(sessionKeyB, "build");
    useOpenCodeStore.setState((state) => {
      const selectedMode = new Map(state.selectedMode);
      selectedMode.set("env-1", "plan");
      return { selectedMode };
    });

    store.getOrCreateEventSubscription("env-1");
    store.setEventStream("env-1", stream);

    store.clearEnvironment("env-1");
    await Promise.resolve();

    expect(useOpenCodeStore.getState().selectedMode.get("env-1")).toBeUndefined();
    expect(useOpenCodeStore.getState().selectedMode.get(sessionKeyA)).toBeUndefined();
    expect(useOpenCodeStore.getState().selectedMode.get(sessionKeyB)).toBe("build");
    expect(store.getPendingQuestion("question-a")).toBeUndefined();
    expect(store.getPendingQuestion("question-b")?.id).toBe("question-b");
    expect(store.getPendingPermission("permission-a")).toBeUndefined();
    expect(store.getPendingPermission("permission-b")?.id).toBe("permission-b");
    expect(store.hasActiveEventSubscription("env-1")).toBe(false);
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("openCodeStore runtime health and agents", () => {
  beforeEach(resetOpenCodeStore);

  const HEALTH: OpenCodeRuntimeHealth = {
    agents: [
      { name: "build", description: "Default", mode: "primary", native: true },
      { name: "plan", mode: "primary" },
    ],
    skills: [{ name: "review", location: "/skills/review" }],
    mcpServers: [{ name: "docs", status: "connected" }],
    lspServers: [{ id: "ts", name: "typescript", root: "/repo", status: "ready" }],
    formatters: [{ name: "prettier", enabled: true, extensions: [".ts"] }],
    todos: [{ content: "ship", status: "pending", priority: "high" }],
    diffs: [{ file: "a.ts", additions: 3, deletions: 1, status: "modified" }],
    fetchedAt: "2026-07-26T00:00:00.000Z",
  };

  test("stores and reads a snapshot per environment", () => {
    const store = useOpenCodeStore.getState();

    store.setRuntimeHealth("env-1", HEALTH);

    expect(store.getRuntimeHealth("env-1")).toEqual(HEALTH);
    expect(store.getRuntimeHealth("env-2")).toBeUndefined();
  });

  test("clears the snapshot when passed null", () => {
    const store = useOpenCodeStore.getState();
    store.setRuntimeHealth("env-1", HEALTH);

    store.setRuntimeHealth("env-1", null);

    expect(store.getRuntimeHealth("env-1")).toBeUndefined();
    expect(useOpenCodeStore.getState().runtimeHealth.has("env-1")).toBe(false);
  });

  test("getAgents reads the agents out of the health snapshot", () => {
    const store = useOpenCodeStore.getState();
    store.setRuntimeHealth("env-1", HEALTH);

    expect(store.getAgents("env-1").map((agent) => agent.name)).toEqual([
      "build",
      "plan",
    ]);
  });

  test("getAgents returns a stable reference when there is no snapshot", () => {
    // `useSyncExternalStore` compares the selector result by identity, so a
    // freshly allocated `[]` on every read is an infinite render loop for the
    // first component that selects this.
    const store = useOpenCodeStore.getState();

    expect(store.getAgents("env-1")).toBe(store.getAgents("env-1"));
    expect(store.getAgents("env-1")).toBe(store.getAgents("env-2"));
    expect(store.getAgents("env-1")).toEqual([]);

    // Still stable once an unrelated environment has a snapshot.
    store.setRuntimeHealth("env-2", HEALTH);
    expect(store.getAgents("env-1")).toBe(store.getAgents("env-1"));
  });

  test("getAgents returns the snapshot's own array without copying it", () => {
    const store = useOpenCodeStore.getState();
    store.setRuntimeHealth("env-1", HEALTH);

    expect(store.getAgents("env-1")).toBe(store.getAgents("env-1"));
    expect(store.getAgents("env-1")).toBe(HEALTH.agents);
  });

  test("clearEnvironment drops the snapshot for that environment only", () => {
    const store = useOpenCodeStore.getState();
    store.setRuntimeHealth("env-1", HEALTH);
    store.setRuntimeHealth("env-env-1:tab-1", {
      ...HEALTH,
      diffs: [{
        file: "private.patch",
        patch: "sensitive retained patch",
        additions: 1,
        deletions: 0,
        status: "modified",
      }],
    });
    store.setRuntimeHealth("env-2", HEALTH);
    store.setRuntimeHealth("env-env-2:tab-1", HEALTH);

    store.clearEnvironment("env-1");

    const state = useOpenCodeStore.getState();
    expect(state.getRuntimeHealth("env-1")).toBeUndefined();
    expect(state.getRuntimeHealth("env-env-1:tab-1")).toBeUndefined();
    expect(state.getRuntimeHealth("env-2")).toEqual(HEALTH);
    expect(state.getRuntimeHealth("env-env-2:tab-1")).toEqual(HEALTH);
    expect(state.getAgents("env-1")).toEqual([]);
  });
});

describe("openCodeStore selected agent", () => {
  beforeEach(resetOpenCodeStore);

  const SESSION_KEY = "env-env-1:tab-1";
  const OTHER_TAB_KEY = "env-env-1:tab-2";

  test("stores and reads an agent per session", () => {
    const store = useOpenCodeStore.getState();

    store.setSelectedAgent(SESSION_KEY, "reviewer");

    expect(store.getSelectedAgent(SESSION_KEY)).toBe("reviewer");
    expect(store.getSelectedAgent(OTHER_TAB_KEY)).toBeUndefined();
  });

  test("clears the key rather than storing an empty selection", () => {
    // The absence of a key is what the prompt builder reads as "no agent", so
    // an empty string stored under the key would be sent as `agent: ""`.
    const store = useOpenCodeStore.getState();
    store.setSelectedAgent(SESSION_KEY, "reviewer");

    store.setSelectedAgent(SESSION_KEY, undefined);
    expect(store.getSelectedAgent(SESSION_KEY)).toBeUndefined();
    expect(useOpenCodeStore.getState().selectedAgent.has(SESSION_KEY)).toBe(false);

    store.setSelectedAgent(SESSION_KEY, "reviewer");
    store.setSelectedAgent(SESSION_KEY, "");
    expect(useOpenCodeStore.getState().selectedAgent.has(SESSION_KEY)).toBe(false);
  });

  test("clearEnvironment prunes by session key, not by environment id", () => {
    // `runtimeHealth` is keyed by environment id while `selectedAgent` is keyed
    // by `env-<id>:<tab>`, so the two need different pruning and both key
    // schemes have to be exercised.
    const store = useOpenCodeStore.getState();
    const otherEnvKey = "env-env-2:tab-1";
    store.setSelectedAgent(SESSION_KEY, "reviewer");
    store.setSelectedAgent(OTHER_TAB_KEY, "build");
    store.setSelectedAgent(otherEnvKey, "plan");
    store.setRuntimeHealth("env-1", {
      agents: [],
      skills: [],
      mcpServers: [],
      lspServers: [],
      formatters: [],
      fetchedAt: "2026-07-26T00:00:00.000Z",
    });

    store.clearEnvironment("env-1");

    const state = useOpenCodeStore.getState();
    // Both tabs of env-1 go, including the one that was never the active tab.
    expect(state.getSelectedAgent(SESSION_KEY)).toBeUndefined();
    expect(state.getSelectedAgent(OTHER_TAB_KEY)).toBeUndefined();
    expect(state.getSelectedAgent(otherEnvKey)).toBe("plan");
    expect(state.getRuntimeHealth("env-1")).toBeUndefined();
  });
});
