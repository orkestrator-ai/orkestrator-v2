import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createClaudeSessionKey, useClaudeStore } from "./claudeStore";

const SESSION_KEY = createClaudeSessionKey("env-1", "tab-1");

function resetClaudeStore() {
  useClaudeStore.setState({
    serverStatus: new Map(),
    clients: new Map(),
    eventSubscriptions: new Map(),
    sessions: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    isComposing: new Map(),
    effort: new Map(),
    planMode: new Map(),
    selectedModel: new Map(),
    messageQueue: new Map(),
    sessionInitData: new Map(),
    contextUsage: new Map(),
    pendingQuestions: new Map(),
    pendingPlanApprovals: new Map(),
    models: [],
  });
}

describe("claudeStore timer metadata", () => {
  beforeEach(() => {
    resetClaudeStore();
    useClaudeStore.getState().setSession(SESSION_KEY, {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    });
  });

  test("preserves timer metadata across loading transitions", () => {
    const originalNow = Date.now;
    Date.now = () => 1000;

    try {
      const store = useClaudeStore.getState();
      store.setSessionLoading(SESSION_KEY, true);

      let session = store.getSession(SESSION_KEY);
      expect(session?.loadingStartedAt).toBe(1000);
      expect(session?.lastCompletedElapsedSeconds).toBeNull();

      Date.now = () => 6500;
      store.setSessionLoading(SESSION_KEY, false);

      session = store.getSession(SESSION_KEY);
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
      const store = useClaudeStore.getState();
      store.setSessionLoading(SESSION_KEY, true);

      Date.now = () => 6500;
      store.setSession(SESSION_KEY, {
        sessionId: "session-1",
        messages: [],
        isLoading: false,
      });

      const session = store.getSession(SESSION_KEY);
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
      const store = useClaudeStore.getState();
      store.setSessionLoading(SESSION_KEY, true);

      Date.now = () => 8000;
      store.setSession(SESSION_KEY, {
        sessionId: "session-2",
        messages: [],
        isLoading: true,
      });

      const session = store.getSession(SESSION_KEY);
      expect(session?.sessionId).toBe("session-2");
      expect(session?.loadingStartedAt).toBe(8000);
      expect(session?.lastCompletedElapsedSeconds).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("claudeStore cleanup and queue helpers", () => {
  beforeEach(() => {
    resetClaudeStore();
  });

  test("clearEnvironment removes session-scoped state and pending requests for the target environment only", () => {
    const sessionKeyA = createClaudeSessionKey("env-1", "tab-1");
    const sessionKeyB = createClaudeSessionKey("env-2", "tab-1");
    const store = useClaudeStore.getState();

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
    store.setSelectedModel(sessionKeyA, "sonnet");
    store.setSelectedModel(sessionKeyB, "opus");
    store.setEffort(sessionKeyA, "max");
    store.setPlanMode(sessionKeyA, true);
    store.setComposing(sessionKeyA, true);
    store.setContextUsage(sessionKeyA, {
      usedTokens: 10,
      totalTokens: 100,
      percentUsed: 10,
    });
    store.setSessionInitData("env-1", { cwd: "/workspace" } as any);
    store.addToQueue(sessionKeyA, {
      id: "queue-a",
      text: "queued",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });
    store.addPendingQuestion({ id: "question-a", sessionId: "session-a" } as any);
    store.addPendingQuestion({ id: "question-b", sessionId: "session-b" } as any);
    store.addPendingPlanApproval({
      id: "approval-a",
      sessionId: "session-a",
    } as any);
    store.addPendingPlanApproval({
      id: "approval-b",
      sessionId: "session-b",
    } as any);

    store.clearEnvironment("env-1");

    expect(store.getSession(sessionKeyA)).toBeUndefined();
    expect(store.getSession(sessionKeyB)?.sessionId).toBe("session-b");
    expect(store.getSelectedModel(sessionKeyA)).toBeUndefined();
    expect(store.getSelectedModel(sessionKeyB)).toBe("opus");
    expect(store.isComposingFor(sessionKeyA)).toBe(false);
    expect(store.getContextUsage(sessionKeyA)).toBeUndefined();
    expect(store.getSessionInitData("env-1")).toBeUndefined();
    expect(store.getQueueLength(sessionKeyA)).toBe(0);
    expect(store.getPendingQuestion("question-a")).toBeUndefined();
    expect(store.getPendingQuestion("question-b")).toBeDefined();
    expect(store.getPendingPlanApproval("approval-a")).toBeUndefined();
    expect(store.getPendingPlanApproval("approval-b")).toBeDefined();
  });

  test("queues prompts in FIFO order and clears only the targeted session queue", () => {
    const queueA = createClaudeSessionKey("env-1", "tab-1");
    const queueB = createClaudeSessionKey("env-1", "tab-2");
    const store = useClaudeStore.getState();

    store.addToQueue(queueA, {
      id: "q-1",
      text: "first",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });
    store.addToQueue(queueA, {
      id: "q-2",
      text: "second",
      attachments: [],
      effort: "medium",
      planModeEnabled: true,
      fastModeEnabled: false,
    });
    store.addToQueue(queueB, {
      id: "q-3",
      text: "other-tab",
      attachments: [],
      effort: "low",
      planModeEnabled: false,
      fastModeEnabled: false,
    });

    expect(store.getQueuedMessages(queueA).map((item) => item.id)).toEqual([
      "q-1",
      "q-2",
    ]);
    expect(store.removeFromQueue(queueA)?.id).toBe("q-1");
    expect(store.getQueuedMessages(queueA).map((item) => item.id)).toEqual([
      "q-2",
    ]);

    store.clearQueue(queueA);

    expect(store.getQueueLength(queueA)).toBe(0);
    expect(store.getQueueLength(queueB)).toBe(1);
  });

  test("creates, updates, and closes event subscriptions", () => {
    const store = useClaudeStore.getState();
    const returnSpy = mock(async () => ({ done: true, value: undefined }));
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
        return: returnSpy,
      }),
    } as any;

    const subscription = store.getOrCreateEventSubscription("env-1");
    expect(subscription).not.toBeNull();
    expect(store.getOrCreateEventSubscription("env-1")).toBe(subscription);

    store.setEventStream("env-1", stream);
    expect(store.hasActiveEventSubscription("env-1")).toBe(true);

    store.closeEventSubscription("env-1");

    expect(returnSpy).toHaveBeenCalledTimes(1);
    expect(store.hasActiveEventSubscription("env-1")).toBe(false);
  });
});
