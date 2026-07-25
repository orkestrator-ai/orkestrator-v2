import { create } from "zustand";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  type CodexApproval,
  type CodexClient,
  type CodexConversationMode,
  type CodexMessage,
  type CodexModel,
  type CodexReasoningEffort,
  type CodexSessionPhase,
  type CodexSlashCommand,
} from "@/lib/codex-client";
import { mergeNativeMessagesPreservingClientOnly } from "@/lib/chat/client-only-messages";
import { createSessionKey } from "@/lib/utils";
import type { FileMention } from "@/types";
import {
  createNativeChatStoreSlice,
  pruneSessionKeyedMap,
  type NativeChatStoreSlice,
  type NativeServerStatus,
  type NativeSessionState,
} from "./createNativeChatStore";

export const createCodexSessionKey = createSessionKey;

export type CodexServerStatus = NativeServerStatus;
export type CodexSessionState = NativeSessionState<CodexMessage>;

export interface CodexAttachment {
  id: string;
  type: "image";
  path: string;
  previewUrl?: string;
  name: string;
}

export interface CodexQueuedMessage {
  id: string;
  text: string;
  attachments: CodexAttachment[];
  model: string;
  mode: CodexConversationMode;
  reasoningEffort: CodexReasoningEffort;
  fastMode: boolean;
}

type CodexChatSlice = NativeChatStoreSlice<
  CodexClient,
  CodexMessage,
  CodexAttachment,
  CodexQueuedMessage
>;

interface CodexState extends CodexChatSlice {
  // Agent-specific state
  models: CodexModel[];
  slashCommands: Map<string, CodexSlashCommand[]>;
  selectedModel: Map<string, string>;
  selectedMode: Map<string, CodexConversationMode>;
  selectedReasoningEffort: Map<string, CodexReasoningEffort>;
  fastMode: Map<string, boolean>;
  /**
   * Detailed lifecycle phase reported by the bridge.
   *
   * Kept separate from `isLoading` because `cancelling` and `recovering` are both
   * *loading* states — the turn may still be executing — but need distinct UI.
   */
  sessionPhase: Map<string, CodexSessionPhase>;
  /**
   * Approvals Codex is blocked on, per session, in arrival order.
   *
   * Held in the store rather than component state so a background environment
   * still accumulates them: the bridge is the authority, but a tab that was
   * unmounted when the request arrived rehydrates through `setPendingApprovals`
   * on mount.
   */
  pendingApprovals: Map<string, CodexApproval[]>;

  // Agent-specific actions
  setModels: (models: CodexModel[]) => void;
  setSlashCommands: (environmentId: string, commands: CodexSlashCommand[]) => void;
  setSelectedModel: (sessionKey: string, model: string) => void;
  setSelectedMode: (sessionKey: string, mode: CodexConversationMode) => void;
  setSelectedReasoningEffort: (
    sessionKey: string,
    effort: CodexReasoningEffort,
  ) => void;
  setFastMode: (sessionKey: string, enabled: boolean) => void;
  setSessionPhase: (sessionKey: string, phase: CodexSessionPhase | undefined) => void;
  /** Replaces the whole list — the rehydration path. */
  setPendingApprovals: (sessionKey: string, approvals: CodexApproval[]) => void;
  /** Adds one, ignoring a duplicate id so an SSE replay cannot double-render. */
  addPendingApproval: (sessionKey: string, approval: CodexApproval) => void;
  removePendingApproval: (sessionKey: string, approvalId: string) => void;
  isFastMode: (sessionKey: string) => boolean;
  clearEnvironment: (environmentId: string) => void;
}

