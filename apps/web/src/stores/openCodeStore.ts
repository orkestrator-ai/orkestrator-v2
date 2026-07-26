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

/** Shared event subscription state per environment */
export type EventSubscriptionState = NativeEventSubscriptionState<OpenCodeEvent>;

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

interface OpenCodeState
  extends OpenCodeChatSlice,
    NativeEventSubscriptionSlice<OpenCodeEvent> {
  // Agent-specific state (per-environment)
  models: Map<string, OpenCodeModel[]>;
  slashCommands: Map<string, OpenCodeSlashCommand[]>;

  /**
   * Agent-specific state (per-session).
   *
   * Model, variant and composing state are keyed by sessionKey, matching
   * Claude and Codex. They used to be environment-scoped, which silently tied
   * two OpenCode tabs in the same environment to one model selection.
   */
  selectedModel: Map<string, string>;
  selectedVariant: Map<string, string>;
  isComposing: Map<string, boolean>;
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
  setSelectedModel: (sessionKey: string, modelId: string) => void;
  setSelectedVariant: (
    sessionKey: string,
    variant: string | undefined,
  ) => void;
  setComposing: (sessionKey: string, isComposing: boolean) => void;

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

  clearEnvironment: (environmentId: string) => void;
  /** Drop every session-keyed entry for one closed tab. */
  clearSession: (sessionKey: string) => void;

  // Selectors
  getSelectedModel: (sessionKey: string) => string | undefined;
  getModels: (environmentId: string) => OpenCodeModel[];
  getSlashCommands: (environmentId: string) => OpenCodeSlashCommand[];
  getSelectedVariant: (sessionKey: string) => string | undefined;
  getSelectedMode: (sessionKey: string) => OpenCodeConversationMode;
  isComposingFor: (sessionKey: string) => boolean;
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

/**
 * Every map keyed by sessionKey, shared by the environment and tab sweeps so
 * the two cannot drift. A new session-keyed map goes here or it leaks.
 */
const OPENCODE_SESSION_KEYED_MAPS = [
  "sessions",
  "attachments",
  "draftText",
  "draftMentions",
  "messageQueue",
  "selectedModel",
  "selectedVariant",
  "selectedMode",
  "isComposing",
  "contextUsage",
] as const satisfies ReadonlyArray<keyof OpenCodeState>;

export const useOpenCodeStore = create<OpenCodeState>()((set, get, api) => ({
  ...createNativeChatStoreSlice<
    OpencodeClient,
    OpenCodeMessage,
    OpenCodeAttachment,
    OpenCodeQueuedMessage
  >({ mergeMessages: mergeNativeMessagesPreservingClientOnly })(set, get, api),

  ...createEventSubscriptionSlice<OpenCodeEvent>("openCodeStore")(set, get, api),

  // Agent-specific state
  models: new Map(),
  slashCommands: new Map(),
  selectedModel: new Map(),
  selectedVariant: new Map(),
  isComposing: new Map(),
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

  setSelectedModel: (sessionKey, modelId) =>
    set((state) => {
      const next = new Map(state.selectedModel);
      next.set(sessionKey, modelId);
      return { selectedModel: next };
    }),

  setSelectedVariant: (sessionKey, variant) =>
    set((state) => {
      const next = new Map(state.selectedVariant);
      if (variant && variant.trim().length > 0) {
        next.set(sessionKey, variant);
      } else {
        next.delete(sessionKey);
      }
      return { selectedVariant: next };
    }),

  setSelectedMode: (sessionKey, mode) =>
    set((state) => {
      const next = new Map(state.selectedMode);
      next.set(sessionKey, mode);
      return { selectedMode: next };
    }),

  setComposing: (sessionKey, isComposing) =>
    set((state) => {
      const next = new Map(state.isComposing);
      next.set(sessionKey, isComposing);
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

  clearSession: (sessionKey) => {
    set((state) => {
      const session = state.sessions.get(sessionKey);
      const patch = buildClearSessionPatch(
        state,
        sessionKey,
        OPENCODE_SESSION_KEYED_MAPS,
      );
      if (!session?.sessionId) return patch;

      // Pending requests are keyed by requestId, so they need a sweep by the
      // session id this tab owned rather than by its session key.
      const pendingQuestions = new Map(state.pendingQuestions);
      for (const [requestId, question] of pendingQuestions) {
        if (question.sessionId === session.sessionId) {
          pendingQuestions.delete(requestId);
        }
      }
      const pendingPermissions = new Map(state.pendingPermissions);
      for (const [requestId, permission] of pendingPermissions) {
        if (permission.sessionId === session.sessionId) {
          pendingPermissions.delete(requestId);
        }
      }
      return { ...patch, pendingQuestions, pendingPermissions };
    });
  },

  clearEnvironment: (environmentId) => {
    // Abort before dropping the map entry — losing the reference without
    // returning the iterator leaks the generator.
    const subscription = get().eventSubscriptions.get(environmentId);
    if (subscription) {
      console.log(
        "[openCodeStore] Closing event subscription during environment cleanup:",
        environmentId,
      );
      teardownEventSubscription(subscription);
    }

    set((state) => {
      const prefix = sessionKeyPrefixFor(environmentId);

      // Collect session IDs before pruning so pending requests can be swept.
      const environmentSessionIds = new Set<string>();
      for (const [key, session] of state.sessions) {
        if (key.startsWith(prefix)) {
          environmentSessionIds.add(session.sessionId);
        }
      }

      const newPendingQuestions = new Map(state.pendingQuestions);
      for (const [requestId, question] of newPendingQuestions) {
        if (environmentSessionIds.has(question.sessionId)) {
          newPendingQuestions.delete(requestId);
        }
      }

      const newPendingPermissions = new Map(state.pendingPermissions);
      for (const [requestId, permission] of newPendingPermissions) {
        if (environmentSessionIds.has(permission.sessionId)) {
          newPendingPermissions.delete(requestId);
        }
      }

      return {
        ...buildClearEnvironmentPatch(state, environmentId, {
          environmentKeyed: [
            "serverStatus",
            "clients",
            "models",
            "slashCommands",
            "eventSubscriptions",
          ],
          sessionKeyed: OPENCODE_SESSION_KEYED_MAPS,
        }),
        // Keyed by requestId, so they need the session-id sweep above.
        pendingQuestions: newPendingQuestions,
        pendingPermissions: newPendingPermissions,
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

  // Selectors
  getSelectedModel: (sessionKey) => get().selectedModel.get(sessionKey),
  getModels: (environmentId) =>
    get().models.get(environmentId) ?? EMPTY_MODELS,
  getSlashCommands: (environmentId) =>
    get().slashCommands.get(environmentId) ?? EMPTY_COMMANDS,
  getSelectedVariant: (sessionKey) => get().selectedVariant.get(sessionKey),
  getSelectedMode: (sessionKey) =>
    get().selectedMode.get(sessionKey) || "build",
  isComposingFor: (sessionKey) => get().isComposing.get(sessionKey) || false,

  getPendingQuestionsForSession: (sessionId) => {
    const questions: QuestionRequest[] = [];
    for (const question of get().pendingQuestions.values()) {
      if (question.sessionId === sessionId) {
        questions.push(question);
      }
    }
    return questions.length > 0 ? questions : EMPTY_QUESTIONS;
  },

  getPendingQuestion: (requestId) => get().pendingQuestions.get(requestId),

  getPendingPermissionsForSession: (sessionId) => {
    const permissions: PermissionRequest[] = [];
    for (const permission of get().pendingPermissions.values()) {
      if (permission.sessionId === sessionId) {
        permissions.push(permission);
      }
    }
    return permissions.length > 0 ? permissions : EMPTY_PERMISSIONS;
  },

  getPendingPermission: (requestId) => get().pendingPermissions.get(requestId),

  getContextUsage: (sessionKey) => get().contextUsage.get(sessionKey),
}));
