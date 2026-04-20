import { create } from "zustand";
import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  type ClaudeMessage,
  type ClaudeModel,
  type ClaudeClient,
  type ClaudeQuestionRequest,
  type ClaudePlanApprovalRequest,
  type ClaudeEvent,
  type SessionInitData,
  type ClaudeSessionKey,
  type ClaudeSdkSessionId,
  type ClaudeEffortLevel,
} from "@/lib/claude-client";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import { createSessionKey } from "@/lib/utils";
import {
  createNativeChatStoreSlice,
  pruneSessionKeyedMap,
  type NativeChatStoreSlice,
  type NativeServerStatus,
  type NativeSessionState,
} from "./createNativeChatStore";

/**
 * Creates a unique session key for Claude sessions.
 * Re-exported from utils for backwards compatibility.
 */
export const createClaudeSessionKey = createSessionKey;

export type { ClaudeSessionKey, ClaudeSdkSessionId, ClaudeEffortLevel };

/** Shared event subscription state per environment */
export interface ClaudeEventSubscriptionState {
  abortController: AbortController;
  stream: AsyncIterable<ClaudeEvent> | null;
  isActive: boolean;
}

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

interface ClaudeState extends ClaudeChatSlice {
  // Agent-specific state
  models: ClaudeModel[];
  eventSubscriptions: Map<string, ClaudeEventSubscriptionState>;
  isComposing: Map<ClaudeSessionKey, boolean>;
  effort: Map<ClaudeSessionKey, ClaudeEffortLevel>;
  planMode: Map<ClaudeSessionKey, boolean>;
  selectedModel: Map<ClaudeSessionKey, string>;
  sessionInitData: Map<string, SessionInitData>;
  contextUsage: Map<ClaudeSessionKey, ContextUsageSnapshot>;
  pendingQuestions: Map<string, ClaudeQuestionRequest>;
  pendingPlanApprovals: Map<string, ClaudePlanApprovalRequest>;

  // Agent-specific actions
  setModels: (models: ClaudeModel[]) => void;
  setSelectedModel: (sessionKey: ClaudeSessionKey, modelId: string) => void;
  setComposing: (sessionKey: ClaudeSessionKey, isComposing: boolean) => void;
  setEffort: (sessionKey: ClaudeSessionKey, effort: ClaudeEffortLevel) => void;
  setPlanMode: (sessionKey: ClaudeSessionKey, enabled: boolean) => void;
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

  getOrCreateEventSubscription: (
    environmentId: string,
  ) => ClaudeEventSubscriptionState | null;
  setEventStream: (
    environmentId: string,
    stream: AsyncIterable<ClaudeEvent> | null,
  ) => void;
  closeEventSubscription: (environmentId: string) => void;
  hasActiveEventSubscription: (environmentId: string) => boolean;

  // Selectors
  getSelectedModel: (sessionKey: ClaudeSessionKey) => string | undefined;
  isComposingFor: (sessionKey: ClaudeSessionKey) => boolean;
  getEffort: (sessionKey: ClaudeSessionKey) => ClaudeEffortLevel;
  isPlanMode: (sessionKey: ClaudeSessionKey) => boolean;
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

  // Agent-specific state
  models: [],
  eventSubscriptions: new Map(),
  isComposing: new Map(),
  effort: new Map(),
  planMode: new Map(),
  selectedModel: new Map(),
  sessionInitData: new Map(),
  contextUsage: new Map(),
  pendingQuestions: new Map(),
  pendingPlanApprovals: new Map(),

  // Agent-specific actions
  setModels: (models) => set({ models }),

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
    // First close the event subscription if it exists
    const subscription = get().eventSubscriptions.get(environmentId);
    if (subscription) {
      console.log(
        "[claudeStore] Closing event subscription during environment cleanup:",
        environmentId,
      );
      subscription.abortController.abort();
      if (
        subscription.stream &&
        Symbol.asyncIterator in subscription.stream
      ) {
        const iterator = subscription.stream[Symbol.asyncIterator]();
        if (iterator.return) {
          iterator.return().catch(() => {});
        }
      }
    }

