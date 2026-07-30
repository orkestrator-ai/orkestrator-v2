import { createSessionKey } from "@/lib/utils";
import { beforeEach, describe, expect, test } from "bun:test";
import { createOptimisticNativeMessage } from "@/lib/chat/client-only-messages";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  type CodexApproval,
  type CodexApprovalFileChange,
  type CodexInteraction,
} from "@/lib/codex-client";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import {
  CODEX_UNCONFIRMED_DISPATCH_ERROR,
  useCodexStore,
} from "./codexStore";
import {
  codexInteractionDraftKey,
  usePromptDraftStore,
} from "./promptDraftStore";
import { seedQueuedPrompt } from "@/stores/testing/queue-projection";

const SESSION_KEY = createSessionKey("env-1", "tab-1");

function resetCodexStore() {
  usePromptDraftStore.getState().reset();
  useCodexStore.setState({
    models: [],
    serverStatus: new Map(),
    clients: new Map(),
    sessions: new Map(),
    sessionLoadingRevisions: new Map(),
    slashCommands: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    selectedModel: new Map(),
    selectedMode: new Map(),
    selectedReasoningEffort: new Map(),
    fastMode: new Map(),
    sessionPhase: new Map(),
    pendingApprovals: new Map(),
    // Every map the store owns has to be reset here. A map left out is a map
    // that carries state between test files, which makes the first test anyone
    // writes for that action order-dependent.
    pendingInteractions: new Map(),
    contextUsage: new Map(),
    unconfirmedDispatches: new Map(),
    promptDispatchClaims: new Map(),
  });
}

/** Minimal interaction, with only the fields the store keys on. */
function interaction(
  interactionId: string,
  overrides: Partial<CodexInteraction> = {},
): CodexInteraction {
  return {
    interactionId,
    kind: "question",
    method: "item/userInput/request",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestedAt: 0,
    expiresAt: 300_000,
    questions: [
      { id: "q-1", header: "Deploy", question: "Where?", isOther: false, isSecret: false },
    ],
    ...overrides,
  };
}

/** Minimal approval, with only the fields the store keys on. */
function approval(approvalId: string): CodexApproval {
  return {
    approvalId,
    kind: "command",
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestedAt: 0,
    expiresAt: 300_000,
    command: "ls",
    actionable: true,
    supportsApproveForSession: true,
  };
}

/** Permission-upgrade approval, the only kind carrying a `permissions` block. */
function permissionsApproval(
  approvalId: string,
  permissions: { network: boolean; fileSystem: boolean },
): CodexApproval {
  return {
    approvalId,
    kind: "permissions",
    method: "thread/requestPermissionUpgrade",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: null,
    requestedAt: 0,
    expiresAt: 300_000,
    permissions,
    actionable: true,
    supportsApproveForSession: false,
  };
}

