import { create } from "zustand";
import {
  applyClaudeMessagePatch,
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  type ClaudeMessage,
  type ClaudeMessagePatch,
  type ClaudeModel,
  type ClaudeClient,
  type ClaudeQuestionRequest,
  type ClaudePlanApprovalRequest,
  type ClaudeEvent,
  type SessionInitData,
  type ClaudeSessionKey,
  type ClaudeSdkSessionId,
  type ClaudeEffortLevel,
  type ClaudeModelCatalogSnapshot,
  type ClaudeBackgroundTask,
} from "@/lib/claude-client";
import type {
  AgentRateLimitWindow,
  ContextUsageSnapshot,
} from "@/lib/context-usage";
import {
  claudePlanApprovalDraftKey,
  claudeQuestionDraftKey,
  usePromptDraftStore,
} from "./promptDraftStore";
import {
  buildClearEnvironmentPatch,
  buildClearSessionPatch,
  createEventSubscriptionSlice,
  createNativeChatStoreSlice,
  sessionKeyPrefixFor,
  teardownEventSubscription,
  type NativeChatStoreSlice,
  type NativeEventSubscriptionSlice,
  type NativeEventSubscriptionState,
  type NativeServerStatus,
  type NativeSessionState,
} from "./createNativeChatStore";

export type { ClaudeSessionKey, ClaudeSdkSessionId, ClaudeEffortLevel };

/** Shared event subscription state per environment */
export type ClaudeEventSubscriptionState =
  NativeEventSubscriptionState<ClaudeEvent>;

export type ClaudeServerStatus = NativeServerStatus;
export type ClaudeSessionState = NativeSessionState<ClaudeMessage>;

export interface ClaudeAttachment {
  id: string;
  type: "file" | "image";
  path: string;
  previewUrl?: string;
  name: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ClaudeAttachment[];
  effort: ClaudeEffortLevel;
  planModeEnabled: boolean;
  fastModeEnabled: boolean;
}

/**
 * Preserve client-only Claude messages (errors and system messages like
 * compact notifications) when applying a server fetch. These messages exist
 * only on the client and would be lost otherwise. Insertion is timestamp-based
 * so they sit in the right place in the history.
 */
function mergeClaudeMessagesPreservingClientOnly(
  existing: ClaudeMessage[],
  incoming: ClaudeMessage[],
): ClaudeMessage[] {
  const existingClientMessages = existing.filter(
    (m) =>
      m.id.startsWith(ERROR_MESSAGE_PREFIX) ||
      m.id.startsWith(SYSTEM_MESSAGE_PREFIX),
  );
  if (existingClientMessages.length === 0) return incoming;

  const merged = [...incoming];
  for (const clientMsg of existingClientMessages) {
    const clientTime = new Date(clientMsg.timestamp || 0).getTime();
    let insertIndex = merged.length;
    for (let i = merged.length - 1; i >= 0; i--) {
      const msg = merged[i];
      if (!msg) continue;
      const msgTime = new Date(msg.timestamp || 0).getTime();
      if (msgTime <= clientTime) {
        insertIndex = i + 1;
        break;
      }
      if (i === 0 && msgTime > clientTime) {
        insertIndex = 0;
      }
    }
    merged.splice(insertIndex, 0, clientMsg);
  }
  return merged;
}

type ClaudeChatSlice = NativeChatStoreSlice<
  ClaudeClient,
  ClaudeMessage,
  ClaudeAttachment,
  QueuedMessage
>;

