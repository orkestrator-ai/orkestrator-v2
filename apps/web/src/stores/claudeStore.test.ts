import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  type ClaudeMessage,
} from "@/lib/claude-client";
import { createSessionKey } from "@/lib/utils";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { useClaudeStore } from "./claudeStore";
import {
  claudePlanApprovalDraftKey,
  claudeQuestionDraftKey,
  usePromptDraftStore,
} from "./promptDraftStore";
import { seedQueuedPrompt } from "@/stores/testing/queue-projection";

const SESSION_KEY = createSessionKey("env-1", "tab-1");

function resetClaudeStore() {
  usePromptDraftStore.getState().reset();
  useClaudeStore.setState({
    serverStatus: new Map(),
    clients: new Map(),
    eventSubscriptions: new Map(),
    sessions: new Map(),
    sessionLoadingRevisions: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    isComposing: new Map(),
    effort: new Map(),
    planMode: new Map(),
    fastMode: new Map(),
    selectedModel: new Map(),
    messageQueue: new Map(),
    sessionInitData: new Map(),
    contextUsage: new Map(),
    rateLimits: new Map(),
    pendingQuestions: new Map(),
    pendingPlanApprovals: new Map(),
    models: [],
    modelCatalogs: new Map(),
    // Every map the store owns has to be reset here. A map left out is a map
    // that carries state between test files, which makes the first test anyone
    // writes for that action order-dependent.
    selectedAgent: new Map(),
    includeLocalSettings: new Map(),
    promptSuggestionOptIn: new Map(),
    promptSuggestions: new Map(),
    dismissedPromptSuggestions: new Map(),
    backgroundTasks: new Map(),
    backgroundTaskRevisions: new Map(),
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
    seedQueuedPrompt(store, sessionKeyA, {
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
    usePromptDraftStore.getState().setDraftValue(
      claudeQuestionDraftKey("question-a"),
      "answer",
      "target",
    );
    usePromptDraftStore.getState().setDraftValue(
      claudePlanApprovalDraftKey("approval-a"),
      "feedback",
      "target",
    );
    usePromptDraftStore.getState().setDraftValue(
      claudeQuestionDraftKey("question-b"),
      "answer",
      "other",
    );

    store.clearEnvironment("env-1");

    expect(store.getSession(sessionKeyA)).toBeUndefined();
    expect(store.getSession(sessionKeyB)?.sessionId).toBe("session-b");
    expect(
      useClaudeStore.getState().sessionLoadingRevisions.has(sessionKeyA),
    ).toBe(false);
    expect(
      useClaudeStore.getState().sessionLoadingRevisions.has(sessionKeyB),
    ).toBe(true);
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
    expect(
      usePromptDraftStore.getState().drafts.has(
        claudeQuestionDraftKey("question-a"),
      ),
    ).toBe(false);
    expect(
      usePromptDraftStore.getState().drafts.has(
        claudePlanApprovalDraftKey("approval-a"),
      ),
    ).toBe(false);
    expect(
      usePromptDraftStore.getState().drafts.has(
        claudeQuestionDraftKey("question-b"),
      ),
    ).toBe(true);
  });

  test("replaceSessionIdentity swaps the provider identity and clears only old provider metadata", () => {
    const store = useClaudeStore.getState();
    store.setSession(SESSION_KEY, {
      sessionId: "session-old",
      messages: [],
      isLoading: true,
    });
    store.setSelectedModel(SESSION_KEY, "claude-sonnet");
    store.setContextUsage(SESSION_KEY, {
      usedTokens: 10,
      totalTokens: 100,
      percentUsed: 10,
    });
    store.setRateLimits(SESSION_KEY, [{ label: "5h", usedPercent: 90 }]);
    store.setPromptSuggestion(SESSION_KEY, "Old suggestion");
    store.setDismissedPromptSuggestion(SESSION_KEY, "Old dismissal");
    store.setBackgroundTasks(SESSION_KEY, {
      old: { id: "old", status: "running" },
    });
    store.addPendingQuestion({
      id: "old-question",
      sessionId: "session-old",
      questions: [],
    });
    store.addPendingPlanApproval({
      id: "old-approval",
      sessionId: "session-old",
    });

    store.replaceSessionIdentity(SESSION_KEY, {
      sessionId: "session-new",
      messages: [],
      isLoading: false,
    });

    const state = useClaudeStore.getState();
    expect(state.sessions.get(SESSION_KEY)).toEqual({
      sessionId: "session-new",
      messages: [],
      isLoading: false,
    });
    expect(state.contextUsage.has(SESSION_KEY)).toBe(false);
    expect(state.rateLimits.has(SESSION_KEY)).toBe(false);
    expect(state.promptSuggestions.has(SESSION_KEY)).toBe(false);
    expect(state.dismissedPromptSuggestions.has(SESSION_KEY)).toBe(false);
    expect(state.backgroundTasks.has(SESSION_KEY)).toBe(false);
    expect(state.backgroundTaskRevisions.has(SESSION_KEY)).toBe(false);
    expect(state.pendingQuestions.has("old-question")).toBe(false);
    expect(state.pendingPlanApprovals.has("old-approval")).toBe(false);
    expect(state.selectedModel.get(SESSION_KEY)).toBe("claude-sonnet");
  });

  test("clearSession exhaustively removes every session-keyed map and only its pending requests", () => {
    const targetKey = createSessionKey("env-1", "tab-target");
    const otherKey = createSessionKey("env-1", "tab-other");
    const targetSession = {
      sessionId: "sdk-target",
      messages: [],
      isLoading: false,
    };
    const otherSession = {
      sessionId: "sdk-other",
      messages: [],
      isLoading: false,
    };

    useClaudeStore.setState({
      sessions: new Map([
        [targetKey, targetSession],
        [otherKey, otherSession],
      ]),
      sessionLoadingRevisions: new Map([
        [targetKey, 3],
        [otherKey, 7],
      ]),
      attachments: new Map([[targetKey, []], [otherKey, []]]),
      draftText: new Map([[targetKey, "target"], [otherKey, "other"]]),
      draftMentions: new Map([[targetKey, []], [otherKey, []]]),
      messageQueue: new Map([[targetKey, []], [otherKey, []]]),
      selectedModel: new Map([[targetKey, "sonnet"], [otherKey, "opus"]]),
      isComposing: new Map([[targetKey, true], [otherKey, true]]),
      effort: new Map([[targetKey, "high"], [otherKey, "max"]]),
      planMode: new Map([[targetKey, true], [otherKey, true]]),
      fastMode: new Map([[targetKey, true], [otherKey, true]]),
      contextUsage: new Map([
        [targetKey, { usedTokens: 1, totalTokens: 10, percentUsed: 10 }],
        [otherKey, { usedTokens: 2, totalTokens: 10, percentUsed: 20 }],
      ]),
      rateLimits: new Map([
        [targetKey, [{ label: "5h", usedPercent: 10 }]],
        [otherKey, [{ label: "Weekly", usedPercent: 20 }]],
      ]),
      backgroundTaskRevisions: new Map([
        [targetKey, 3],
        [otherKey, 7],
      ]),
      pendingQuestions: new Map([
        ["question-target", { id: "question-target", sessionId: "sdk-target", questions: [] }],
        ["question-other", { id: "question-other", sessionId: "sdk-other", questions: [] }],
      ]),
      pendingPlanApprovals: new Map([
        ["approval-target", { id: "approval-target", sessionId: "sdk-target" }],
        ["approval-other", { id: "approval-other", sessionId: "sdk-other" }],
      ]),
    });
    usePromptDraftStore.getState().setDraftValue(
      claudeQuestionDraftKey("question-target"),
      "answer",
      "target",
    );
    usePromptDraftStore.getState().setDraftValue(
      claudePlanApprovalDraftKey("approval-target"),
      "feedback",
      "target",
    );
    usePromptDraftStore.getState().setDraftValue(
      claudeQuestionDraftKey("question-other"),
      "answer",
      "other",
    );

    useClaudeStore.getState().clearSession(targetKey);

    const state = useClaudeStore.getState();
    const sessionKeyedMaps = [
      "sessions",
      "sessionLoadingRevisions",
      "attachments",
      "draftText",
      "draftMentions",
      "messageQueue",
      "selectedModel",
      "isComposing",
      "effort",
      "planMode",
      "fastMode",
      "contextUsage",
      "rateLimits",
      "backgroundTaskRevisions",
    ] as const;
    for (const field of sessionKeyedMaps) {
      expect(state[field].has(targetKey), `${field} should remove target`).toBe(false);
      expect(state[field].has(otherKey), `${field} should preserve other tab`).toBe(true);
    }
    expect(state.pendingQuestions.has("question-target")).toBe(false);
    expect(state.pendingQuestions.has("question-other")).toBe(true);
    expect(state.pendingPlanApprovals.has("approval-target")).toBe(false);
    expect(state.pendingPlanApprovals.has("approval-other")).toBe(true);
    expect(
      usePromptDraftStore.getState().drafts.has(
        claudeQuestionDraftKey("question-target"),
      ),
    ).toBe(false);
    expect(
      usePromptDraftStore.getState().drafts.has(
        claudePlanApprovalDraftKey("approval-target"),
      ),
    ).toBe(false);
    expect(
      usePromptDraftStore.getState().drafts.has(
        claudeQuestionDraftKey("question-other"),
      ),
    ).toBe(true);
  });

  test("clearSession leaves pending requests alone when the tab never got a session id", () => {
    const targetKey = createSessionKey("env-1", "tab-unstarted");

    useClaudeStore.setState({
      // A tab whose session was created optimistically: the SDK has not
      // returned a session id yet, so there is nothing to sweep pending
      // requests by and the store must not guess.
      sessions: new Map([
        [targetKey, { sessionId: "", messages: [], isLoading: false }],
      ]),
      draftText: new Map([[targetKey, "half-typed"]]),
      pendingQuestions: new Map([
        ["question-orphan", { id: "question-orphan", sessionId: "", questions: [] }],
      ]),
      pendingPlanApprovals: new Map([
        ["approval-orphan", { id: "approval-orphan", sessionId: "" }],
      ]),
    });

    useClaudeStore.getState().clearSession(targetKey);

    const state = useClaudeStore.getState();
    expect(state.sessions.has(targetKey)).toBe(false);
    expect(state.draftText.has(targetKey)).toBe(false);
    expect(state.pendingQuestions.has("question-orphan")).toBe(true);
    expect(state.pendingPlanApprovals.has("approval-orphan")).toBe(true);
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

  test("covers environment model updates, nullable init data, and pending selectors", () => {
    const store = useClaudeStore.getState();
    store.setModels([{ id: "env-model", name: "Environment model" }], "env-1");
    expect(store.getModelCatalog("env-1")).toMatchObject({
      environmentId: "env-1",
      source: "sdk",
      stale: false,
    });
    expect(store.getModels("env-1").map((model) => model.id)).toEqual(["env-model"]);

    store.setSessionInitData("env-1", {
      mcpServers: [],
      plugins: [],
      slashCommands: ["/review"],
    });
    expect(store.getSessionInitData("env-1")?.slashCommands).toEqual(["/review"]);
    store.setSessionInitData("env-1", null);
    expect(store.getSessionInitData("env-1")).toBeUndefined();

    store.setSession(SESSION_KEY, {
      sessionId: "sdk-session-1",
      messages: [],
      isLoading: false,
    });
    store.addPendingQuestion({
      id: "question-1",
      sessionId: "sdk-session-1",
      questions: [],
    });
    store.addPendingPlanApproval({
      id: "approval-1",
      sessionId: "sdk-session-1",
    });
    expect(store.getPendingQuestionsForSession("sdk-session-1")).toHaveLength(1);
    expect(store.getPendingPlanApprovalsForSession("sdk-session-1")).toHaveLength(1);
    expect(store.getSessionKeyBySdkSessionId("sdk-session-1")).toBe(SESSION_KEY);
    expect(store.getSessionKeyBySdkSessionId("missing-session")).toBeNull();

    store.removePendingQuestion("question-1");
    store.removePendingPlanApproval("approval-1");
    expect(store.getPendingQuestion("question-1")).toBeUndefined();
    expect(store.getPendingPlanApproval("approval-1")).toBeUndefined();
  });

  test("queues prompts in FIFO order and clears only the targeted session queue", () => {
    const queueA = createSessionKey("env-1", "tab-1");
    const queueB = createSessionKey("env-1", "tab-2");
    const store = useClaudeStore.getState();

    seedQueuedPrompt(store, queueA, {
      id: "q-1",
      text: "first",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });
    seedQueuedPrompt(store, queueA, {
      id: "q-2",
      text: "second",
      attachments: [],
      effort: "medium",
      planModeEnabled: true,
      fastModeEnabled: false,
    });
    seedQueuedPrompt(store, queueB, {
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

    store.setQueueProjection(queueA, []);

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

describe("claudeStore client-only message merge", () => {
  const message = (id: string, timestamp: string): ClaudeMessage => ({
    id,
    role: id.startsWith(ERROR_MESSAGE_PREFIX) ? "system" : "assistant",
    content: id,
    parts: [{ type: "text", content: id }],
    timestamp,
  });

  const seed = (messages: ClaudeMessage[]) => {
    useClaudeStore.getState().setSession(SESSION_KEY, {
      sessionId: "session-1",
      messages,
      isLoading: false,
    });
  };

  const mergedIds = () =>
    useClaudeStore
      .getState()
      .getSession(SESSION_KEY)
      ?.messages.map((item) => item.id);

  beforeEach(() => {
    resetClaudeStore();
  });

  test("replaces the transcript wholesale when nothing client-only is held", () => {
    seed([message("assistant-1", "2026-07-20T12:00:00.000Z")]);
    const incoming = [message("assistant-2", "2026-07-20T12:00:02.000Z")];

    useClaudeStore.getState().setMessages(SESSION_KEY, incoming);

    // The server fetch is authoritative here, so the array is adopted as-is.
    expect(useClaudeStore.getState().getSession(SESSION_KEY)?.messages).toEqual(
      incoming,
    );
  });

  test("appends a client-only message newer than every fetched message", () => {
    seed([
      message("assistant-1", "2026-07-20T12:00:00.000Z"),
      message(`${ERROR_MESSAGE_PREFIX}late`, "2026-07-20T12:00:09.000Z"),
    ]);

    useClaudeStore.getState().setMessages(SESSION_KEY, [
      message("assistant-1", "2026-07-20T12:00:00.000Z"),
      message("assistant-2", "2026-07-20T12:00:02.000Z"),
    ]);

    expect(mergedIds()).toEqual([
      "assistant-1",
      "assistant-2",
      `${ERROR_MESSAGE_PREFIX}late`,
    ]);
  });

  test("appends a client-only message when the fetched transcript is empty", () => {
    seed([message(`${SYSTEM_MESSAGE_PREFIX}compact`, "2026-07-20T12:00:05.000Z")]);

    useClaudeStore.getState().setMessages(SESSION_KEY, []);

    expect(mergedIds()).toEqual([`${SYSTEM_MESSAGE_PREFIX}compact`]);
  });

  test("inserts a client-only message between the fetched messages it sits between", () => {
    seed([message(`${SYSTEM_MESSAGE_PREFIX}compact`, "2026-07-20T12:00:03.000Z")]);

    useClaudeStore.getState().setMessages(SESSION_KEY, [
      message("assistant-1", "2026-07-20T12:00:00.000Z"),
      message("assistant-2", "2026-07-20T12:00:02.000Z"),
      message("assistant-3", "2026-07-20T12:00:10.000Z"),
    ]);

    expect(mergedIds()).toEqual([
      "assistant-1",
      "assistant-2",
      `${SYSTEM_MESSAGE_PREFIX}compact`,
      "assistant-3",
    ]);
  });

  test("inserts a client-only message older than every fetched message at the front", () => {
    seed([message(`${ERROR_MESSAGE_PREFIX}early`, "2026-07-20T11:59:00.000Z")]);

    useClaudeStore.getState().setMessages(SESSION_KEY, [
      message("assistant-1", "2026-07-20T12:00:00.000Z"),
      message("assistant-2", "2026-07-20T12:00:02.000Z"),
    ]);

    expect(mergedIds()).toEqual([
      `${ERROR_MESSAGE_PREFIX}early`,
      "assistant-1",
      "assistant-2",
    ]);
  });

  test("keeps several client-only messages, each at its own point in the history", () => {
    seed([
      message(`${ERROR_MESSAGE_PREFIX}early`, "2026-07-20T11:59:00.000Z"),
      message(`${SYSTEM_MESSAGE_PREFIX}compact`, "2026-07-20T12:00:03.000Z"),
      message(`${ERROR_MESSAGE_PREFIX}late`, "2026-07-20T12:00:30.000Z"),
    ]);

    useClaudeStore.getState().setMessages(SESSION_KEY, [
      message("assistant-1", "2026-07-20T12:00:00.000Z"),
      message("assistant-2", "2026-07-20T12:00:10.000Z"),
    ]);

    expect(mergedIds()).toEqual([
      `${ERROR_MESSAGE_PREFIX}early`,
      "assistant-1",
      `${SYSTEM_MESSAGE_PREFIX}compact`,
      "assistant-2",
      `${ERROR_MESSAGE_PREFIX}late`,
    ]);
  });

  test("treats a client-only message with no timestamp as the oldest message", () => {
    // `timestamp || 0` makes an empty timestamp the epoch, so the message is
    // kept rather than dropped — it just sorts to the front.
    seed([message(`${ERROR_MESSAGE_PREFIX}undated`, "")]);

    useClaudeStore.getState().setMessages(SESSION_KEY, [
      message("assistant-1", "2026-07-20T12:00:00.000Z"),
    ]);

    expect(mergedIds()).toEqual([
      `${ERROR_MESSAGE_PREFIX}undated`,
      "assistant-1",
    ]);
  });

  test("keeps a fetched message with no timestamp ahead of a later client-only message", () => {
    seed([message(`${SYSTEM_MESSAGE_PREFIX}compact`, "2026-07-20T12:00:05.000Z")]);

    useClaudeStore
      .getState()
      .setMessages(SESSION_KEY, [message("assistant-1", "")]);

    expect(mergedIds()).toEqual([
      "assistant-1",
      `${SYSTEM_MESSAGE_PREFIX}compact`,
    ]);
  });

  test("falls back to appending when a timestamp cannot be parsed", () => {
    // Every comparison against NaN is false, so neither insertion branch fires
    // and the client-only message lands at the end rather than being lost.
    seed([message(`${ERROR_MESSAGE_PREFIX}unparseable`, "not-a-timestamp")]);

    useClaudeStore.getState().setMessages(SESSION_KEY, [
      message("assistant-1", "2026-07-20T12:00:00.000Z"),
      message("assistant-2", "2026-07-20T12:00:02.000Z"),
    ]);

    expect(mergedIds()).toEqual([
      "assistant-1",
      "assistant-2",
      `${ERROR_MESSAGE_PREFIX}unparseable`,
    ]);
  });

  test("falls back to appending when a fetched timestamp cannot be parsed", () => {
    seed([message(`${ERROR_MESSAGE_PREFIX}boom`, "2026-07-20T12:00:05.000Z")]);

    useClaudeStore.getState().setMessages(SESSION_KEY, [
      message("assistant-1", "not-a-timestamp"),
      message("assistant-2", "2026-07-20T12:00:10.000Z"),
    ]);

    expect(mergedIds()).toEqual([
      "assistant-1",
      "assistant-2",
      `${ERROR_MESSAGE_PREFIX}boom`,
    ]);
  });
});

describe("claudeStore session selectors and pending requests", () => {
  beforeEach(() => {
    resetClaudeStore();
  });

  test("resolves a session key from the SDK session id and returns null with no match", () => {
    const keyA = createSessionKey("env-1", "tab-1");
    const keyB = createSessionKey("env-2", "tab-1");
    const store = useClaudeStore.getState();

    store.setSession(keyA, {
      sessionId: "sdk-a",
      messages: [],
      isLoading: false,
    });
    store.setSession(keyB, {
      sessionId: "sdk-b",
      messages: [],
      isLoading: false,
    });

    expect(store.getSessionKeyBySdkSessionId("sdk-b")).toBe(keyB);
    // SSE events for a session this window never opened must not be attributed
    // to whichever tab happens to be first in the map.
    expect(store.getSessionKeyBySdkSessionId("sdk-unknown")).toBeNull();
  });

  test("groups pending questions and plan approvals by SDK session id", () => {
    const store = useClaudeStore.getState();

    store.addPendingQuestion({
      id: "question-1",
      sessionId: "sdk-a",
      questions: [],
    });
    store.addPendingQuestion({
      id: "question-2",
      sessionId: "sdk-a",
      questions: [],
    });
    store.addPendingQuestion({
      id: "question-3",
      sessionId: "sdk-b",
      questions: [],
    });
    store.addPendingPlanApproval({ id: "approval-1", sessionId: "sdk-a" });
    store.addPendingPlanApproval({ id: "approval-2", sessionId: "sdk-b" });

    expect(
      store.getPendingQuestionsForSession("sdk-a").map((item) => item.id),
    ).toEqual(["question-1", "question-2"]);
    expect(
      store.getPendingQuestionsForSession("sdk-b").map((item) => item.id),
    ).toEqual(["question-3"]);
    expect(store.getPendingQuestionsForSession("sdk-missing")).toEqual([]);

    expect(
      store.getPendingPlanApprovalsForSession("sdk-a").map((item) => item.id),
    ).toEqual(["approval-1"]);
    expect(
      store.getPendingPlanApprovalsForSession("sdk-b").map((item) => item.id),
    ).toEqual(["approval-2"]);
    expect(store.getPendingPlanApprovalsForSession("sdk-missing")).toEqual([]);
  });

  test("removes an answered question or approval without disturbing the others", () => {
    const store = useClaudeStore.getState();

    store.addPendingQuestion({
      id: "question-1",
      sessionId: "sdk-a",
      questions: [],
    });
    store.addPendingQuestion({
      id: "question-2",
      sessionId: "sdk-a",
      questions: [],
    });
    store.addPendingPlanApproval({ id: "approval-1", sessionId: "sdk-a" });
    store.addPendingPlanApproval({ id: "approval-2", sessionId: "sdk-a" });

    store.removePendingQuestion("question-1");
    store.removePendingPlanApproval("approval-1");

    expect(store.getPendingQuestion("question-1")).toBeUndefined();
    expect(store.getPendingQuestion("question-2")).toBeDefined();
    expect(store.getPendingPlanApproval("approval-1")).toBeUndefined();
    expect(store.getPendingPlanApproval("approval-2")).toBeDefined();

    // A late duplicate response (the card answered in another window) is a
    // no-op rather than a throw.
    store.removePendingQuestion("question-1");
    store.removePendingPlanApproval("approval-1");

    expect(
      store.getPendingQuestionsForSession("sdk-a").map((item) => item.id),
    ).toEqual(["question-2"]);
    expect(
      store.getPendingPlanApprovalsForSession("sdk-a").map((item) => item.id),
    ).toEqual(["approval-2"]);
  });

  test("defaults effort to high, plan mode to off, and fast mode to off", () => {
    const store = useClaudeStore.getState();
    const untouched = createSessionKey("env-1", "tab-fresh");

    expect(store.getEffort(untouched)).toBe("high");
    expect(store.isPlanMode(untouched)).toBe(false);
    expect(store.isFastMode(untouched)).toBe(false);
  });

  test("tracks fast mode per session and toggles it back off", () => {
    const keyA = createSessionKey("env-1", "tab-1");
    const keyB = createSessionKey("env-1", "tab-2");
    const store = useClaudeStore.getState();

    store.setFastMode(keyA, true);

    expect(store.isFastMode(keyA)).toBe(true);
    expect(store.isFastMode(keyB)).toBe(false);

    store.setFastMode(keyA, false);

    expect(store.isFastMode(keyA)).toBe(false);
    expect(useClaudeStore.getState().fastMode.get(keyA)).toBe(false);
  });
});

describe("claudeStore per-session turn options", () => {
  beforeEach(resetClaudeStore);

  describe("selectedAgent", () => {
    test("stores and reads an agent per session", () => {
      const store = useClaudeStore.getState();
      const otherKey = createSessionKey("env-1", "tab-2");

      store.setSelectedAgent(SESSION_KEY, "reviewer");

      expect(useClaudeStore.getState().getSelectedAgent(SESSION_KEY)).toBe("reviewer");
      expect(useClaudeStore.getState().getSelectedAgent(otherKey)).toBeUndefined();
    });

    test("clears the key rather than storing an empty selection", () => {
      // The absence of a key is what the prompt builder reads as "no agent", so
      // storing `undefined` under the key would send `agent: undefined`.
      const store = useClaudeStore.getState();
      store.setSelectedAgent(SESSION_KEY, "reviewer");

      store.setSelectedAgent(SESSION_KEY, undefined);

      expect(useClaudeStore.getState().getSelectedAgent(SESSION_KEY)).toBeUndefined();
      expect(useClaudeStore.getState().selectedAgent.has(SESSION_KEY)).toBe(false);

      store.setSelectedAgent(SESSION_KEY, "reviewer");
      store.setSelectedAgent(SESSION_KEY, "");
      expect(useClaudeStore.getState().selectedAgent.has(SESSION_KEY)).toBe(false);
    });
  });

  describe("includeLocalSettings", () => {
    test("defaults to false for a session that never opted in", () => {
      expect(useClaudeStore.getState().includesLocalSettings(SESSION_KEY)).toBe(false);
    });

    test("stores the opt-in and deletes the key when turned back off", () => {
      const store = useClaudeStore.getState();

      store.setIncludeLocalSettings(SESSION_KEY, true);
      expect(useClaudeStore.getState().includesLocalSettings(SESSION_KEY)).toBe(true);
      expect(useClaudeStore.getState().includeLocalSettings.get(SESSION_KEY)).toBe(true);

      store.setIncludeLocalSettings(SESSION_KEY, false);
      expect(useClaudeStore.getState().includesLocalSettings(SESSION_KEY)).toBe(false);
      // Stored as absence rather than `false`, so the map only ever holds `true`.
      expect(useClaudeStore.getState().includeLocalSettings.has(SESSION_KEY)).toBe(false);
    });

    test("is scoped per session", () => {
      const store = useClaudeStore.getState();
      const otherKey = createSessionKey("env-1", "tab-2");

      store.setIncludeLocalSettings(SESSION_KEY, true);

      expect(useClaudeStore.getState().includesLocalSettings(otherKey)).toBe(false);
    });
  });

  describe("promptSuggestionOptIn", () => {
    test("records both sides of the toggle", () => {
      const store = useClaudeStore.getState();

      store.setPromptSuggestionOptIn(SESSION_KEY, true);
      expect(useClaudeStore.getState().promptSuggestionOptIn.get(SESSION_KEY)).toBe(true);

      // Unlike `includeLocalSettings`, an explicit `false` is retained: it is the
      // difference between "declined" and "never asked".
      store.setPromptSuggestionOptIn(SESSION_KEY, false);
      expect(useClaudeStore.getState().promptSuggestionOptIn.get(SESSION_KEY)).toBe(false);
      expect(useClaudeStore.getState().promptSuggestionOptIn.has(SESSION_KEY)).toBe(true);
    });
  });

  describe("promptSuggestions", () => {
    test("stores a suggestion and clears it on a falsy value", () => {
      const store = useClaudeStore.getState();

      store.setPromptSuggestion(SESSION_KEY, "Try running the tests");
      expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBe(
        "Try running the tests",
      );

      store.setPromptSuggestion(SESSION_KEY, undefined);
      expect(useClaudeStore.getState().promptSuggestions.has(SESSION_KEY)).toBe(false);

      store.setPromptSuggestion(SESSION_KEY, "Try running the tests");
      // An empty suggestion is nothing to show, so it clears rather than
      // rendering an empty chip.
      store.setPromptSuggestion(SESSION_KEY, "");
      expect(useClaudeStore.getState().promptSuggestions.has(SESSION_KEY)).toBe(false);
    });
  });

  describe("dismissedPromptSuggestions", () => {
    test("remembers the exact consumed string and clears on a falsy value", () => {
      /*
       * The bridge only clears `session.promptSuggestion` when the *next*
       * prompt runs, so every snapshot replays it. This latch is what stops a
       * consumed chip from coming back, and it has to be the string rather than
       * a boolean so a genuinely new suggestion still gets through.
       */
      const store = useClaudeStore.getState();

      store.setDismissedPromptSuggestion(SESSION_KEY, "Add a regression test");
      expect(useClaudeStore.getState().getDismissedPromptSuggestion(SESSION_KEY))
        .toBe("Add a regression test");

      store.setDismissedPromptSuggestion(SESSION_KEY, undefined);
      expect(useClaudeStore.getState().dismissedPromptSuggestions.has(SESSION_KEY)).toBe(false);

      store.setDismissedPromptSuggestion(SESSION_KEY, "Add a regression test");
      store.setDismissedPromptSuggestion(SESSION_KEY, "");
      expect(useClaudeStore.getState().dismissedPromptSuggestions.has(SESSION_KEY)).toBe(false);
    });

    test("is scoped per session and independent of the live suggestion", () => {
      const store = useClaudeStore.getState();
      const otherKey = createSessionKey("env-1", "tab-2");

      store.setPromptSuggestion(SESSION_KEY, "Run the tests");
      store.setDismissedPromptSuggestion(SESSION_KEY, "Run the tests");

      const state = useClaudeStore.getState();
      // Latching what was consumed does not itself hide the chip; the tab
      // clears the live suggestion separately.
      expect(state.promptSuggestions.get(SESSION_KEY)).toBe("Run the tests");
      expect(state.dismissedPromptSuggestions.has(otherKey)).toBe(false);
      expect(state.getDismissedPromptSuggestion(otherKey)).toBeUndefined();
    });
  });

  describe("backgroundTasks", () => {
    const task = { id: "task-1", status: "running" } as never;

    test("stores a non-empty task record", () => {
      const store = useClaudeStore.getState();

      store.setBackgroundTasks(SESSION_KEY, { "task-1": task });

      expect(useClaudeStore.getState().backgroundTasks.get(SESSION_KEY)).toEqual({
        "task-1": task,
      });
      expect(
        useClaudeStore.getState().backgroundTaskRevisions.get(SESSION_KEY),
      ).toBe(1);
    });

    test("deletes the key and advances its revision when the bridge reports no tasks", () => {
      // The bridge is authoritative and reports the whole set each time, so an
      // empty record means "none left" and must not linger as an empty object a
      // selector would treat as a fresh reference on every read.
      const store = useClaudeStore.getState();
      store.setBackgroundTasks(SESSION_KEY, { "task-1": task });

      store.setBackgroundTasks(SESSION_KEY, {});

      expect(useClaudeStore.getState().backgroundTasks.has(SESSION_KEY)).toBe(false);
      expect(
        useClaudeStore.getState().backgroundTaskRevisions.get(SESSION_KEY),
      ).toBe(2);
    });

    test("detects an absent to present to absent snapshot sequence", () => {
      const store = useClaudeStore.getState();
      expect(store.backgroundTasks.has(SESSION_KEY)).toBe(false);
      expect(store.backgroundTaskRevisions.has(SESSION_KEY)).toBe(false);

      store.setBackgroundTasks(SESSION_KEY, { "task-1": task });
      store.setBackgroundTasks(SESSION_KEY, {});

      const state = useClaudeStore.getState();
      expect(state.backgroundTasks.has(SESSION_KEY)).toBe(false);
      expect(state.backgroundTaskRevisions.get(SESSION_KEY)).toBe(2);
    });

    test("replaces rather than merges the previous record", () => {
      const store = useClaudeStore.getState();
      store.setBackgroundTasks(SESSION_KEY, { "task-1": task, "task-2": task });

      store.setBackgroundTasks(SESSION_KEY, { "task-2": task });

      expect(
        Object.keys(useClaudeStore.getState().backgroundTasks.get(SESSION_KEY) ?? {}),
      ).toEqual(["task-2"]);
    });

    test("is scoped per session", () => {
      const store = useClaudeStore.getState();
      const otherKey = createSessionKey("env-1", "tab-2");

      store.setBackgroundTasks(SESSION_KEY, { "task-1": task });

      expect(useClaudeStore.getState().backgroundTasks.has(otherKey)).toBe(false);
    });
  });

  describe("contextUsage", () => {
    const usage = {
      usedTokens: 12_500,
      totalTokens: 200_000,
      percentUsed: 6.25,
      modelId: "claude-sonnet-4",
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      sessionTokens: 12_500,
      costUsd: 0.42,
      estimated: false,
      source: "claude" as const,
      updatedAt: "2026-07-26T00:00:00.000Z",
      rateLimits: [{ label: "5h", usedPercent: 12 }],
    };

    test("round-trips a full provider-exact snapshot and clears on null", () => {
      const store = useClaudeStore.getState();

      store.setContextUsage(SESSION_KEY, usage);
      expect(useClaudeStore.getState().getContextUsage(SESSION_KEY)).toEqual(usage);

      store.setContextUsage(SESSION_KEY, null);
      expect(useClaudeStore.getState().getContextUsage(SESSION_KEY)).toBeUndefined();
      expect(useClaudeStore.getState().contextUsage.has(SESSION_KEY)).toBe(false);
    });

    test("replaces rather than merges an earlier snapshot", () => {
      const store = useClaudeStore.getState();
      store.setContextUsage(SESSION_KEY, usage);

      store.setContextUsage(SESSION_KEY, {
        usedTokens: 1,
        totalTokens: 2,
        percentUsed: 50,
      });

      expect(useClaudeStore.getState().getContextUsage(SESSION_KEY)).toEqual({
        usedTokens: 1,
        totalTokens: 2,
        percentUsed: 50,
      });
    });

    test("stores rate limits without requiring a context snapshot", () => {
      const store = useClaudeStore.getState();
      const limits = [{ label: "5h", usedPercent: 12 }];

      store.setRateLimits(SESSION_KEY, limits);

      expect(store.getContextUsage(SESSION_KEY)).toBeUndefined();
      expect(useClaudeStore.getState().getRateLimits(SESSION_KEY)).toEqual(limits);
    });

    test("retains an authoritative empty limit array and clears only on null", () => {
      const store = useClaudeStore.getState();
      store.setRateLimits(SESSION_KEY, [{ label: "Weekly", usedPercent: 80 }]);

      store.setRateLimits(SESSION_KEY, []);
      expect(useClaudeStore.getState().rateLimits.has(SESSION_KEY)).toBe(true);
      expect(useClaudeStore.getState().getRateLimits(SESSION_KEY)).toEqual([]);

      store.setRateLimits(SESSION_KEY, null);
      expect(useClaudeStore.getState().rateLimits.has(SESSION_KEY)).toBe(false);
    });

    test("a context snapshot updates limits only when it carries that field", () => {
      const store = useClaudeStore.getState();
      store.setRateLimits(SESSION_KEY, [{ label: "5h", usedPercent: 12 }]);

      store.setContextUsage(SESSION_KEY, {
        usedTokens: 1,
        totalTokens: 10,
        percentUsed: 10,
      });
      expect(store.getRateLimits(SESSION_KEY)).toEqual([
        { label: "5h", usedPercent: 12 },
      ]);

      store.setContextUsage(SESSION_KEY, {
        usedTokens: 2,
        totalTokens: 10,
        percentUsed: 20,
        rateLimits: [],
      });
      expect(useClaudeStore.getState().getRateLimits(SESSION_KEY)).toEqual([]);
    });
  });

  test("clearEnvironment prunes every session-scoped map for that environment only", () => {
    const store = useClaudeStore.getState();
    const otherEnvKey = createSessionKey("env-2", "tab-1");

    for (const key of [SESSION_KEY, otherEnvKey]) {
      store.setSelectedAgent(key, "reviewer");
      store.setIncludeLocalSettings(key, true);
      store.setPromptSuggestionOptIn(key, true);
      store.setPromptSuggestion(key, "Run the tests");
      store.setDismissedPromptSuggestion(key, "Already used this one");
      store.setBackgroundTasks(key, { "task-1": { id: "task-1" } as never });
      store.setFastMode(key, true);
      store.setContextUsage(key, { usedTokens: 1, totalTokens: 2, percentUsed: 50 });
      store.setRateLimits(key, [{ label: "5h", usedPercent: 50 }]);
      store.setEffort(key, "low");
      store.setPlanMode(key, true);
      store.setComposing(key, true);
      store.setSelectedModel(key, "claude-sonnet-4");
      store.setDraftText(key, "half-written prompt");
      store.setDraftMentions(key, ["src/index.ts"] as never);
      seedQueuedPrompt(store, key, { id: "queued-1", text: "later" } as never);
    }

    store.clearEnvironment("env-1");

    const state = useClaudeStore.getState();
    expect(state.selectedAgent.has(SESSION_KEY)).toBe(false);
    expect(state.includeLocalSettings.has(SESSION_KEY)).toBe(false);
    expect(state.promptSuggestionOptIn.has(SESSION_KEY)).toBe(false);
    expect(state.promptSuggestions.has(SESSION_KEY)).toBe(false);
    expect(state.dismissedPromptSuggestions.has(SESSION_KEY)).toBe(false);
    expect(state.backgroundTasks.has(SESSION_KEY)).toBe(false);
    expect(state.backgroundTaskRevisions.has(SESSION_KEY)).toBe(false);
    expect(state.fastMode.has(SESSION_KEY)).toBe(false);
    expect(state.contextUsage.has(SESSION_KEY)).toBe(false);
    expect(state.rateLimits.has(SESSION_KEY)).toBe(false);
    expect(state.effort.has(SESSION_KEY)).toBe(false);
    expect(state.planMode.has(SESSION_KEY)).toBe(false);
    expect(state.isComposing.has(SESSION_KEY)).toBe(false);
    expect(state.selectedModel.has(SESSION_KEY)).toBe(false);
    expect(state.draftText.has(SESSION_KEY)).toBe(false);
    expect(state.draftMentions.has(SESSION_KEY)).toBe(false);
    expect(state.messageQueue.has(SESSION_KEY)).toBe(false);

    // A second environment's tabs are untouched: clearing one environment must
    // not disturb work still running in another. Asserted map by map — a shared
    // "nothing leaked" assertion would pass while one prune quietly took the
    // wrong prefix.
    expect(state.selectedAgent.get(otherEnvKey)).toBe("reviewer");
    expect(state.includeLocalSettings.get(otherEnvKey)).toBe(true);
    expect(state.promptSuggestionOptIn.get(otherEnvKey)).toBe(true);
    expect(state.promptSuggestions.get(otherEnvKey)).toBe("Run the tests");
    expect(state.dismissedPromptSuggestions.get(otherEnvKey)).toBe("Already used this one");
    expect(state.backgroundTasks.has(otherEnvKey)).toBe(true);
    expect(state.backgroundTaskRevisions.get(otherEnvKey)).toBe(1);
    expect(state.fastMode.get(otherEnvKey)).toBe(true);
    expect(state.contextUsage.has(otherEnvKey)).toBe(true);
    expect(state.rateLimits.has(otherEnvKey)).toBe(true);
    expect(state.effort.get(otherEnvKey)).toBe("low");
    expect(state.planMode.get(otherEnvKey)).toBe(true);
    expect(state.isComposing.get(otherEnvKey)).toBe(true);
    expect(state.selectedModel.get(otherEnvKey)).toBe("claude-sonnet-4");
    expect(state.draftText.get(otherEnvKey)).toBe("half-written prompt");
    expect(state.draftMentions.get(otherEnvKey)).toEqual(["src/index.ts"] as never);
    expect(state.messageQueue.get(otherEnvKey)).toHaveLength(1);
  });
});