/** File-change approval, the only kind carrying a `changes` list. */
function fileChangeApproval(
  approvalId: string,
  changes: CodexApprovalFileChange[],
): CodexApproval {
  return {
    approvalId,
    kind: "file-change",
    method: "item/fileChange/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestedAt: 0,
    expiresAt: 300_000,
    cwd: "/workspace",
    changes,
    actionable: true,
    supportsApproveForSession: true,
  };
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

  test("settles an unconfirmed dispatch as confirmed when the transcript echoes it", () => {
    const store = useCodexStore.getState();
    const optimistic = createOptimisticNativeMessage(
      "optimistic-confirmed",
      "Run the checks",
    );
    store.addMessage(SESSION_KEY, optimistic);
    store.setUnconfirmedDispatch(SESSION_KEY, {
      userMessageId: optimistic.id,
      fingerprint: "fingerprint-confirmed",
      requestId: "request-confirmed",
    });
    store.setMessages(SESSION_KEY, [{
      id: "server-confirmed",
      role: "user",
      content: "Run the checks",
      parts: [{ type: "text", content: "Run the checks" }],
      createdAt: optimistic.createdAt,
    }]);

    expect(store.settleUnconfirmedDispatch(SESSION_KEY)).toBe("confirmed");
    expect(useCodexStore.getState().unconfirmedDispatches.has(SESSION_KEY)).toBe(false);
    expect(
      useCodexStore.getState().sessions.get(SESSION_KEY)?.messages.map(
        (message) => message.id,
      ),
    ).toEqual(["server-confirmed"]);
  });

  test("does not treat an unrelated transcript catch-up as proof of delivery", () => {
    const store = useCodexStore.getState();
    const existing = {
      id: "server-existing",
      role: "assistant" as const,
      content: "Earlier response",
      parts: [{ type: "text" as const, content: "Earlier response" }],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    const optimistic = createOptimisticNativeMessage(
      "optimistic-response",
      "Run the checks",
    );
    store.setMessages(SESSION_KEY, [existing]);
    store.addMessage(SESSION_KEY, optimistic);
    store.setUnconfirmedDispatch(SESSION_KEY, {
      userMessageId: optimistic.id,
      fingerprint: "fingerprint-response",
      requestId: "request-response",
    });
    store.setMessages(SESSION_KEY, [
      existing,
      {
        id: "server-new-response",
        role: "assistant",
        content: "Checks passed",
        parts: [{ type: "text", content: "Checks passed" }],
        createdAt: "2026-04-15T10:01:00.000Z",
      },
    ]);

    expect(store.settleUnconfirmedDispatch(SESSION_KEY)).toBe("retryable");
    const state = useCodexStore.getState();
    expect(state.unconfirmedDispatches.get(SESSION_KEY)).toEqual({
      userMessageId: optimistic.id,
      fingerprint: "fingerprint-response",
      requestId: "request-response",
      retryable: true,
    });
    expect(state.sessions.get(SESSION_KEY)?.messages.map((message) => message.id))
      .toEqual(["server-existing", "server-new-response"]);
  });

  test("turns an unmatched unconfirmed dispatch into a durable safe retry", () => {
    const store = useCodexStore.getState();
    const optimistic = createOptimisticNativeMessage(
      "optimistic-retryable",
      "Run the checks",
    );
    store.addMessage(SESSION_KEY, optimistic);
    store.setUnconfirmedDispatch(SESSION_KEY, {
      userMessageId: optimistic.id,
      fingerprint: "fingerprint-retryable",
      requestId: "request-retryable",
    });
    store.setMessages(SESSION_KEY, []);

    expect(store.settleUnconfirmedDispatch(SESSION_KEY)).toBe("retryable");
    expect(store.settleUnconfirmedDispatch(SESSION_KEY)).toBe("retryable");
    expect(
      useCodexStore.getState().sessions.get(SESSION_KEY)?.messages.some(
        (message) => message.id === optimistic.id,
      ),
    ).toBe(false);
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.error)
      .toBe(CODEX_UNCONFIRMED_DISPATCH_ERROR);
    expect(useCodexStore.getState().unconfirmedDispatches.get(SESSION_KEY))
      .toEqual({
        userMessageId: optimistic.id,
        fingerprint: "fingerprint-retryable",
        requestId: "request-retryable",
        retryable: true,
      });
  });

  test("reports no unconfirmed dispatch when there is nothing to settle", () => {
    expect(useCodexStore.getState().settleUnconfirmedDispatch(SESSION_KEY))
      .toBe("none");
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

describe("codexStore prompt dispatch claims", () => {
  beforeEach(resetCodexStore);

  test("atomically allows one claimant and releases it for a later retry", () => {
    const store = useCodexStore.getState();

    expect(store.claimPromptDispatch(SESSION_KEY, "request-1")).toBe(true);
    expect(store.claimPromptDispatch(SESSION_KEY, "request-1")).toBe(false);
    expect(useCodexStore.getState().promptDispatchClaims.get(SESSION_KEY))
      .toEqual(new Set(["request-1"]));

    store.releasePromptDispatch(SESSION_KEY, "request-1");

    expect(useCodexStore.getState().promptDispatchClaims.has(SESSION_KEY)).toBe(false);
    expect(store.claimPromptDispatch(SESSION_KEY, "request-1")).toBe(true);
  });

  test("releasing one request preserves other claims for the same session", () => {
    const store = useCodexStore.getState();
    expect(store.claimPromptDispatch(SESSION_KEY, "request-1")).toBe(true);
    expect(store.claimPromptDispatch(SESSION_KEY, "request-2")).toBe(true);

    store.releasePromptDispatch(SESSION_KEY, "request-1");

    expect(useCodexStore.getState().promptDispatchClaims.get(SESSION_KEY))
      .toEqual(new Set(["request-2"]));
    expect(store.claimPromptDispatch(SESSION_KEY, "request-1")).toBe(true);
    expect(store.claimPromptDispatch(SESSION_KEY, "request-2")).toBe(false);
  });

  test("releasing an unknown request or session preserves store and claim identities", () => {
    const store = useCodexStore.getState();
    store.claimPromptDispatch(SESSION_KEY, "request-1");
    const stateBeforeRelease = useCodexStore.getState();
    const claimsBeforeRelease = stateBeforeRelease.promptDispatchClaims;
    const sessionClaimsBeforeRelease = claimsBeforeRelease.get(SESSION_KEY);

    store.releasePromptDispatch(SESSION_KEY, "unknown-request");

    const stateAfterRelease = useCodexStore.getState();
    expect(stateAfterRelease).toBe(stateBeforeRelease);
    expect(stateAfterRelease.promptDispatchClaims).toBe(claimsBeforeRelease);
    expect(stateAfterRelease.promptDispatchClaims.get(SESSION_KEY))
      .toBe(sessionClaimsBeforeRelease);

    store.releasePromptDispatch(
      createSessionKey("env-1", "missing-tab"),
      "request-1",
    );

    expect(useCodexStore.getState()).toBe(stateAfterRelease);
    expect(useCodexStore.getState().promptDispatchClaims).toBe(claimsBeforeRelease);
  });

  test("session and environment cleanup release their claims", () => {
    const store = useCodexStore.getState();
    const otherSession = createSessionKey("env-2", "tab-1");
    store.claimPromptDispatch(SESSION_KEY, "request-1");
    store.claimPromptDispatch(otherSession, "request-2");

    store.clearSession(SESSION_KEY);
    expect(useCodexStore.getState().promptDispatchClaims.has(SESSION_KEY)).toBe(false);
    expect(useCodexStore.getState().promptDispatchClaims.has(otherSession)).toBe(true);

    store.clearEnvironment("env-2");
    expect(useCodexStore.getState().promptDispatchClaims.size).toBe(0);
  });
});

describe("codexStore session cleanup", () => {
  beforeEach(() => {
    resetCodexStore();
  });

  test("clearSession exhaustively removes every session-keyed map for only the target tab", () => {
    const targetKey = createSessionKey("env-1", "tab-target");
    const otherKey = createSessionKey("env-1", "tab-other");
    useCodexStore.setState({
      sessions: new Map([
        [targetKey, { sessionId: "bridge-target", messages: [], isLoading: false }],
        [otherKey, { sessionId: "bridge-other", messages: [], isLoading: false }],
      ]),
      sessionLoadingRevisions: new Map([
        [targetKey, 3],
        [otherKey, 7],
      ]),
      attachments: new Map([[targetKey, []], [otherKey, []]]),
      draftText: new Map([[targetKey, "target"], [otherKey, "other"]]),
      draftMentions: new Map([[targetKey, []], [otherKey, []]]),
      messageQueue: new Map([[targetKey, []], [otherKey, []]]),
      selectedModel: new Map([[targetKey, "gpt-5.4"], [otherKey, "gpt-5.3"]]),
      selectedMode: new Map([[targetKey, "build"], [otherKey, "plan"]]),
      selectedReasoningEffort: new Map([[targetKey, "high"], [otherKey, "medium"]]),
      fastMode: new Map([[targetKey, true], [otherKey, false]]),
      sessionPhase: new Map([[targetKey, "running"], [otherKey, "idle"]]),
      pendingApprovals: new Map([
        [targetKey, [approval("approval-target")]],
        [otherKey, [approval("approval-other")]],
      ]),
      pendingInteractions: new Map([
        [targetKey, [interaction("interaction-target")]],
        [otherKey, [interaction("interaction-other")]],
      ]),
      contextUsage: new Map([
        [targetKey, { usedTokens: 10, totalTokens: 100, percentUsed: 10 }],
        [otherKey, { usedTokens: 20, totalTokens: 100, percentUsed: 20 }],
      ]),
      unconfirmedDispatches: new Map([
        [
          targetKey,
          {
            userMessageId: "message-target",
            fingerprint: "fingerprint-target",
            requestId: "request-target",
          },
        ],
        [
          otherKey,
          {
            userMessageId: "message-other",
            fingerprint: "fingerprint-other",
            requestId: "request-other",
          },
        ],
      ]),
      promptDispatchClaims: new Map([
        [targetKey, new Set(["request-target"])],
        [otherKey, new Set(["request-other"])],
      ]),
    });
    usePromptDraftStore.getState().setDraftValue(
      codexInteractionDraftKey("interaction-target"),
      "answer",
      "target",
    );
    usePromptDraftStore.getState().setDraftValue(
      codexInteractionDraftKey("interaction-other"),
      "answer",
      "other",
    );

    useCodexStore.getState().clearSession(targetKey);

    const state = useCodexStore.getState();
    const sessionKeyedMaps = [
      "sessions",
      "sessionLoadingRevisions",
      "attachments",
      "draftText",
      "draftMentions",
      "messageQueue",
      "selectedModel",
      "selectedMode",
      "selectedReasoningEffort",
      "fastMode",
      "sessionPhase",
      "pendingApprovals",
      "pendingInteractions",
      "contextUsage",
      "unconfirmedDispatches",
      "promptDispatchClaims",
    ] as const;
    for (const field of sessionKeyedMaps) {
      expect(state[field].has(targetKey), `${field} should remove target`).toBe(false);
      expect(state[field].has(otherKey), `${field} should preserve other tab`).toBe(true);
    }
    expect(
      usePromptDraftStore.getState().drafts.has(
        codexInteractionDraftKey("interaction-target"),
      ),
    ).toBe(false);
    expect(
      usePromptDraftStore.getState().drafts.has(
        codexInteractionDraftKey("interaction-other"),
      ),
    ).toBe(true);
  });
});

describe("codexStore cleanup and queue helpers", () => {
  beforeEach(() => {
    resetCodexStore();
  });

  test("clearEnvironment removes only the targeted environment's tab-scoped state", () => {
    const sessionKeyA = createSessionKey("env-1", "tab-1");
    const sessionKeyB = createSessionKey("env-2", "tab-1");
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
    store.setSessionPhase(sessionKeyA, "recovering");
    store.setSessionPhase(sessionKeyB, "running");
    store.setUnconfirmedDispatch(sessionKeyA, {
      userMessageId: "message-a",
      fingerprint: "fingerprint-a",
      requestId: "request-a",
    });
    store.setUnconfirmedDispatch(sessionKeyB, {
      userMessageId: "message-b",
      fingerprint: "fingerprint-b",
      requestId: "request-b",
    });
    store.setDraftText(sessionKeyA, "draft");
    store.addAttachment(sessionKeyA, {
      id: "att-a",
      type: "image",
      path: "/workspace/a.png",
      name: "a.png",
    });
    seedQueuedPrompt(store, sessionKeyA, {
      id: "queue-a",
      text: "queued",
      attachments: [],
      model: "gpt-5",
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });
    store.setSlashCommands("env-1", [{ name: "/fix", source: "prompt" }]);
    store.setSlashCommands("env-2", [{ name: "/keep", source: "builtin" }]);

    store.clearEnvironment("env-1");

    expect(store.getSession(sessionKeyA)).toBeUndefined();
    expect(store.getSession(sessionKeyB)?.sessionId).toBe("session-b");
    expect(
      useCodexStore.getState().sessionLoadingRevisions.has(sessionKeyA),
    ).toBe(false);
    expect(
      useCodexStore.getState().sessionLoadingRevisions.has(sessionKeyB),
    ).toBe(true);
    expect(store.getDraftText(sessionKeyA)).toBe("");
    expect(store.getAttachments(sessionKeyA)).toEqual([]);
    expect(store.getQueueLength(sessionKeyA)).toBe(0);
    expect(useCodexStore.getState().selectedModel.get(sessionKeyA)).toBeUndefined();
    expect(useCodexStore.getState().selectedModel.get(sessionKeyB)).toBe("gpt-4");
    expect(useCodexStore.getState().sessionPhase.get(sessionKeyA)).toBeUndefined();
    expect(useCodexStore.getState().sessionPhase.get(sessionKeyB)).toBe("running");
    expect(useCodexStore.getState().unconfirmedDispatches.get(sessionKeyA))
      .toBeUndefined();
    expect(useCodexStore.getState().unconfirmedDispatches.get(sessionKeyB))
      .toMatchObject({ requestId: "request-b" });
    expect(useCodexStore.getState().slashCommands.get("env-1")).toBeUndefined();
    expect(useCodexStore.getState().slashCommands.get("env-2")).toEqual([
      { name: "/keep", source: "builtin" },
    ]);
  });

  test("queue helpers remove items in FIFO order and preserve unrelated queues", () => {
    const queueA = createSessionKey("env-1", "tab-1");
    const queueB = createSessionKey("env-1", "tab-2");
    const store = useCodexStore.getState();

    seedQueuedPrompt(store, queueA, {
      id: "q-1",
      text: "first",
      attachments: [],
      model: "gpt-5",
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });
    seedQueuedPrompt(store, queueA, {
      id: "q-2",
      text: "second",
      attachments: [],
      model: "gpt-5",
      mode: "plan",
      reasoningEffort: "high",
      fastMode: false,
    });
    seedQueuedPrompt(store, queueB, {
      id: "q-3",
      text: "other-tab",
      attachments: [],
      model: "gpt-4",
      mode: "build",
      reasoningEffort: "low",
      fastMode: false,
    });

    expect(store.getQueuedMessages(queueA).map((item) => item.id)).toEqual([
      "q-1",
      "q-2",
    ]);

    store.setQueueProjection(queueA, []);

    expect(store.getQueueLength(queueA)).toBe(0);
    expect(store.getQueueLength(queueB)).toBe(1);
  });

  test("carries a queued prompt's idempotency key through the whole queue lifecycle", () => {
    // The key is the only thing stopping a drained-then-retried entry from
    // becoming two app-server turns, so it has to survive every hop.
    const store = useCodexStore.getState();
    seedQueuedPrompt(store, SESSION_KEY, {
      id: "entry-1",
      requestId: "request-1",
      text: "first",
      attachments: [],
      model: "gpt-5",
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });
    seedQueuedPrompt(store, SESSION_KEY, {
      id: "entry-2",
      requestId: "request-2",
      text: "second",
      attachments: [],
      model: "gpt-5",
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    expect(store.getQueuedMessages(SESSION_KEY).map((item) => item.requestId)).toEqual([
      "request-1",
      "request-2",
    ]);
    store.setQueueProjection(
      SESSION_KEY,
      store.getQueuedMessages(SESSION_KEY).slice(1),
    );
    expect(store.getQueuedMessages(SESSION_KEY).map((item) => item.requestId)).toEqual([
      "request-2",
    ]);

    const survivingKey = createSessionKey("env-2", "tab-1");
    seedQueuedPrompt(store, survivingKey, {
      id: "entry-3",
      requestId: "request-3",
      text: "other env",
      attachments: [],
      model: "gpt-5",
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    store.clearEnvironment("env-1");

    expect(useCodexStore.getState().messageQueue.get(SESSION_KEY)).toBeUndefined();
    expect(store.getQueuedMessages(survivingKey).map((item) => item.requestId)).toEqual([
      "request-3",
    ]);
  });
});

describe("codexStore selection defaults", () => {
  beforeEach(resetCodexStore);

  test("setModels falls back to the bundled catalog for an empty list", () => {
    // An empty catalog would leave the model picker unusable, so the bundled one
    // is the floor.
    useCodexStore.getState().setModels([{ id: "custom", name: "Custom" }]);
    expect(useCodexStore.getState().models.map((model) => model.id)).toEqual(["custom"]);

    useCodexStore.getState().setModels([]);
    expect(useCodexStore.getState().models).toEqual(CODEX_MODELS);
  });

  test("setSlashCommands drops the environment key when the bridge reports none", () => {
    const store = useCodexStore.getState();
    store.setSlashCommands("env-1", [{ name: "/fix", source: "prompt" }]);
    expect(useCodexStore.getState().slashCommands.has("env-1")).toBe(true);

    store.setSlashCommands("env-1", []);
    expect(useCodexStore.getState().slashCommands.has("env-1")).toBe(false);
  });

  test("setSelectedModel refuses an empty id and keeps the default", () => {
    const store = useCodexStore.getState();
    store.setSelectedModel(SESSION_KEY, "");
    expect(useCodexStore.getState().selectedModel.get(SESSION_KEY)).toBe(DEFAULT_CODEX_MODEL);
  });

  test("isFastMode defaults to off for a session that never set it", () => {
    // Fast mode changes what the next turn costs, so an unset tab must not
    // inherit anything.
    expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(false);
  });

  test("setFastMode toggles one tab without touching its siblings", () => {
    const otherKey = createSessionKey("env-1", "tab-2");
    const store = useCodexStore.getState();

    store.setFastMode(SESSION_KEY, true);
    expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(true);
    expect(useCodexStore.getState().isFastMode(otherKey)).toBe(false);

    store.setFastMode(otherKey, true);
    store.setFastMode(SESSION_KEY, false);
    // An explicit `false` is recorded, not deleted — the selector's default and a
    // deliberate opt-out read the same, but the map must still hold the choice.
    expect(useCodexStore.getState().fastMode.get(SESSION_KEY)).toBe(false);
    expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(false);
    expect(useCodexStore.getState().isFastMode(otherKey)).toBe(true);
  });

  test("clearEnvironment resets fast mode for that environment only", () => {
    const otherEnvKey = createSessionKey("env-2", "tab-1");
    const store = useCodexStore.getState();

    store.setFastMode(SESSION_KEY, true);
    store.setFastMode(otherEnvKey, true);

    store.clearEnvironment("env-1");

    expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(false);
    expect(useCodexStore.getState().isFastMode(otherEnvKey)).toBe(true);
  });
});

describe("codexStore session phases", () => {
  beforeEach(resetCodexStore);

  test("sets, replaces, and clears a phase without rerendering for identical values", () => {
    const store = useCodexStore.getState();
    store.setSessionPhase(SESSION_KEY, "cancelling");
    expect(useCodexStore.getState().sessionPhase.get(SESSION_KEY)).toBe("cancelling");

    const before = useCodexStore.getState().sessionPhase;
    store.setSessionPhase(SESSION_KEY, "cancelling");
    expect(useCodexStore.getState().sessionPhase).toBe(before);

    store.setSessionPhase(SESSION_KEY, "recovering");
    expect(useCodexStore.getState().sessionPhase.get(SESSION_KEY)).toBe("recovering");

    store.setSessionPhase(SESSION_KEY, undefined);
    expect(useCodexStore.getState().sessionPhase.has(SESSION_KEY)).toBe(false);
  });
});

describe("codexStore pending approvals", () => {
  const OTHER_KEY = createSessionKey("env-1", "tab-2");

  beforeEach(resetCodexStore);

  test("adds approvals in arrival order, scoped per session", () => {
    const store = useCodexStore.getState();
    store.addPendingApproval(SESSION_KEY, approval("apr-1"));
    store.addPendingApproval(SESSION_KEY, approval("apr-2"));
    store.addPendingApproval(OTHER_KEY, approval("apr-3"));

    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.map((a) => a.approvalId),
    ).toEqual(["apr-1", "apr-2"]);
    expect(
      useCodexStore.getState().pendingApprovals.get(OTHER_KEY)?.map((a) => a.approvalId),
    ).toEqual(["apr-3"]);
  });

  test("ignores a duplicate approval id", () => {
    // A replayed SSE frame can deliver the same approval twice; rendering two
    // cards for one request would let the user answer it twice.
    const store = useCodexStore.getState();
    store.addPendingApproval(SESSION_KEY, approval("apr-1"));
    const before = useCodexStore.getState().pendingApprovals;
    store.addPendingApproval(SESSION_KEY, approval("apr-1"));

    expect(useCodexStore.getState().pendingApprovals.get(SESSION_KEY)).toHaveLength(1);
    // Same object identity: a no-op must not trigger a rerender.
    expect(useCodexStore.getState().pendingApprovals).toBe(before);
  });

  test("removes by id and drops the key when the last one goes", () => {
    const store = useCodexStore.getState();
    store.addPendingApproval(SESSION_KEY, approval("apr-1"));
    store.addPendingApproval(SESSION_KEY, approval("apr-2"));

    store.removePendingApproval(SESSION_KEY, "apr-1");
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.map((a) => a.approvalId),
    ).toEqual(["apr-2"]);

    store.removePendingApproval(SESSION_KEY, "apr-2");
    expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false);
  });

  test("removing an unknown id is a no-op that does not rerender", () => {
    const store = useCodexStore.getState();
    store.addPendingApproval(SESSION_KEY, approval("apr-1"));
    const before = useCodexStore.getState().pendingApprovals;

    store.removePendingApproval(SESSION_KEY, "apr-missing");
    store.removePendingApproval("env-1:nonexistent", "apr-1");

    expect(useCodexStore.getState().pendingApprovals).toBe(before);
  });

  test("setPendingApprovals replaces the list — the rehydration path", () => {
    const store = useCodexStore.getState();
    store.addPendingApproval(SESSION_KEY, approval("stale-1"));

    // The bridge is authoritative: whatever it reports is the whole truth, so an
    // approval it no longer knows about must disappear.
    store.setPendingApprovals(SESSION_KEY, [approval("apr-9")]);
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.map((a) => a.approvalId),
    ).toEqual(["apr-9"]);

    store.setPendingApprovals(SESSION_KEY, []);
    expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false);
  });

  test("setPendingApprovals with an identical list does not rerender", () => {
    // Called on every reconcile, so an unchanged poll must be free.
    const store = useCodexStore.getState();
    store.setPendingApprovals(SESSION_KEY, [approval("apr-1"), approval("apr-2")]);
    const before = useCodexStore.getState().pendingApprovals;

    store.setPendingApprovals(SESSION_KEY, [approval("apr-1"), approval("apr-2")]);
    expect(useCodexStore.getState().pendingApprovals).toBe(before);

    // A reordering is a real change.
    store.setPendingApprovals(SESSION_KEY, [approval("apr-2"), approval("apr-1")]);
    expect(useCodexStore.getState().pendingApprovals).not.toBe(before);
  });

  test("an empty snapshot for a session with no approvals does not rerender", () => {
    // Reconcile calls this on every tick, so the common case must be free.
    const store = useCodexStore.getState();
    const before = useCodexStore.getState().pendingApprovals;

    store.setPendingApprovals(SESSION_KEY, []);
    expect(useCodexStore.getState().pendingApprovals).toBe(before);
  });

  test("adopts a refreshed deadline or command for the same approval ids", () => {
    // The short-circuit used to compare ids only, so a re-reported approval with a
    // moved `expiresAt` was discarded and the card counted down to a deadline the
    // bridge no longer held.
    const store = useCodexStore.getState();
    store.setPendingApprovals(SESSION_KEY, [approval("apr-1")]);

    store.setPendingApprovals(SESSION_KEY, [
      { ...approval("apr-1"), expiresAt: 900_000 },
    ]);
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.[0]?.expiresAt,
    ).toBe(900_000);

    store.setPendingApprovals(SESSION_KEY, [
      { ...approval("apr-1"), expiresAt: 900_000, command: "rm -rf build" },
    ]);
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.[0]?.command,
    ).toBe("rm -rf build");
  });

  test("treats a byte-identical permissions/file-change snapshot as unchanged", () => {
    // The contrast case for the payload tests below: every compared field —
    // including the nested `permissions` block and the whole `changes` list —
    // matches, so the reconcile poll must stay free.
    const store = useCodexStore.getState();
    const changes: CodexApprovalFileChange[] = [
      { path: "/workspace/a.ts", kind: "update" },
      { path: "/workspace/b.ts", kind: "add" },
    ];
    store.setPendingApprovals(SESSION_KEY, [
      permissionsApproval("apr-perms", { network: true, fileSystem: false }),
      fileChangeApproval("apr-files", changes),
    ]);
    const before = useCodexStore.getState().pendingApprovals;

    store.setPendingApprovals(SESSION_KEY, [
      permissionsApproval("apr-perms", { network: true, fileSystem: false }),
      fileChangeApproval("apr-files", [
        { path: "/workspace/a.ts", kind: "update" },
        { path: "/workspace/b.ts", kind: "add" },
      ]),
    ]);

    expect(useCodexStore.getState().pendingApprovals).toBe(before);
  });

  test("adopts a snapshot whose only change is permissions.network", () => {
    // Rendering the stale block would show the user a network grant they are not
    // actually being asked for.
    const store = useCodexStore.getState();
    store.setPendingApprovals(SESSION_KEY, [
      permissionsApproval("apr-perms", { network: false, fileSystem: true }),
    ]);
    const before = useCodexStore.getState().pendingApprovals;

    store.setPendingApprovals(SESSION_KEY, [
      permissionsApproval("apr-perms", { network: true, fileSystem: true }),
    ]);

    expect(useCodexStore.getState().pendingApprovals).not.toBe(before);
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.[0]?.permissions,
    ).toEqual({ network: true, fileSystem: true });
  });

  test("adopts a snapshot whose only change is permissions.fileSystem", () => {
    const store = useCodexStore.getState();
    store.setPendingApprovals(SESSION_KEY, [
      permissionsApproval("apr-perms", { network: true, fileSystem: false }),
    ]);
    const before = useCodexStore.getState().pendingApprovals;

    store.setPendingApprovals(SESSION_KEY, [
      permissionsApproval("apr-perms", { network: true, fileSystem: true }),
    ]);

    expect(useCodexStore.getState().pendingApprovals).not.toBe(before);
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.[0]?.permissions,
    ).toEqual({ network: true, fileSystem: true });
  });

  test("adopts a snapshot whose only change is actionable", () => {
    // `actionable` gates the Approve buttons and must fail closed. Discarding a
    // re-report that revoked it would leave the user approving a command the
    // bridge can no longer describe.
    const store = useCodexStore.getState();
    store.setPendingApprovals(SESSION_KEY, [
      { ...approval("apr-actionable"), actionable: true },
    ]);
    const before = useCodexStore.getState().pendingApprovals;

    store.setPendingApprovals(SESSION_KEY, [
      { ...approval("apr-actionable"), actionable: false },
    ]);

    expect(useCodexStore.getState().pendingApprovals).not.toBe(before);
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.[0]?.actionable,
    ).toBe(false);
  });

  test("adopts a snapshot whose changes list grew or shrank", () => {
    // A card showing one file for a two-file patch is the user approving less
    // than they think.
    const store = useCodexStore.getState();
    store.setPendingApprovals(SESSION_KEY, [
      fileChangeApproval("apr-files", [{ path: "/workspace/a.ts", kind: "update" }]),
    ]);
    const before = useCodexStore.getState().pendingApprovals;

    store.setPendingApprovals(SESSION_KEY, [
      fileChangeApproval("apr-files", [
        { path: "/workspace/a.ts", kind: "update" },
        { path: "/workspace/b.ts", kind: "add" },
      ]),
    ]);

    expect(useCodexStore.getState().pendingApprovals).not.toBe(before);
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.[0]?.changes,
    ).toHaveLength(2);

    const grown = useCodexStore.getState().pendingApprovals;
    store.setPendingApprovals(SESSION_KEY, [
      fileChangeApproval("apr-files", [{ path: "/workspace/a.ts", kind: "update" }]),
    ]);

    expect(useCodexStore.getState().pendingApprovals).not.toBe(grown);
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.[0]?.changes,
    ).toHaveLength(1);
  });

  test("adopts a snapshot whose changes differ only by path", () => {
    const store = useCodexStore.getState();
    store.setPendingApprovals(SESSION_KEY, [
      fileChangeApproval("apr-files", [
        { path: "/workspace/a.ts", kind: "update" },
        { path: "/workspace/b.ts", kind: "update" },
      ]),
    ]);
    const before = useCodexStore.getState().pendingApprovals;

    store.setPendingApprovals(SESSION_KEY, [
      fileChangeApproval("apr-files", [
        { path: "/workspace/a.ts", kind: "update" },
        { path: "/workspace/c.ts", kind: "update" },
      ]),
    ]);

    expect(useCodexStore.getState().pendingApprovals).not.toBe(before);
    expect(
      useCodexStore
        .getState()
        .pendingApprovals.get(SESSION_KEY)?.[0]
        ?.changes?.map((change) => change.path),
    ).toEqual(["/workspace/a.ts", "/workspace/c.ts"]);
  });

  test("adopts a snapshot whose changes differ only by kind", () => {
    // Same path, but `delete` instead of `update` is a materially different ask.
    const store = useCodexStore.getState();
    store.setPendingApprovals(SESSION_KEY, [
      fileChangeApproval("apr-files", [{ path: "/workspace/a.ts", kind: "update" }]),
    ]);
    const before = useCodexStore.getState().pendingApprovals;

    store.setPendingApprovals(SESSION_KEY, [
      fileChangeApproval("apr-files", [{ path: "/workspace/a.ts", kind: "delete" }]),
    ]);

    expect(useCodexStore.getState().pendingApprovals).not.toBe(before);
    expect(
      useCodexStore.getState().pendingApprovals.get(SESSION_KEY)?.[0]?.changes?.[0]?.kind,
    ).toBe("delete");
  });

  test("adopts permission, change, and actionability updates for the same approval id", () => {
    const store = useCodexStore.getState();
    const initial = {
      ...approval("apr-1"),
      kind: "permissions" as const,
      permissions: { network: false, fileSystem: false },
      changes: [{ path: "/workspace/a.ts", kind: "update" as const }],
    };
    store.setPendingApprovals(SESSION_KEY, [initial]);

    const before = useCodexStore.getState().pendingApprovals;
    store.setPendingApprovals(SESSION_KEY, [{
      ...initial,
      permissions: { network: true, fileSystem: false },
      changes: [{ path: "/workspace/a.ts", kind: "delete" }],
      actionable: false,
    }]);

    const state = useCodexStore.getState();
    expect(state.pendingApprovals).not.toBe(before);
    expect(state.pendingApprovals.get(SESSION_KEY)?.[0]).toMatchObject({
      permissions: { network: true, fileSystem: false },
      changes: [{ path: "/workspace/a.ts", kind: "delete" }],
      actionable: false,
    });
  });

  test("clearEnvironment drops approvals for that environment only", () => {
    const store = useCodexStore.getState();
    const otherEnvKey = createSessionKey("env-2", "tab-1");
    store.addPendingApproval(SESSION_KEY, approval("apr-1"));
    store.addPendingApproval(otherEnvKey, approval("apr-2"));

    store.clearEnvironment("env-1");

    expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false);
    expect(useCodexStore.getState().pendingApprovals.has(otherEnvKey)).toBe(true);
  });
});