    set((state) => {
      const nextServerStatus = new Map(state.serverStatus);
      const nextClients = new Map(state.clients);
      const nextEventSubscriptions = new Map(state.eventSubscriptions);
      const nextSessionInitData = new Map(state.sessionInitData);

      nextServerStatus.delete(environmentId);
      nextClients.delete(environmentId);
      nextEventSubscriptions.delete(environmentId);
      nextSessionInitData.delete(environmentId);

      const prefix = `env-${environmentId}:`;

      // Collect session IDs for pending question cleanup before pruning sessions
      const sessionIdsToCleanup: string[] = [];
      for (const [key, session] of state.sessions) {
        if (key.startsWith(prefix)) {
          sessionIdsToCleanup.push(session.sessionId);
        }
      }

      const nextPendingQuestions = new Map(state.pendingQuestions);
      const nextPendingPlanApprovals = new Map(state.pendingPlanApprovals);
      for (const [requestId, question] of nextPendingQuestions) {
        if (sessionIdsToCleanup.includes(question.sessionId)) {
          nextPendingQuestions.delete(requestId);
        }
      }
      for (const [requestId, approval] of nextPendingPlanApprovals) {
        if (sessionIdsToCleanup.includes(approval.sessionId)) {
          nextPendingPlanApprovals.delete(requestId);
        }
      }

      return {
        serverStatus: nextServerStatus,
        sessions: pruneSessionKeyedMap(state.sessions, prefix),
        clients: nextClients,
        selectedModel: pruneSessionKeyedMap(state.selectedModel, prefix),
        attachments: pruneSessionKeyedMap(state.attachments, prefix),
        draftText: pruneSessionKeyedMap(state.draftText, prefix),
        draftMentions: pruneSessionKeyedMap(state.draftMentions, prefix),
        isComposing: pruneSessionKeyedMap(state.isComposing, prefix),
        effort: pruneSessionKeyedMap(state.effort, prefix),
        planMode: pruneSessionKeyedMap(state.planMode, prefix),
        messageQueue: pruneSessionKeyedMap(state.messageQueue, prefix),
        contextUsage: pruneSessionKeyedMap(state.contextUsage, prefix),
        pendingQuestions: nextPendingQuestions,
        pendingPlanApprovals: nextPendingPlanApprovals,
        eventSubscriptions: nextEventSubscriptions,
        sessionInitData: nextSessionInitData,
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

  getOrCreateEventSubscription: (environmentId) => {
    const state = get();
    const existing = state.eventSubscriptions.get(environmentId);

    if (existing && existing.isActive) {
      console.log(
        "[claudeStore] Reusing existing event subscription for environment:",
        environmentId,
      );
      return existing;
    }

    console.log(
      "[claudeStore] Creating new event subscription for environment:",
      environmentId,
    );
    const newSubscription: ClaudeEventSubscriptionState = {
      abortController: new AbortController(),
      stream: null,
      isActive: true,
    };

    const next = new Map(state.eventSubscriptions);
    next.set(environmentId, newSubscription);
    set({ eventSubscriptions: next });

    return newSubscription;
  },

  setEventStream: (environmentId, stream) =>
    set((state) => {
      const subscription = state.eventSubscriptions.get(environmentId);
      if (!subscription) return state;
      const next = new Map(state.eventSubscriptions);
      const isActive = stream !== null;
      next.set(environmentId, { ...subscription, stream, isActive });
      return { eventSubscriptions: next };
    }),

  closeEventSubscription: (environmentId) => {
    const state = get();
    const subscription = state.eventSubscriptions.get(environmentId);
    if (!subscription) return;

    console.log(
      "[claudeStore] Closing event subscription for environment:",
      environmentId,
    );

    subscription.abortController.abort();

    if (subscription.stream && Symbol.asyncIterator in subscription.stream) {
      const iterator = subscription.stream[Symbol.asyncIterator]();
      if (iterator.return) {
        iterator.return().catch(() => {});
      }
    }

    const next = new Map(state.eventSubscriptions);
    next.delete(environmentId);
    set({ eventSubscriptions: next });
  },

  hasActiveEventSubscription: (environmentId) => {
    const subscription = get().eventSubscriptions.get(environmentId);
    return subscription?.isActive ?? false;
  },

  // Selectors
  getSelectedModel: (sessionKey) => get().selectedModel.get(sessionKey),
  isComposingFor: (sessionKey) => get().isComposing.get(sessionKey) ?? false,
  // Default to "high" effort if not explicitly set
  getEffort: (sessionKey) => get().effort.get(sessionKey) ?? "high",
  // Default to false (plan mode disabled) - uses bypassPermissions by default
  isPlanMode: (sessionKey) => get().planMode.get(sessionKey) ?? false,
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
