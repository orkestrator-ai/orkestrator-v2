import { create } from "zustand";
import {
  type OpenCodeMessage,
  type OpenCodeModel,
  type OpenCodeSlashCommand,
  type OpenCodeConversationMode,
  type OpencodeClient,
  type QuestionRequest,
  type PermissionRequest,
  type OpenCodeEvent,
} from "@/lib/opencode-client";
import { mergeNativeMessagesPreservingClientOnly } from "@/lib/chat/client-only-messages";
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
 * Creates a unique session key for OpenCode sessions.
 * Re-exported from utils for backwards compatibility.
 */
export const createOpenCodeSessionKey = createSessionKey;

/** Shared event subscription state per environment */
export interface EventSubscriptionState {
  abortController: AbortController;
  stream: AsyncIterable<OpenCodeEvent> | null;
  isActive: boolean;
}

export type OpenCodeServerStatus = NativeServerStatus;
export type OpenCodeSessionState = NativeSessionState<OpenCodeMessage>;

export interface OpenCodeAttachment {
  id: string;
  type: "file" | "image";
  path: string;
  previewUrl?: string;
  name: string;
}

export interface OpenCodeQueuedMessage {
  id: string;
  text: string;
  attachments: OpenCodeAttachment[];
  model?: string;
  variant?: string;
  mode: OpenCodeConversationMode;
}

type OpenCodeChatSlice = NativeChatStoreSlice<
  OpencodeClient,
  OpenCodeMessage,
  OpenCodeAttachment,
  OpenCodeQueuedMessage
>;

interface OpenCodeState extends OpenCodeChatSlice {
  // Agent-specific state (per-environment)
  models: Map<string, OpenCodeModel[]>;
  slashCommands: Map<string, OpenCodeSlashCommand[]>;
  selectedModel: Map<string, string>;
  selectedVariant: Map<string, string>;
  isComposing: Map<string, boolean>;
  eventSubscriptions: Map<string, EventSubscriptionState>;

  // Agent-specific state (per-session)
  selectedMode: Map<string, OpenCodeConversationMode>;
  contextUsage: Map<string, ContextUsageSnapshot>;

  // Agent-specific state (per-request)
  pendingQuestions: Map<string, QuestionRequest>;
  pendingPermissions: Map<string, PermissionRequest>;

  // Agent-specific actions (per-environment)
  setModels: (environmentId: string, models: OpenCodeModel[]) => void;
  setSlashCommands: (
    environmentId: string,
    commands: OpenCodeSlashCommand[],
  ) => void;
  setSelectedModel: (environmentId: string, modelId: string) => void;
  setSelectedVariant: (
    environmentId: string,
    variant: string | undefined,
  ) => void;
  setComposing: (environmentId: string, isComposing: boolean) => void;

  // Agent-specific actions (per-session)
  setSelectedMode: (
    sessionKey: string,
    mode: OpenCodeConversationMode,
  ) => void;
  setContextUsage: (
    sessionKey: string,
    usage: ContextUsageSnapshot | null,
  ) => void;

  // Agent-specific actions (per-request)
  addPendingQuestion: (question: QuestionRequest) => void;
  removePendingQuestion: (requestId: string) => void;
  addPendingPermission: (permission: PermissionRequest) => void;
  removePendingPermission: (requestId: string) => void;

  // Event subscription actions
  getOrCreateEventSubscription: (
    environmentId: string,
  ) => EventSubscriptionState | null;
  setEventStream: (
    environmentId: string,
    stream: AsyncIterable<OpenCodeEvent> | null,
  ) => void;
  closeEventSubscription: (environmentId: string) => void;
  hasActiveEventSubscription: (environmentId: string) => boolean;

  clearEnvironment: (environmentId: string) => void;