describe("codexStore fast mode", () => {
  beforeEach(resetCodexStore);

  test("defaults off and reflects both enabled and disabled writes", () => {
    const store = useCodexStore.getState();
    expect(store.isFastMode(SESSION_KEY)).toBe(false);

    store.setFastMode(SESSION_KEY, true);
    expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(true);

    store.setFastMode(SESSION_KEY, false);
    expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(false);
  });
});

describe("codexStore pending interactions", () => {
  const OTHER_KEY = createSessionKey("env-1", "tab-2");

  beforeEach(resetCodexStore);

  test("adds interactions in arrival order, scoped per session", () => {
    const store = useCodexStore.getState();
    store.addPendingInteraction(SESSION_KEY, interaction("int-1"));
    store.addPendingInteraction(SESSION_KEY, interaction("int-2"));
    store.addPendingInteraction(OTHER_KEY, interaction("int-3"));

    expect(
      useCodexStore
        .getState()
        .pendingInteractions.get(SESSION_KEY)
        ?.map((entry) => entry.interactionId),
    ).toEqual(["int-1", "int-2"]);
    expect(
      useCodexStore
        .getState()
        .pendingInteractions.get(OTHER_KEY)
        ?.map((entry) => entry.interactionId),
    ).toEqual(["int-3"]);
  });

  test("ignores a duplicate interaction id", () => {
    // A replayed SSE frame can deliver the same interaction twice; two cards for
    // one request would let the user answer it twice.
    const store = useCodexStore.getState();
    store.addPendingInteraction(SESSION_KEY, interaction("int-1"));
    const before = useCodexStore.getState().pendingInteractions;

    store.addPendingInteraction(SESSION_KEY, interaction("int-1", { expiresAt: 999 }));

    expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY)).toHaveLength(1);
    // Same object identity: a no-op must not trigger a rerender.
    expect(useCodexStore.getState().pendingInteractions).toBe(before);
  });

  test("removes by id and drops the key when the last one goes", () => {
    const store = useCodexStore.getState();
    store.addPendingInteraction(SESSION_KEY, interaction("int-1"));
    store.addPendingInteraction(SESSION_KEY, interaction("int-2"));

    store.removePendingInteraction(SESSION_KEY, "int-1");
    expect(
      useCodexStore
        .getState()
        .pendingInteractions.get(SESSION_KEY)
        ?.map((entry) => entry.interactionId),
    ).toEqual(["int-2"]);

    store.removePendingInteraction(SESSION_KEY, "int-2");
    expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);
  });

  test("removing an unknown id is a no-op that does not rerender", () => {
    const store = useCodexStore.getState();
    store.addPendingInteraction(SESSION_KEY, interaction("int-1"));
    const before = useCodexStore.getState().pendingInteractions;

    store.removePendingInteraction(SESSION_KEY, "int-missing");
    store.removePendingInteraction("env-1:nonexistent", "int-1");

    expect(useCodexStore.getState().pendingInteractions).toBe(before);
  });

  test("setPendingInteractions replaces the list — the rehydration path", () => {
    const store = useCodexStore.getState();
    store.addPendingInteraction(SESSION_KEY, interaction("stale-1"));

    // The bridge is authoritative: an interaction it no longer knows about must
    // disappear, because nothing will ever resolve it.
    store.setPendingInteractions(SESSION_KEY, [interaction("int-9")]);
    expect(
      useCodexStore
        .getState()
        .pendingInteractions.get(SESSION_KEY)
        ?.map((entry) => entry.interactionId),
    ).toEqual(["int-9"]);

    store.setPendingInteractions(SESSION_KEY, []);
    expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);
  });

  test("an empty snapshot for a session with no interactions does not rerender", () => {
    // The component calls this on every reconcile tick, almost always with an
    // empty list. An unconditional `new Map(...)` here rerendered the whole tab
    // on every tick.
    const store = useCodexStore.getState();
    const before = useCodexStore.getState().pendingInteractions;

    store.setPendingInteractions(SESSION_KEY, []);
    expect(useCodexStore.getState().pendingInteractions).toBe(before);

    store.setPendingInteractions(SESSION_KEY, []);
    expect(useCodexStore.getState().pendingInteractions).toBe(before);
  });

  test("setPendingInteractions with an identical list does not rerender", () => {
    const store = useCodexStore.getState();
    store.setPendingInteractions(SESSION_KEY, [interaction("int-1"), interaction("int-2")]);
    const before = useCodexStore.getState().pendingInteractions;

    store.setPendingInteractions(SESSION_KEY, [interaction("int-1"), interaction("int-2")]);
    expect(useCodexStore.getState().pendingInteractions).toBe(before);

    // A reordering is a real change.
    store.setPendingInteractions(SESSION_KEY, [interaction("int-2"), interaction("int-1")]);
    expect(useCodexStore.getState().pendingInteractions).not.toBe(before);
  });

  test("adopts a refreshed deadline for the same interaction ids", () => {
    // Comparing ids alone would discard a re-reported interaction whose
    // `expiresAt` moved, leaving the card counting down to a deadline the bridge
    // no longer holds.
    const store = useCodexStore.getState();
    store.setPendingInteractions(SESSION_KEY, [interaction("int-1")]);

    store.setPendingInteractions(SESSION_KEY, [
      interaction("int-1", { expiresAt: 900_000 }),
    ]);

    expect(
      useCodexStore.getState().pendingInteractions.get(SESSION_KEY)?.[0]?.expiresAt,
    ).toBe(900_000);
  });

  test("a longer or shorter list is always a real change", () => {
    const store = useCodexStore.getState();
    store.setPendingInteractions(SESSION_KEY, [interaction("int-1")]);
    const before = useCodexStore.getState().pendingInteractions;

    store.setPendingInteractions(SESSION_KEY, [interaction("int-1"), interaction("int-2")]);
    expect(useCodexStore.getState().pendingInteractions).not.toBe(before);
    expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY)).toHaveLength(2);
  });

  test("clearEnvironment drops interactions for that environment only", () => {
    const store = useCodexStore.getState();
    const otherEnvKey = createSessionKey("env-2", "tab-1");
    store.addPendingInteraction(SESSION_KEY, interaction("int-1"));
    store.addPendingInteraction(otherEnvKey, interaction("int-2"));
    usePromptDraftStore.getState().setDraftValue(
      codexInteractionDraftKey("int-1"),
      "answer",
      "target",
    );
    usePromptDraftStore.getState().setDraftValue(
      codexInteractionDraftKey("int-2"),
      "answer",
      "other",
    );

    store.clearEnvironment("env-1");

    expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);
    expect(useCodexStore.getState().pendingInteractions.has(otherEnvKey)).toBe(true);
    expect(
      usePromptDraftStore.getState().drafts.has(
        codexInteractionDraftKey("int-1"),
      ),
    ).toBe(false);
    expect(
      usePromptDraftStore.getState().drafts.has(
        codexInteractionDraftKey("int-2"),
      ),
    ).toBe(true);
  });
});