interface ClaudeState
  extends ClaudeChatSlice,
    NativeEventSubscriptionSlice<ClaudeEvent> {
  // Agent-specific state
  models: ClaudeModel[];
  modelCatalogs: Map<string, ClaudeModelCatalogSnapshot>;
  isComposing: Map<ClaudeSessionKey, boolean>;
  effort: Map<ClaudeSessionKey, ClaudeEffortLevel>;
  planMode: Map<ClaudeSessionKey, boolean>;
  fastMode: Map<ClaudeSessionKey, boolean>;
  selectedModel: Map<ClaudeSessionKey, string>;
  sessionInitData: Map<string, SessionInitData>;
  contextUsage: Map<ClaudeSessionKey, ContextUsageSnapshot>;
  /**
   * Authoritative provider quota windows are independent of context usage.
   * Claude can report them before the first token snapshot exists.
   *
   * An empty array is retained deliberately: it is an authoritative clear and
   * must override stale limits nested in an older context snapshot.
   */
  rateLimits: Map<ClaudeSessionKey, AgentRateLimitWindow[]>;
  selectedAgent: Map<ClaudeSessionKey, string>;
  includeLocalSettings: Map<ClaudeSessionKey, boolean>;
  promptSuggestionOptIn: Map<ClaudeSessionKey, boolean>;
  promptSuggestions: Map<ClaudeSessionKey, string>;
  /**
   * The suggestion each session has already used or dismissed.
   *
   * The bridge clears `session.promptSuggestion` only when the *next* prompt
   * runs, and `GET /session/:id` replays it on every mount, restore, reconnect
   * and `session.idle`. This latch has to outlive the component or the chip a
   * user just consumed comes back the moment they switch environments and
   * return. The exact string is remembered rather than a boolean so a
   * genuinely new suggestion still gets through.
   */
  dismissedPromptSuggestions: Map<ClaudeSessionKey, string>;
  backgroundTasks: Map<ClaudeSessionKey, Record<string, ClaudeBackgroundTask>>;
  /**
   * Monotonic lifecycle revision for each tab's authoritative task snapshots.
   *
   * The task map deliberately deletes empty records, so comparing its value
   * cannot detect an absent → present → absent sequence while a REST refresh
   * is in flight. This revision changes for every task snapshot, including an
   * explicit empty snapshot, and lets refresh reconciliation detect that ABA.
   */
  backgroundTaskRevisions: Map<ClaudeSessionKey, number>;
  pendingQuestions: Map<string, ClaudeQuestionRequest>;
  pendingPlanApprovals: Map<string, ClaudePlanApprovalRequest>;

  /**
   * Apply an incremental part patch to an already-stored assistant message.
   *
   * Returns false when the patch cannot be applied — this session holds no
   * message with that id (a tab that mounted mid-turn), the stored copy is not
   * at `patch.revision - 1` (a subscription that reconnected, or a refetch
   * that landed out of order), or the payload is malformed. The caller must
   * then fall back to an authoritative refetch; a patch addressed by index
   * cannot reconstruct frames the store never received.
   */
  patchMessage: (sessionKey: ClaudeSessionKey, patch: ClaudeMessagePatch) => boolean;

  // Agent-specific actions
  setModels: (models: ClaudeModel[], environmentId?: string) => void;
  setModelCatalog: (catalog: ClaudeModelCatalogSnapshot) => void;
  setSelectedModel: (sessionKey: ClaudeSessionKey, modelId: string) => void;
  setComposing: (sessionKey: ClaudeSessionKey, isComposing: boolean) => void;
  setEffort: (sessionKey: ClaudeSessionKey, effort: ClaudeEffortLevel) => void;
  setPlanMode: (sessionKey: ClaudeSessionKey, enabled: boolean) => void;
  setFastMode: (sessionKey: ClaudeSessionKey, enabled: boolean) => void;
  setSessionInitData: (
    environmentId: string,
    initData: SessionInitData | null,
  ) => void;
  setContextUsage: (
    sessionKey: ClaudeSessionKey,
    usage: ContextUsageSnapshot | null,
  ) => void;
  setRateLimits: (
    sessionKey: ClaudeSessionKey,
    rateLimits: AgentRateLimitWindow[] | null,
  ) => void;
  setSelectedAgent: (sessionKey: ClaudeSessionKey, agent: string | undefined) => void;
  setIncludeLocalSettings: (sessionKey: ClaudeSessionKey, enabled: boolean) => void;
  setPromptSuggestionOptIn: (sessionKey: ClaudeSessionKey, enabled: boolean) => void;
  setPromptSuggestion: (
    sessionKey: ClaudeSessionKey,
    suggestion: string | undefined,
  ) => void;
  setDismissedPromptSuggestion: (
    sessionKey: ClaudeSessionKey,
    suggestion: string | undefined,
  ) => void;
  setBackgroundTasks: (
    sessionKey: ClaudeSessionKey,
    tasks: Record<string, ClaudeBackgroundTask>,
  ) => void;
  /**
   * Bind a tab to a different provider session and discard metadata that belongs
   * to the old provider identity in the same store transaction.
   */
  replaceSessionIdentity: (
    sessionKey: ClaudeSessionKey,
    session: ClaudeSessionState,
  ) => void;
  clearEnvironment: (environmentId: string) => void;
  /** Drop every session-keyed entry for one closed tab. */
  clearSession: (sessionKey: string) => void;

  addPendingQuestion: (question: ClaudeQuestionRequest) => void;
  removePendingQuestion: (requestId: string) => void;
  addPendingPlanApproval: (approval: ClaudePlanApprovalRequest) => void;
  removePendingPlanApproval: (requestId: string) => void;

  // Selectors
  getSelectedModel: (sessionKey: ClaudeSessionKey) => string | undefined;
  getModels: (environmentId: string) => ClaudeModel[];
  getModelCatalog: (
    environmentId: string,
  ) => ClaudeModelCatalogSnapshot | undefined;
  isComposingFor: (sessionKey: ClaudeSessionKey) => boolean;
  getEffort: (sessionKey: ClaudeSessionKey) => ClaudeEffortLevel;
  isPlanMode: (sessionKey: ClaudeSessionKey) => boolean;
  isFastMode: (sessionKey: ClaudeSessionKey) => boolean;
  getSessionInitData: (environmentId: string) => SessionInitData | undefined;
  getContextUsage: (
    sessionKey: ClaudeSessionKey,
  ) => ContextUsageSnapshot | undefined;
  getRateLimits: (
    sessionKey: ClaudeSessionKey,
  ) => AgentRateLimitWindow[] | undefined;
  getDismissedPromptSuggestion: (
    sessionKey: ClaudeSessionKey,
  ) => string | undefined;
  getSelectedAgent: (sessionKey: ClaudeSessionKey) => string | undefined;
  includesLocalSettings: (sessionKey: ClaudeSessionKey) => boolean;
  getPendingQuestionsForSession: (
    sdkSessionId: ClaudeSdkSessionId,
  ) => ClaudeQuestionRequest[];
  getPendingQuestion: (requestId: string) => ClaudeQuestionRequest | undefined;
  getPendingPlanApprovalsForSession: (
    sdkSessionId: ClaudeSdkSessionId,
  ) => ClaudePlanApprovalRequest[];
  getPendingPlanApproval: (
    requestId: string,
  ) => ClaudePlanApprovalRequest | undefined;

  /**
   * Find the sessionKey (store Map key) for a given SDK session ID.
   * Useful when handling SSE events that include the SDK session ID but
   * need to update state keyed by sessionKey.
   */
  getSessionKeyBySdkSessionId: (
    sdkSessionId: ClaudeSdkSessionId,
  ) => ClaudeSessionKey | null;
}

