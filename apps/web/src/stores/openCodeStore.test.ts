import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ERROR_MESSAGE_PREFIX, type OpenCodeMessage, type PermissionRequest } from "../lib/opencode-client";
import { OPTIMISTIC_MESSAGE_PREFIX } from "../lib/chat/client-only-messages";
import { type OpenCodeAttachment, useOpenCodeStore } from "./openCodeStore";
import type { ContextUsageSnapshot } from "../lib/context-usage";

function resetOpenCodeStore() {
  useOpenCodeStore.setState({
    serverStatus: new Map(),
    sessions: new Map(),
    clients: new Map(),
    models: new Map(),
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
      sessionID: "session-1",
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
      sessionID: "session-1",
      permission: "read",
      patterns: ["/workspace/a/**"],
      metadata: {},
      always: ["/workspace/a/**"],
    });
    store.addPendingPermission({
      id: "perm-b",
      sessionID: "session-2",
      permission: "bash",
      patterns: ["*"],
      metadata: {},
      always: [],
    });
    store.addPendingPermission({
      id: "perm-c",
      sessionID: "session-3",
      permission: "read",
      patterns: ["/workspace/c/**"],
      metadata: {},
      always: ["/workspace/c/**"],
    });

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getPendingPermission("perm-a")).toBeUndefined();
    expect(useOpenCodeStore.getState().getPendingPermission("perm-b")).toBeUndefined();
    expect(useOpenCodeStore.getState().getPendingPermission("perm-c")).toBeDefined();
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
    const usage: ContextUsageSnapshot = {
      usedTokens: 1200,
      totalTokens: 8000,
      percentUsed: 15,
      modelId: "openai/gpt-5",
    };

    store.setContextUsage(sessionKey, usage);
    expect(store.getContextUsage(sessionKey)).toEqual(usage);

    store.setContextUsage(sessionKey, null);
    expect(store.getContextUsage(sessionKey)).toBeUndefined();
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
      sessionID: "session-1",
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
    store.addPendingQuestion({ id: "question-a", sessionID: "session-a" } as any);
    store.addPendingQuestion({ id: "question-b", sessionID: "session-b" } as any);
    store.addPendingPermission({ id: "permission-a", sessionID: "session-a" } as any);
    store.addPendingPermission({ id: "permission-b", sessionID: "session-b" } as any);
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