describe("codexStore context usage", () => {
  beforeEach(resetCodexStore);

  const USAGE: ContextUsageSnapshot = {
    usedTokens: 12_500,
    totalTokens: 200_000,
    percentUsed: 6.25,
    modelId: "gpt-5-codex",
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
    reasoningTokens: 50,
    lastTurnTokens: 900,
    sessionTokens: 12_500,
    costUsd: 0.42,
    durationMs: 1_200,
    estimated: false,
    source: "provider",
    updatedAt: "2026-07-26T00:00:00.000Z",
    rateLimits: [{ label: "5h", usedPercent: 12 }],
    credits: { hasCredits: true, balance: "12.00" },
  };

  test("round-trips a full provider-exact snapshot", () => {
    const store = useCodexStore.getState();

    store.setContextUsage(SESSION_KEY, USAGE);

    expect(useCodexStore.getState().getContextUsage(SESSION_KEY)).toEqual(USAGE);
  });

  test("replaces rather than merges an earlier snapshot", () => {
    const store = useCodexStore.getState();
    store.setContextUsage(SESSION_KEY, USAGE);

    store.setContextUsage(SESSION_KEY, {
      usedTokens: 1,
      totalTokens: 2,
      percentUsed: 50,
    });

    // A stale `costUsd` surviving a replacement would show the user a cost from
    // a session that no longer exists.
    expect(useCodexStore.getState().getContextUsage(SESSION_KEY)).toEqual({
      usedTokens: 1,
      totalTokens: 2,
      percentUsed: 50,
    });
  });

  test("clears the snapshot when passed null", () => {
    const store = useCodexStore.getState();
    store.setContextUsage(SESSION_KEY, USAGE);

    store.setContextUsage(SESSION_KEY, null);

    expect(useCodexStore.getState().getContextUsage(SESSION_KEY)).toBeUndefined();
    expect(useCodexStore.getState().contextUsage.has(SESSION_KEY)).toBe(false);
  });

  test("is scoped per session", () => {
    const store = useCodexStore.getState();
    const otherKey = createSessionKey("env-1", "tab-2");

    store.setContextUsage(SESSION_KEY, USAGE);

    expect(useCodexStore.getState().getContextUsage(otherKey)).toBeUndefined();
  });

  test("clearEnvironment drops usage for that environment only", () => {
    const store = useCodexStore.getState();
    const otherEnvKey = createSessionKey("env-2", "tab-1");
    store.setContextUsage(SESSION_KEY, USAGE);
    store.setContextUsage(otherEnvKey, USAGE);

    store.clearEnvironment("env-1");

    expect(useCodexStore.getState().getContextUsage(SESSION_KEY)).toBeUndefined();
    expect(useCodexStore.getState().getContextUsage(otherEnvKey)).toEqual(USAGE);
  });
});