  // Selectors
  getSelectedModel: (environmentId: string) => string | undefined;
  getModels: (environmentId: string) => OpenCodeModel[];
  getSlashCommands: (environmentId: string) => OpenCodeSlashCommand[];
  getSelectedVariant: (environmentId: string) => string | undefined;
  getSelectedMode: (sessionKey: string) => OpenCodeConversationMode;
  isComposingFor: (environmentId: string) => boolean;
  getPendingQuestionsForSession: (sessionId: string) => QuestionRequest[];
  getPendingQuestion: (requestId: string) => QuestionRequest | undefined;
  getPendingPermissionsForSession: (sessionId: string) => PermissionRequest[];
  getPendingPermission: (requestId: string) => PermissionRequest | undefined;
  getContextUsage: (sessionKey: string) => ContextUsageSnapshot | undefined;
}

// Stable empty arrays to prevent infinite render loops with useSyncExternalStore.
// See comment in createNativeChatStore.ts for the same rationale.
const EMPTY_MODELS: OpenCodeModel[] = [];
const EMPTY_COMMANDS: OpenCodeSlashCommand[] = [];
const EMPTY_QUESTIONS: QuestionRequest[] = [];
const EMPTY_PERMISSIONS: PermissionRequest[] = [];

export const useOpenCodeStore = create<OpenCodeState>()((set, get, api) => ({
  ...createNativeChatStoreSlice<
    OpencodeClient,
    OpenCodeMessage,
    OpenCodeAttachment,
    OpenCodeQueuedMessage
  >({ mergeMessages: mergeNativeMessagesPreservingClientOnly })(set, get, api),

  // Agent-specific state
  models: new Map(),
  slashCommands: new Map(),
  selectedModel: new Map(),
  selectedVariant: new Map(),
  isComposing: new Map(),
  eventSubscriptions: new Map(),
  selectedMode: new Map(),
  contextUsage: new Map(),
  pendingQuestions: new Map(),
  pendingPermissions: new Map(),

  // Agent-specific actions
  setModels: (environmentId, models) =>
    set((state) => {
      const next = new Map(state.models);
      next.set(environmentId, models);
      return { models: next };
    }),

  setSlashCommands: (environmentId, commands) =>
    set((state) => {
      const next = new Map(state.slashCommands);
      next.set(environmentId, commands);
      return { slashCommands: next };
    }),

  setSelectedModel: (environmentId, modelId) =>
    set((state) => {
      const next = new Map(state.selectedModel);
      next.set(environmentId, modelId);
      return { selectedModel: next };
    }),

  setSelectedVariant: (environmentId, variant) =>
    set((state) => {
      const next = new Map(state.selectedVariant);
      if (variant && variant.trim().length > 0) {
        next.set(environmentId, variant);
      } else {
        next.delete(environmentId);
      }
      return { selectedVariant: next };
    }),

  setSelectedMode: (sessionKey, mode) =>
    set((state) => {
      const next = new Map(state.selectedMode);
      next.set(sessionKey, mode);
      return { selectedMode: next };
    }),

  setComposing: (environmentId, isComposing) =>
    set((state) => {
      const next = new Map(state.isComposing);
      next.set(environmentId, isComposing);
      return { isComposing: next };
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
    const subscription = get().eventSubscriptions.get(environmentId);
    if (subscription) {
      console.log(
        "[openCodeStore] Closing event subscription during environment cleanup:",
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
      const newServerStatus = new Map(state.serverStatus);
      const newClients = new Map(state.clients);
      const newModels = new Map(state.models);
      const newSelectedModel = new Map(state.selectedModel);
      const newSlashCommands = new Map(state.slashCommands);
      const newSelectedVariant = new Map(state.selectedVariant);
      const newIsComposing = new Map(state.isComposing);
      const newEventSubscriptions = new Map(state.eventSubscriptions);

      newServerStatus.delete(environmentId);
      newClients.delete(environmentId);
      newModels.delete(environmentId);
      newSelectedModel.delete(environmentId);
      newSlashCommands.delete(environmentId);
      newSelectedVariant.delete(environmentId);
      newIsComposing.delete(environmentId);
      newEventSubscriptions.delete(environmentId);

      const prefix = `env-${environmentId}:`;

      // Collect session IDs before pruning so we can clean up pending requests
      const environmentSessionIds = new Set<string>();
      for (const [key, session] of state.sessions) {
        if (key.startsWith(prefix)) {
          environmentSessionIds.add(session.sessionId);
        }
      }

      const newSelectedMode = pruneSessionKeyedMap(state.selectedMode, prefix);
      // Also remove any legacy environment-scoped mode key (backward compat)
      newSelectedMode.delete(environmentId);

      const newPendingQuestions = new Map(state.pendingQuestions);
      for (const [requestId, question] of newPendingQuestions) {
        if (environmentSessionIds.has(question.sessionID)) {
          newPendingQuestions.delete(requestId);
        }
      }

      const newPendingPermissions = new Map(state.pendingPermissions);
      for (const [requestId, permission] of newPendingPermissions) {
        if (environmentSessionIds.has(permission.sessionID)) {
          newPendingPermissions.delete(requestId);
        }
      }

      return {
        serverStatus: newServerStatus,
        sessions: pruneSessionKeyedMap(state.sessions, prefix),
        clients: newClients,
        models: newModels,
        selectedModel: newSelectedModel,
        slashCommands: newSlashCommands,
        selectedVariant: newSelectedVariant,
        selectedMode: newSelectedMode,
        attachments: pruneSessionKeyedMap(state.attachments, prefix),
        draftText: pruneSessionKeyedMap(state.draftText, prefix),
        draftMentions: pruneSessionKeyedMap(state.draftMentions, prefix),
        messageQueue: pruneSessionKeyedMap(state.messageQueue, prefix),
        isComposing: newIsComposing,
        pendingQuestions: newPendingQuestions,
        pendingPermissions: newPendingPermissions,
        eventSubscriptions: newEventSubscriptions,
        contextUsage: pruneSessionKeyedMap(state.contextUsage, prefix),
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

  addPendingPermission: (permission) =>
    set((state) => {
      const next = new Map(state.pendingPermissions);
      next.set(permission.id, permission);
      return { pendingPermissions: next };
    }),

  removePendingPermission: (requestId) =>
    set((state) => {
      const next = new Map(state.pendingPermissions);
      next.delete(requestId);
      return { pendingPermissions: next };
    }),

  getOrCreateEventSubscription: (environmentId) => {
    const state = get();
    const existing = state.eventSubscriptions.get(environmentId);

    if (existing && existing.isActive) {
      console.log(
        "[openCodeStore] Reusing existing event subscription for environment:",
        environmentId,
      );
      return existing;
    }

    console.log(
      "[openCodeStore] Creating new event subscription for environment:",
      environmentId,
    );
    const newSubscription: EventSubscriptionState = {
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
      "[openCodeStore] Closing event subscription for environment:",
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
  getSelectedModel: (environmentId) => get().selectedModel.get(environmentId),
  getModels: (environmentId) =>
    get().models.get(environmentId) ?? EMPTY_MODELS,
  getSlashCommands: (environmentId) =>
    get().slashCommands.get(environmentId) ?? EMPTY_COMMANDS,
  getSelectedVariant: (environmentId) =>
    get().selectedVariant.get(environmentId),
  getSelectedMode: (sessionKey) =>
    get().selectedMode.get(sessionKey) || "build",
  isComposingFor: (environmentId) =>
    get().isComposing.get(environmentId) || false,

  getPendingQuestionsForSession: (sessionId) => {
    const questions: QuestionRequest[] = [];
    for (const question of get().pendingQuestions.values()) {
      if (question.sessionID === sessionId) {
        questions.push(question);
      }
    }
    return questions.length > 0 ? questions : EMPTY_QUESTIONS;
  },

  getPendingQuestion: (requestId) => get().pendingQuestions.get(requestId),

  getPendingPermissionsForSession: (sessionId) => {
    const permissions: PermissionRequest[] = [];
    for (const permission of get().pendingPermissions.values()) {
      if (permission.sessionID === sessionId) {
        permissions.push(permission);
      }
    }
    return permissions.length > 0 ? permissions : EMPTY_PERMISSIONS;
  },

  getPendingPermission: (requestId) => get().pendingPermissions.get(requestId),

  getContextUsage: (sessionKey) => get().contextUsage.get(sessionKey),
}));
