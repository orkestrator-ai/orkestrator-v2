import { createSessionKey } from "@/lib/utils";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { useClaudeStore } from "./claudeStore";

const SESSION_KEY = createSessionKey("env-1", "tab-1");

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
    modelCatalogs: new Map(),
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
    const sessionKeyA = createSessionKey("env-1", "tab-1");
    const sessionKeyB = createSessionKey("env-2", "tab-1");
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
    store.setModelCatalog({
      environmentId: "env-1",
      models: [{ id: "opus", name: "Opus 5" }],
      source: "sdk",
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
    });
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
    expect(store.getModelCatalog("env-1")).toBeUndefined();
    expect(store.getQueueLength(sessionKeyA)).toBe(0);
    expect(store.getPendingQuestion("question-a")).toBeUndefined();
    expect(store.getPendingQuestion("question-b")).toBeDefined();
    expect(store.getPendingPlanApproval("approval-a")).toBeUndefined();
    expect(store.getPendingPlanApproval("approval-b")).toBeDefined();
  });

  test("keeps authoritative model catalogs scoped to their environment", () => {
    const store = useClaudeStore.getState();
    store.setModels([{ id: "legacy", name: "Legacy" }]);
    store.setModelCatalog({
      environmentId: "env-1",
      models: [{ id: "opus", name: "Opus 5" }],
      source: "sdk",
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
    });

    expect(store.getModels("env-1").map((model) => model.id)).toEqual(["opus"]);
    expect(store.getModels("env-2").map((model) => model.id)).toEqual(["legacy"]);
    expect(useClaudeStore.getState().models.map((model) => model.id)).toEqual([
      "legacy",
    ]);
  });

  test("queues prompts in FIFO order and clears only the targeted session queue", () => {
    const queueA = createSessionKey("env-1", "tab-1");
    const queueB = createSessionKey("env-1", "tab-2");
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

describe("claudeStore message patching", () => {
  type Patch = Parameters<ReturnType<typeof useClaudeStore.getState>["patchMessage"]>[1];

  const patch = (overrides: Partial<Patch> = {}): Patch => ({
    messageId: "assistant-1",
    partCount: 1,
    changedParts: [{ index: 0, part: { type: "text" as const, content: "streamed" } }],
    timestamp: "2026-07-20T12:00:01.000Z",
    revision: 2,
    ...overrides,
  });

  beforeEach(() => {
    resetClaudeStore();
    useClaudeStore.getState().setSession(SESSION_KEY, {
      sessionId: "session-1",
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          parts: [{ type: "text", content: "" }],
          timestamp: "2026-07-20T12:00:00.000Z",
          revision: 1,
        },
      ],
      isLoading: true,
    });
  });

  test("applies a patch to the matching message and reports success", () => {
    expect(useClaudeStore.getState().patchMessage(SESSION_KEY, patch())).toBe(true);

    const messages = useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages;
    expect(messages?.[0]).toMatchObject({
      id: "assistant-1",
      content: "streamed",
      parts: [{ type: "text", content: "streamed" }],
      // Stored so the following patch has a base to be checked against.
      revision: 2,
    });
  });

  test("applies a run of consecutive revisions", () => {
    const store = () => useClaudeStore.getState();
    expect(store().patchMessage(SESSION_KEY, patch({ revision: 2 }))).toBe(true);
    expect(
      store().patchMessage(
        SESSION_KEY,
        patch({
          revision: 3,
          changedParts: [{ index: 0, part: { type: "text", content: "streamed more" } }],
        }),
      ),
    ).toBe(true);

    expect(store().sessions.get(SESSION_KEY)?.messages[0]).toMatchObject({
      content: "streamed more",
      revision: 3,
    });
  });

  test("reports failure without touching state when frames were missed", () => {
    const before = useClaudeStore.getState().sessions.get(SESSION_KEY);

    // The reconnect case: the store holds revision 1 but the bridge has moved
    // past it. Applying by index would drop whatever changed in between, and
    // the bridge never re-sends it — so this must fail and force a refetch.
    expect(useClaudeStore.getState().patchMessage(SESSION_KEY, patch({ revision: 5 }))).toBe(
      false,
    );
    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)).toBe(before);
  });

  test("reports failure without touching state for a malformed payload", () => {
    const before = useClaudeStore.getState().sessions.get(SESSION_KEY);

    // A throw here would escape the SSE loop and tear down the environment's
    // shared subscription; a clean false is a refetch instead.
    expect(
      useClaudeStore
        .getState()
        .patchMessage(SESSION_KEY, patch({ changedParts: undefined as unknown as [] })),
    ).toBe(false);
    expect(
      useClaudeStore
        .getState()
        .patchMessage(SESSION_KEY, patch({ partCount: -1 })),
    ).toBe(false);
    expect(
      useClaudeStore
        .getState()
        .patchMessage(SESSION_KEY, undefined as unknown as Patch),
    ).toBe(false);
    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)).toBe(before);
  });

  test("reports failure without touching state when the message is unknown", () => {
    const before = useClaudeStore.getState().sessions.get(SESSION_KEY);

    // This is the signal the tab uses to fall back to an authoritative
    // refetch — a tab that mounted mid-turn has no message to patch, and
    // silently succeeding here would strand it on an empty transcript.
    expect(
      useClaudeStore.getState().patchMessage(SESSION_KEY, patch({ messageId: "never-seen" })),
    ).toBe(false);
    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)).toBe(before);
  });

  test("reports failure for a session that does not exist", () => {
    expect(
      useClaudeStore
        .getState()
        .patchMessage(createSessionKey("env-1", "other-tab"), patch()),
    ).toBe(false);
  });

  test("leaves other messages in the session alone", () => {
    const store = useClaudeStore.getState();
    store.addMessage(SESSION_KEY, {
      id: "assistant-2",
      role: "assistant",
      content: "second",
      parts: [{ type: "text", content: "second" }],
      timestamp: "2026-07-20T12:00:02.000Z",
    });
    const untouched = useClaudeStore.getState().sessions.get(SESSION_KEY)!.messages[1];

    useClaudeStore.getState().patchMessage(SESSION_KEY, patch());

    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)!.messages[1]).toBe(untouched);
  });

  test("recovers after a refetch rolls the message back", () => {
    const store = () => useClaudeStore.getState();
    expect(store().patchMessage(SESSION_KEY, patch({ revision: 2 }))).toBe(true);

    // An in-flight `getSessionMessages` resolves with a snapshot taken before
    // that patch and replaces the transcript wholesale. Nothing is corrupted,
    // because the next patch no longer lines up and the tab refetches again.
    store().setMessages(SESSION_KEY, [
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        parts: [{ type: "text", content: "" }],
        timestamp: "2026-07-20T12:00:00.000Z",
        revision: 1,
      },
    ]);

    expect(store().patchMessage(SESSION_KEY, patch({ revision: 3 }))).toBe(false);
    // And a transcript that caught up re-establishes a base patches build on.
    store().setMessages(SESSION_KEY, [
      {
        id: "assistant-1",
        role: "assistant",
        content: "caught up",
        parts: [{ type: "text", content: "caught up" }],
        timestamp: "2026-07-20T12:00:00.000Z",
        revision: 3,
      },
    ]);
    expect(store().patchMessage(SESSION_KEY, patch({ revision: 4 }))).toBe(true);
  });
});
