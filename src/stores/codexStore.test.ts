import { beforeEach, describe, expect, test } from "bun:test";
import { createOptimisticNativeMessage } from "@/lib/chat/client-only-messages";
import {
  createCodexSessionKey,
  useCodexStore,
} from "./codexStore";

const SESSION_KEY = createCodexSessionKey("env-1", "tab-1");

function resetCodexStore() {
  useCodexStore.setState({
    models: [],
    serverStatus: new Map(),
    clients: new Map(),
    sessions: new Map(),
    slashCommands: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    selectedModel: new Map(),
    selectedMode: new Map(),
    selectedReasoningEffort: new Map(),
  });
}

describe("codexStore message helpers", () => {
  beforeEach(() => {
    resetCodexStore();
    useCodexStore.getState().setSession(SESSION_KEY, {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    });
  });

  test("addMessage and removeMessage update the target session only", () => {
    const store = useCodexStore.getState();
    const optimistic = createOptimisticNativeMessage("optimistic-1", "Review this");

    store.addMessage(SESSION_KEY, optimistic);
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toHaveLength(1);

    store.removeMessage(SESSION_KEY, optimistic.id);
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toHaveLength(0);
  });

  test("setMessages preserves optimistic prompts until Codex echoes the matching attachment", () => {
    const store = useCodexStore.getState();
    const optimistic = createOptimisticNativeMessage("optimistic-2", "Check the screenshot", [
      { path: "/workspace/a.png", name: "a.png" },
    ]);

    store.addMessage(SESSION_KEY, optimistic);

    store.setMessages(SESSION_KEY, [
      {
        id: "server-1",
        role: "user",
        content: "Check the screenshot",
        parts: [
          { type: "text", content: "Check the screenshot" },
          { type: "file", content: "b.png", fileUrl: "file:///workspace/b.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ]);

    const messages = useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message.id === optimistic.id)).toBe(true);
  });

  test("setMessages drops optimistic prompts once Codex echoes the matching attachment", () => {
    const store = useCodexStore.getState();
    const optimistic = createOptimisticNativeMessage("optimistic-3", "Check the screenshot", [
      { path: "/workspace/a.png", name: "a.png" },
    ]);

    store.addMessage(SESSION_KEY, optimistic);

    store.setMessages(SESSION_KEY, [
      {
        id: "server-2",
        role: "user",
        content: "Check the screenshot",
        parts: [
          { type: "text", content: "Check the screenshot" },
          { type: "file", content: "a.png", fileUrl: "file:///workspace/a.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ]);

    const messages = useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("server-2");
  });

  test("preserves timer metadata across loading transitions", () => {
    const originalNow = Date.now;
    Date.now = () => 1000;

    try {
      const store = useCodexStore.getState();
      store.setSessionLoading(SESSION_KEY, true);

      let session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.isLoading).toBe(true);
      expect(session?.loadingStartedAt).toBe(1000);
      expect(session?.lastCompletedElapsedSeconds).toBeNull();

      Date.now = () => 6500;
      store.setSessionLoading(SESSION_KEY, false);

      session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.isLoading).toBe(false);
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
      const store = useCodexStore.getState();
      store.setSessionLoading(SESSION_KEY, true);

      Date.now = () => 6500;
      store.setSession(SESSION_KEY, {
        sessionId: "session-1",
        messages: [],
        isLoading: false,
      });

      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
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
      const store = useCodexStore.getState();
      store.setSessionLoading(SESSION_KEY, true);

      Date.now = () => 8000;
      store.setSession(SESSION_KEY, {
        sessionId: "session-2",
        messages: [],
        isLoading: true,
      });

      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.sessionId).toBe("session-2");
      expect(session?.loadingStartedAt).toBe(8000);
      expect(session?.lastCompletedElapsedSeconds).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("codexStore cleanup and queue helpers", () => {
  beforeEach(() => {
    resetCodexStore();
  });

  test("clearEnvironment removes only the targeted environment's tab-scoped state", () => {
    const sessionKeyA = createCodexSessionKey("env-1", "tab-1");
    const sessionKeyB = createCodexSessionKey("env-2", "tab-1");
    const store = useCodexStore.getState();

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
    store.setSelectedModel(sessionKeyA, "gpt-5");
    store.setSelectedModel(sessionKeyB, "gpt-4");
    store.setSelectedMode(sessionKeyA, "plan");
    store.setSelectedReasoningEffort(sessionKeyA, "high");
    store.setDraftText(sessionKeyA, "draft");
    store.addAttachment(sessionKeyA, {
      id: "att-a",
      type: "image",
      path: "/workspace/a.png",
      name: "a.png",
    });
    store.addToQueue(sessionKeyA, {
      id: "queue-a",
      text: "queued",
      attachments: [],
      model: "gpt-5",
      mode: "build",
      reasoningEffort: "medium",
    });
    store.setSlashCommands("env-1", [{ name: "/fix", source: "prompt" }]);
    store.setSlashCommands("env-2", [{ name: "/keep", source: "builtin" }]);

    store.clearEnvironment("env-1");

    expect(store.getSession(sessionKeyA)).toBeUndefined();
    expect(store.getSession(sessionKeyB)?.sessionId).toBe("session-b");
    expect(store.getDraftText(sessionKeyA)).toBe("");
    expect(store.getAttachments(sessionKeyA)).toEqual([]);
    expect(store.getQueueLength(sessionKeyA)).toBe(0);
    expect(useCodexStore.getState().selectedModel.get(sessionKeyA)).toBeUndefined();
    expect(useCodexStore.getState().selectedModel.get(sessionKeyB)).toBe("gpt-4");
    expect(useCodexStore.getState().slashCommands.get("env-1")).toBeUndefined();
    expect(useCodexStore.getState().slashCommands.get("env-2")).toEqual([
      { name: "/keep", source: "builtin" },
    ]);
  });

  test("queue helpers remove items in FIFO order and preserve unrelated queues", () => {
    const queueA = createCodexSessionKey("env-1", "tab-1");
    const queueB = createCodexSessionKey("env-1", "tab-2");
    const store = useCodexStore.getState();

    store.addToQueue(queueA, {
      id: "q-1",
      text: "first",
      attachments: [],
      model: "gpt-5",
      mode: "build",
      reasoningEffort: "medium",
    });
    store.addToQueue(queueA, {
      id: "q-2",
      text: "second",
      attachments: [],
      model: "gpt-5",
      mode: "plan",
      reasoningEffort: "high",
    });
    store.addToQueue(queueB, {
      id: "q-3",
      text: "other-tab",
      attachments: [],
      model: "gpt-4",
      mode: "build",
      reasoningEffort: "low",
    });

    expect(store.removeFromQueue(queueA)?.id).toBe("q-1");
    expect(store.getQueuedMessages(queueA).map((item) => item.id)).toEqual([
      "q-2",
    ]);

    store.clearQueue(queueA);

    expect(store.getQueueLength(queueA)).toBe(0);
    expect(store.getQueueLength(queueB)).toBe(1);
  });
});
