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
} from "@/lib/claude-client";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import {
  buildClearEnvironmentPatch,
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
  clearEnvironment: (environmentId: string) => void;

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
      return { contextUsage: next };
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
        }
      }
      for (const [requestId, approval] of nextPendingPlanApprovals) {
        if (sessionIdsToCleanup.has(approval.sessionId)) {
          nextPendingPlanApprovals.delete(requestId);
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
          sessionKeyed: [
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
          ],
        }),
        // Keyed by requestId, so they need the session-id sweep above.
        pendingQuestions: nextPendingQuestions,
        pendingPlanApprovals: nextPendingPlanApprovals,
      };
    });
  },

  addPendingQuestion: (question) =>
    set((state) => {
      const next = new Map(state.pendingQuestions);
      next.set(question.id, question);
      return { pendingQuestions: next };
    }),

  removePendingQuestion: (requestId) =>
    set((state) => {
      const next = new Map(state.pendingQuestions);
      next.delete(requestId);
      return { pendingQuestions: next };
    }),

  addPendingPlanApproval: (approval) =>
    set((state) => {
      const next = new Map(state.pendingPlanApprovals);
      next.set(approval.id, approval);
      return { pendingPlanApprovals: next };
    }),

  removePendingPlanApproval: (requestId) =>
    set((state) => {
      const next = new Map(state.pendingPlanApprovals);
      next.delete(requestId);
      return { pendingPlanApprovals: next };
    }),

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