describe("no-op equality bails", () => {
  beforeEach(() => {
    resetCodexStore();
    useCodexStore.getState().setSession(SESSION_KEY, {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    });
  });

  test("setContextUsage with an equal snapshot keeps the same map identity", () => {
    const store = useCodexStore.getState();
    const usage: ContextUsageSnapshot = {
      usedTokens: 10,
      totalTokens: 100,
      percentUsed: 10,
      rateLimits: [],
    };
    store.setContextUsage(SESSION_KEY, usage);
    const before = useCodexStore.getState().contextUsage;

    // Fresh but value-identical object, as a poll would deliver.
    store.setContextUsage(SESSION_KEY, {
      usedTokens: 10,
      totalTokens: 100,
      percentUsed: 10,
      rateLimits: [],
    });

    expect(useCodexStore.getState().contextUsage).toBe(before);

    store.setContextUsage(SESSION_KEY, { ...usage, usedTokens: 11 });
    expect(useCodexStore.getState().contextUsage).not.toBe(before);
  });

  test("setContextUsage(null) with nothing stored is a no-op", () => {
    const before = useCodexStore.getState().contextUsage;
    useCodexStore.getState().setContextUsage(SESSION_KEY, null);
    expect(useCodexStore.getState().contextUsage).toBe(before);
  });

  test("setSlashCommands with an equal list keeps the same map identity", () => {
    const store = useCodexStore.getState();
    store.setSlashCommands("env-1", [
      { name: "review", description: "Review", source: "prompt" },
    ]);
    const before = useCodexStore.getState().slashCommands;

    store.setSlashCommands("env-1", [
      { name: "review", description: "Review", source: "prompt" },
    ]);
    expect(useCodexStore.getState().slashCommands).toBe(before);

    store.setSlashCommands("env-1", []);
    expect(useCodexStore.getState().slashCommands).not.toBe(before);
    const cleared = useCodexStore.getState().slashCommands;

    // Clearing an already-empty entry is also a no-op.
    store.setSlashCommands("env-1", []);
    expect(useCodexStore.getState().slashCommands).toBe(cleared);
  });

  test("setMessages with a value-identical snapshot preserves state and message identities", () => {
    const store = useCodexStore.getState();
    const serverMessage = {
      id: "server-1",
      role: "user" as const,
      content: "hello",
      parts: [{ type: "text" as const, content: "hello" }],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    store.setMessages(SESSION_KEY, [serverMessage]);
    const sessionBefore = useCodexStore.getState().sessions.get(SESSION_KEY);
    const messagesBefore = sessionBefore?.messages;

    // A fresh snapshot with new object identities but identical content.
    store.setMessages(SESSION_KEY, [
      {
        id: "server-1",
        role: "user",
        content: "hello",
        parts: [{ type: "text", content: "hello" }],
        createdAt: "2026-04-15T10:00:00.000Z",
      },
    ]);

    const sessionAfter = useCodexStore.getState().sessions.get(SESSION_KEY);
    expect(sessionAfter).toBe(sessionBefore!);
    expect(sessionAfter?.messages).toBe(messagesBefore!);
  });

  test("setMessages reuses existing objects for unchanged messages when one message changes", () => {
    const store = useCodexStore.getState();
    store.setMessages(SESSION_KEY, [
      {
        id: "server-1",
        role: "user",
        content: "hello",
        parts: [{ type: "text", content: "hello" }],
        createdAt: "2026-04-15T10:00:00.000Z",
      },
      {
        id: "server-2",
        role: "assistant",
        content: "streaming",
        parts: [{ type: "text", content: "streaming" }],
        createdAt: "2026-04-15T10:00:01.000Z",
      },
    ]);
    const before = useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];

    store.setMessages(SESSION_KEY, [
      {
        id: "server-1",
        role: "user",
        content: "hello",
        parts: [{ type: "text", content: "hello" }],
        createdAt: "2026-04-15T10:00:00.000Z",
      },
      {
        id: "server-2",
        role: "assistant",
        content: "streaming more",
        parts: [{ type: "text", content: "streaming more" }],
        createdAt: "2026-04-15T10:00:01.000Z",
      },
    ]);

    const after = useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
    expect(after).toHaveLength(2);
    // Unchanged message keeps its identity; changed one is replaced.
    expect(after[0]).toBe(before[0]!);
    expect(after[1]).not.toBe(before[1]!);
    expect(after[1]?.content).toBe("streaming more");
  });
});