/**
 * Every map keyed by sessionKey, shared by the environment and tab sweeps so
 * the two cannot drift. A new session-keyed map goes here or it leaks.
 */
const CLAUDE_SESSION_KEYED_MAPS = [
  "sessions",
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
  "selectedAgent",
  "includeLocalSettings",
  "promptSuggestionOptIn",
  "promptSuggestions",
  "dismissedPromptSuggestions",
  "backgroundTasks",
  "backgroundTaskRevisions",
] as const satisfies ReadonlyArray<keyof ClaudeState>;

export const useClaudeStore = create<ClaudeState>()((set, get, api) => ({
  ...createNativeChatStoreSlice<
    ClaudeClient,
    ClaudeMessage,
    ClaudeAttachment,
    QueuedMessage
  >({ mergeMessages: mergeClaudeMessagesPreservingClientOnly })(set, get, api),

  ...createEventSubscriptionSlice<ClaudeEvent>("claudeStore")(set, get, api),

  // Agent-specific state
  models: [],
  modelCatalogs: new Map(),
  isComposing: new Map(),
  effort: new Map(),
  planMode: new Map(),
  fastMode: new Map(),
  selectedModel: new Map(),
  sessionInitData: new Map(),
  contextUsage: new Map(),
  rateLimits: new Map(),
  selectedAgent: new Map(),
  includeLocalSettings: new Map(),
  promptSuggestionOptIn: new Map(),
  promptSuggestions: new Map(),
  dismissedPromptSuggestions: new Map(),
  backgroundTasks: new Map(),
  backgroundTaskRevisions: new Map(),
  pendingQuestions: new Map(),
  pendingPlanApprovals: new Map(),

  patchMessage: (sessionKey, patch) => {
    if (!patch?.messageId) return false;

    // Located, validated and applied in one synchronous `set`: reading the
    // message outside and mutating inside would let a refetch replace it in
    // between, and the patch would then be applied to a base nobody checked.
    let applied = false;
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;

      const index = session.messages.findIndex(
        (message) => message.id === patch.messageId,
      );
      const target = index === -1 ? undefined : session.messages[index];
      if (!target) return state;

      // Rejects a malformed payload and, crucially, a revision gap — see
      // `applyClaudeMessagePatch`. Either way the caller refetches.
      const patched = applyClaudeMessagePatch(target, patch);
      if (!patched) return state;

      const nextMessages = session.messages.slice();
      nextMessages[index] = patched;
      const next = new Map(state.sessions);
      next.set(sessionKey, { ...session, messages: nextMessages });
      applied = true;
      return { sessions: next };
    });

    return applied;
  },

  // Agent-specific actions
  setModels: (models, environmentId) =>
    set((state) => {
      if (!environmentId) return { models };
      const next = new Map(state.modelCatalogs);
      next.set(environmentId, {
        environmentId,
        models,
        source: "sdk",
        fetchedAt: new Date().toISOString(),
        stale: false,
      });
      return { modelCatalogs: next };
    }),

  setModelCatalog: (catalog) =>
    set((state) => {
      const next = new Map(state.modelCatalogs);
      next.set(catalog.environmentId, catalog);
      return { modelCatalogs: next };
    }),

  setSelectedModel: (sessionKey, modelId) =>
    set((state) => {
      const next = new Map(state.selectedModel);
      next.set(sessionKey, modelId);
      return { selectedModel: next };
    }),

  setComposing: (sessionKey, isComposing) =>
    set((state) => {
      const next = new Map(state.isComposing);
      next.set(sessionKey, isComposing);
      return { isComposing: next };
    }),

  setEffort: (sessionKey, effortLevel) =>
    set((state) => {
      const next = new Map(state.effort);
      next.set(sessionKey, effortLevel);
      return { effort: next };
    }),

  setPlanMode: (sessionKey, enabled) =>
    set((state) => {
      const next = new Map(state.planMode);
      next.set(sessionKey, enabled);
      return { planMode: next };
    }),

  setFastMode: (sessionKey, enabled) =>
    set((state) => {
      const next = new Map(state.fastMode);
      next.set(sessionKey, enabled);
      return { fastMode: next };
    }),

  setSessionInitData: (environmentId, initData) =>
    set((state) => {
      const next = new Map(state.sessionInitData);
      if (initData) {
        next.set(environmentId, initData);
      } else {
        next.delete(environmentId);
      }
      return { sessionInitData: next };
    }),

  setContextUsage: (sessionKey, usage) =>
    set((state) => {
      const next = new Map(state.contextUsage);
      if (usage) {
        next.set(sessionKey, usage);
      } else {
        next.delete(sessionKey);
      }
      if (usage?.rateLimits === undefined) {
        return { contextUsage: next };
      }

      // Exact usage frames can carry quota windows too. Synchronize them when
      // present, while a usage reading with no quota field leaves the latest
      // independent authoritative snapshot alone.
      const rateLimits = new Map(state.rateLimits);
      rateLimits.set(sessionKey, usage.rateLimits);
      return { contextUsage: next, rateLimits };
    }),

  setRateLimits: (sessionKey, rateLimits) =>
    set((state) => {
      const next = new Map(state.rateLimits);
      if (rateLimits) {
        next.set(sessionKey, rateLimits);
      } else {
        next.delete(sessionKey);
      }
      return { rateLimits: next };
    }),

  setSelectedAgent: (sessionKey, agent) =>
    set((state) => {
      const next = new Map(state.selectedAgent);
      if (agent) next.set(sessionKey, agent);
      else next.delete(sessionKey);
      return { selectedAgent: next };
    }),

  setIncludeLocalSettings: (sessionKey, enabled) =>
    set((state) => {
      const next = new Map(state.includeLocalSettings);
      if (enabled) next.set(sessionKey, true);
      else next.delete(sessionKey);
      return { includeLocalSettings: next };
    }),
  setPromptSuggestionOptIn: (sessionKey, enabled) =>
    set((state) => {
      const next = new Map(state.promptSuggestionOptIn);
      next.set(sessionKey, enabled);
      return { promptSuggestionOptIn: next };
    }),

  setPromptSuggestion: (sessionKey, suggestion) =>
    set((state) => {
      const next = new Map(state.promptSuggestions);
      if (suggestion) next.set(sessionKey, suggestion);
      else next.delete(sessionKey);
      return { promptSuggestions: next };
    }),

  setDismissedPromptSuggestion: (sessionKey, suggestion) =>
    set((state) => {
      const next = new Map(state.dismissedPromptSuggestions);
      if (suggestion) next.set(sessionKey, suggestion);
      else next.delete(sessionKey);
      return { dismissedPromptSuggestions: next };
    }),

  setBackgroundTasks: (sessionKey, tasks) =>
    set((state) => {
      const next = new Map(state.backgroundTasks);
      const revisions = new Map(state.backgroundTaskRevisions);
      if (Object.keys(tasks).length > 0) next.set(sessionKey, tasks);
      else next.delete(sessionKey);
      revisions.set(
        sessionKey,
        (state.backgroundTaskRevisions.get(sessionKey) ?? 0) + 1,
      );
      return {
        backgroundTasks: next,
        backgroundTaskRevisions: revisions,
      };
    }),

  replaceSessionIdentity: (sessionKey, session) =>
    set((state) => {
      const previousSessionId = state.sessions.get(sessionKey)?.sessionId;
      const sessions = new Map(state.sessions);
      sessions.set(sessionKey, session);

      const withoutSessionKey = <T>(values: Map<string, T>) => {
        const next = new Map(values);
        next.delete(sessionKey);
        return next;
      };

      const pendingQuestions = new Map(state.pendingQuestions);
      const pendingPlanApprovals = new Map(state.pendingPlanApprovals);
      if (previousSessionId) {
        for (const [requestId, question] of pendingQuestions) {
          if (question.sessionId === previousSessionId) {
            pendingQuestions.delete(requestId);
          }
        }
        for (const [requestId, approval] of pendingPlanApprovals) {
          if (approval.sessionId === previousSessionId) {
            pendingPlanApprovals.delete(requestId);
          }
        }
      }

      return {
        sessions,
        contextUsage: withoutSessionKey(state.contextUsage),
        rateLimits: withoutSessionKey(state.rateLimits),
        promptSuggestions: withoutSessionKey(state.promptSuggestions),
        dismissedPromptSuggestions: withoutSessionKey(
          state.dismissedPromptSuggestions,
        ),
        backgroundTasks: withoutSessionKey(state.backgroundTasks),
        backgroundTaskRevisions: withoutSessionKey(
          state.backgroundTaskRevisions,
        ),
        pendingQuestions,
        pendingPlanApprovals,
      };
    }),

  clearEnvironment: (environmentId) => {
    // Abort before dropping the map entry — losing the reference without
    // returning the iterator leaks the generator.
    const subscription = get().eventSubscriptions.get(environmentId);
    if (subscription) {
      console.log(
        "[claudeStore] Closing event subscription during environment cleanup:",
        environmentId,
      );
      teardownEventSubscription(subscription);
    }

    // Draft keys for the requests the sweep below removes; cleared after the
    // set so the store update itself stays a pure state computation.
    const sweptDraftKeys: string[] = [];

    set((state) => {
      const prefix = sessionKeyPrefixFor(environmentId);

      // Collect session IDs before pruning so pending requests can be swept.
      const sessionIdsToCleanup = new Set<string>();
      for (const [key, session] of state.sessions) {
        if (key.startsWith(prefix)) {
          sessionIdsToCleanup.add(session.sessionId);
        }
      }

      const nextPendingQuestions = new Map(state.pendingQuestions);
      const nextPendingPlanApprovals = new Map(state.pendingPlanApprovals);
      for (const [requestId, question] of nextPendingQuestions) {
        if (sessionIdsToCleanup.has(question.sessionId)) {
          nextPendingQuestions.delete(requestId);
          sweptDraftKeys.push(claudeQuestionDraftKey(requestId));
        }
      }
      for (const [requestId, approval] of nextPendingPlanApprovals) {
        if (sessionIdsToCleanup.has(approval.sessionId)) {
          nextPendingPlanApprovals.delete(requestId);
          sweptDraftKeys.push(claudePlanApprovalDraftKey(requestId));
        }
      }

      return {
        ...buildClearEnvironmentPatch(state, environmentId, {
          environmentKeyed: [
            "serverStatus",
            "clients",
            "eventSubscriptions",
            "sessionInitData",
            "modelCatalogs",
          ],
          sessionKeyed: CLAUDE_SESSION_KEYED_MAPS,
        }),
        // Keyed by requestId, so they need the session-id sweep above.
        pendingQuestions: nextPendingQuestions,
        pendingPlanApprovals: nextPendingPlanApprovals,
      };
    });

    usePromptDraftStore.getState().clearDrafts(sweptDraftKeys);
  },

  clearSession: (sessionKey) => {
    const sweptDraftKeys: string[] = [];
    set((state) => {
      const session = state.sessions.get(sessionKey);
      const patch = buildClearSessionPatch(
        state,
        sessionKey,
        CLAUDE_SESSION_KEYED_MAPS,
      );
      if (!session?.sessionId) return patch;

      // Pending requests are keyed by requestId, so they need a sweep by the
      // session id this tab owned rather than by its session key.
      const pendingQuestions = new Map(state.pendingQuestions);
      for (const [requestId, question] of pendingQuestions) {
        if (question.sessionId === session.sessionId) {
          pendingQuestions.delete(requestId);
          sweptDraftKeys.push(claudeQuestionDraftKey(requestId));
        }
      }
      const pendingPlanApprovals = new Map(state.pendingPlanApprovals);
      for (const [requestId, approval] of pendingPlanApprovals) {
        if (approval.sessionId === session.sessionId) {
          pendingPlanApprovals.delete(requestId);
          sweptDraftKeys.push(claudePlanApprovalDraftKey(requestId));
        }
      }
      return { ...patch, pendingQuestions, pendingPlanApprovals };
    });
    usePromptDraftStore.getState().clearDrafts(sweptDraftKeys);
  },

  addPendingQuestion: (question) =>
    set((state) => {
      const next = new Map(state.pendingQuestions);
      next.set(question.id, question);
      return { pendingQuestions: next };
    }),

  removePendingQuestion: (requestId) => {
    set((state) => {
      const next = new Map(state.pendingQuestions);
      next.delete(requestId);
      return { pendingQuestions: next };
    });
    // The request is resolved (answered, dismissed, or withdrawn), so the
    // in-progress answer draft must not survive to a future request that
    // happens to reuse this id.
    usePromptDraftStore.getState().clearDraft(claudeQuestionDraftKey(requestId));
  },

  addPendingPlanApproval: (approval) =>
    set((state) => {
      const next = new Map(state.pendingPlanApprovals);
      next.set(approval.id, approval);
      return { pendingPlanApprovals: next };
    }),

  removePendingPlanApproval: (requestId) => {
    set((state) => {
      const next = new Map(state.pendingPlanApprovals);
      next.delete(requestId);
      return { pendingPlanApprovals: next };
    });
    // See removePendingQuestion: resolved requests drop their feedback draft.
    usePromptDraftStore
      .getState()
      .clearDraft(claudePlanApprovalDraftKey(requestId));
  },

  // Selectors
  getSelectedModel: (sessionKey) => get().selectedModel.get(sessionKey),
  getModels: (environmentId) =>
    get().modelCatalogs.get(environmentId)?.models ?? get().models,
  getModelCatalog: (environmentId) => get().modelCatalogs.get(environmentId),
  isComposingFor: (sessionKey) => get().isComposing.get(sessionKey) ?? false,
  // Default to "high" effort if not explicitly set
  getEffort: (sessionKey) => get().effort.get(sessionKey) ?? "high",
  // Default to false (plan mode disabled) - uses bypassPermissions by default
  isPlanMode: (sessionKey) => get().planMode.get(sessionKey) ?? false,
  // Default to false (fast mode disabled)
  isFastMode: (sessionKey) => get().fastMode.get(sessionKey) ?? false,
  getSessionInitData: (environmentId) =>
    get().sessionInitData.get(environmentId),
  getContextUsage: (sessionKey) => get().contextUsage.get(sessionKey),
  getRateLimits: (sessionKey) => get().rateLimits.get(sessionKey),
  getDismissedPromptSuggestion: (sessionKey) =>
    get().dismissedPromptSuggestions.get(sessionKey),
  getSelectedAgent: (sessionKey) => get().selectedAgent.get(sessionKey),
  includesLocalSettings: (sessionKey) =>
    get().includeLocalSettings.get(sessionKey) ?? false,

  getPendingQuestionsForSession: (sdkSessionId) => {
    const questions: ClaudeQuestionRequest[] = [];
    for (const question of get().pendingQuestions.values()) {
      if (question.sessionId === sdkSessionId) {
        questions.push(question);
      }
    }
    return questions;
  },

  getPendingQuestion: (requestId) => get().pendingQuestions.get(requestId),

  getPendingPlanApprovalsForSession: (sdkSessionId) => {
    const approvals: ClaudePlanApprovalRequest[] = [];
    for (const approval of get().pendingPlanApprovals.values()) {
      if (approval.sessionId === sdkSessionId) {
        approvals.push(approval);
      }
    }
    return approvals;
  },

  getPendingPlanApproval: (requestId) =>
    get().pendingPlanApprovals.get(requestId),

  getSessionKeyBySdkSessionId: (sdkSessionId) => {
    const sessions = get().sessions;
    for (const [sessionKey, sessionState] of sessions) {
      if (sessionState.sessionId === sdkSessionId) {
        return sessionKey;
      }
    }
    return null;
  },
}));