export const useCodexStore = create<CodexState>()((set, get, api) => ({
  ...createNativeChatStoreSlice<
    CodexClient,
    CodexMessage,
    CodexAttachment,
    CodexQueuedMessage
  >({ mergeMessages: mergeNativeMessagesPreservingClientOnly })(set, get, api),

  // Agent-specific state
  models: CODEX_MODELS,
  slashCommands: new Map(),
  selectedModel: new Map(),
  selectedMode: new Map(),
  selectedReasoningEffort: new Map(),
  fastMode: new Map(),
  sessionPhase: new Map(),
  pendingApprovals: new Map(),

  // Agent-specific actions
  setModels: (models) => set({ models: models.length > 0 ? models : CODEX_MODELS }),

  setSlashCommands: (environmentId, commands) =>
    set((state) => {
      const next = new Map(state.slashCommands);
      if (commands.length > 0) {
        next.set(environmentId, commands);
      } else {
        next.delete(environmentId);
      }
      return { slashCommands: next };
    }),

  setSelectedModel: (sessionKey, model) =>
    set((state) => {
      const next = new Map(state.selectedModel);
      next.set(sessionKey, model || DEFAULT_CODEX_MODEL);
      return { selectedModel: next };
    }),

  setSelectedMode: (sessionKey, mode) =>
    set((state) => {
      const next = new Map(state.selectedMode);
      next.set(sessionKey, mode);
      return { selectedMode: next };
    }),

  setSelectedReasoningEffort: (sessionKey, effort) =>
    set((state) => {
      const next = new Map(state.selectedReasoningEffort);
      next.set(sessionKey, effort);
      return { selectedReasoningEffort: next };
    }),

  setFastMode: (sessionKey, enabled) =>
    set((state) => {
      const next = new Map(state.fastMode);
      next.set(sessionKey, enabled);
      return { fastMode: next };
    }),

  setSessionPhase: (sessionKey, phase) =>
    set((state) => {
      if (state.sessionPhase.get(sessionKey) === phase) return state;
      const next = new Map(state.sessionPhase);
      if (phase === undefined) next.delete(sessionKey);
      else next.set(sessionKey, phase);
      return { sessionPhase: next };
    }),

  setPendingApprovals: (sessionKey, approvals) =>
    set((state) => {
      const existing = state.pendingApprovals.get(sessionKey);
      // Cheap identity check so a poll returning the same list does not rerender.
      if (
        (existing?.length ?? 0) === approvals.length
        && (existing ?? []).every((entry, index) => entry.approvalId === approvals[index]?.approvalId)
      ) {
        return state;
      }
      const next = new Map(state.pendingApprovals);
      if (approvals.length === 0) next.delete(sessionKey);
      else next.set(sessionKey, approvals);
      return { pendingApprovals: next };
    }),

  addPendingApproval: (sessionKey, approval) =>
    set((state) => {
      const existing = state.pendingApprovals.get(sessionKey) ?? [];
      // A replayed SSE frame can deliver the same approval twice; the id is the
      // dedupe key.
      if (existing.some((entry) => entry.approvalId === approval.approvalId)) return state;
      const next = new Map(state.pendingApprovals);
      next.set(sessionKey, [...existing, approval]);
      return { pendingApprovals: next };
    }),

  removePendingApproval: (sessionKey, approvalId) =>
    set((state) => {
      const existing = state.pendingApprovals.get(sessionKey);
      if (!existing?.some((entry) => entry.approvalId === approvalId)) return state;
      const remaining = existing.filter((entry) => entry.approvalId !== approvalId);
      const next = new Map(state.pendingApprovals);
      if (remaining.length === 0) next.delete(sessionKey);
      else next.set(sessionKey, remaining);
      return { pendingApprovals: next };
    }),

  isFastMode: (sessionKey) => get().fastMode.get(sessionKey) ?? false,

  clearEnvironment: (environmentId) =>
    set((state) => {
      const nextServerStatus = new Map(state.serverStatus);
      nextServerStatus.delete(environmentId);

      const nextClients = new Map(state.clients);
      nextClients.delete(environmentId);

      const nextSlashCommands = new Map(state.slashCommands);
      nextSlashCommands.delete(environmentId);

      const prefix = `env-${environmentId}:`;

      return {
        models: state.models,
        serverStatus: nextServerStatus,
        clients: nextClients,
        slashCommands: nextSlashCommands,
        sessions: pruneSessionKeyedMap(state.sessions, prefix),
        attachments: pruneSessionKeyedMap(state.attachments, prefix),
        draftText: pruneSessionKeyedMap(state.draftText, prefix),
        draftMentions: pruneSessionKeyedMap(state.draftMentions, prefix),
        messageQueue: pruneSessionKeyedMap(state.messageQueue, prefix),
        selectedModel: pruneSessionKeyedMap(state.selectedModel, prefix),
        selectedMode: pruneSessionKeyedMap(state.selectedMode, prefix),
        sessionPhase: pruneSessionKeyedMap(state.sessionPhase, prefix),
        pendingApprovals: pruneSessionKeyedMap(state.pendingApprovals, prefix),
        selectedReasoningEffort: pruneSessionKeyedMap(
          state.selectedReasoningEffort,
          prefix,
        ),
        fastMode: pruneSessionKeyedMap(state.fastMode, prefix),
      };
    }),
}));

// Re-export for callers that still import types/helpers from here
export type { FileMention };
