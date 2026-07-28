import { create } from "zustand";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  type CodexApproval,
  type CodexClient,
  type CodexConversationMode,
  type CodexInteraction,
  type CodexMessage,
  type CodexModel,
  type CodexReasoningEffort,
  type CodexSessionPhase,
  type CodexSlashCommand,
} from "@/lib/codex-client";
import { mergeNativeMessagesPreservingClientOnly } from "@/lib/chat/client-only-messages";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import type { FileMention } from "@/types";
import {
  codexInteractionDraftKey,
  usePromptDraftStore,
} from "./promptDraftStore";
import {
  buildClearEnvironmentPatch,
  buildClearSessionPatch,
  createNativeChatStoreSlice,
  sessionKeyPrefixFor,
  type NativeChatStoreSlice,
  type NativeServerStatus,
  type NativeSessionState,
} from "./createNativeChatStore";

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
  /**
   * Idempotency key for this logical prompt.
   *
   * Kept on the queue entry so draining, remounting, or retrying the same entry
   * cannot accidentally turn one queued action into two app-server turns.
   */
  requestId?: string;
  text: string;
  attachments: CodexAttachment[];
  model: string;
  mode: CodexConversationMode;
  reasoningEffort: CodexReasoningEffort;
  fastMode: boolean;
}

export interface CodexUnconfirmedDispatch {
  userMessageId: string;
  fingerprint: string;
  requestId: string;
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
  pendingInteractions: Map<string, CodexInteraction[]>;
  contextUsage: Map<string, ContextUsageSnapshot>;
  /** Ambiguous prompt sends that the next mount must settle authoritatively. */
  unconfirmedDispatches: Map<string, CodexUnconfirmedDispatch>;

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
  setPendingInteractions: (
    sessionKey: string,
    interactions: CodexInteraction[],
  ) => void;
  addPendingInteraction: (
    sessionKey: string,
    interaction: CodexInteraction,
  ) => void;
  removePendingInteraction: (
    sessionKey: string,
    interactionId: string,
  ) => void;
  setContextUsage: (
    sessionKey: string,
    usage: ContextUsageSnapshot | null,
  ) => void;
  getContextUsage: (sessionKey: string) => ContextUsageSnapshot | undefined;
  setUnconfirmedDispatch: (
    sessionKey: string,
    dispatch: CodexUnconfirmedDispatch,
  ) => void;
  clearUnconfirmedDispatch: (sessionKey: string) => void;
  isFastMode: (sessionKey: string) => boolean;
  clearEnvironment: (environmentId: string) => void;
  /** Drop every session-keyed entry for one closed tab. */
  clearSession: (sessionKey: string) => void;
}

/**
 * True when two descriptors are interchangeable, so a snapshot can be ignored.
 *
 * Compares the payload and not just the id: the bridge re-reports a pending
 * approval with a refreshed `expiresAt` (and may revise the command text after a
 * generation change), and treating those as "same list" would leave the card
 * counting down to a deadline that has already moved.
 */
function isSameApproval(a: CodexApproval, b: CodexApproval | undefined): boolean {
  if (a === b) return true;
  if (!b) return false;
  return a.approvalId === b.approvalId
    && a.kind === b.kind
    && a.method === b.method
    && a.threadId === b.threadId
    && a.turnId === b.turnId
    && a.itemId === b.itemId
    && a.requestedAt === b.requestedAt
    && a.expiresAt === b.expiresAt
    && a.command === b.command
    && a.cwd === b.cwd
    && a.reason === b.reason
    && a.grantRoot === b.grantRoot
    && a.networkHost === b.networkHost
    // `actionable` gates the Approve buttons and must fail closed, so a
    // re-report that only flips it has to reach the card rather than being
    // discarded as an interchangeable snapshot.
    && a.actionable === b.actionable
    && a.supportsApproveForSession === b.supportsApproveForSession
    && a.permissions?.network === b.permissions?.network
    && a.permissions?.fileSystem === b.permissions?.fileSystem
    && (a.changes?.length ?? 0) === (b.changes?.length ?? 0)
    && (a.changes ?? []).every(
      (change, index) =>
        change.path === b.changes?.[index]?.path && change.kind === b.changes?.[index]?.kind,
    );
}

/**
 * Every map keyed by sessionKey, shared by the environment and tab sweeps so
 * the two cannot drift. A new session-keyed map goes here or it leaks.
 */
const CODEX_SESSION_KEYED_MAPS = [
  "sessions",
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
] as const satisfies ReadonlyArray<keyof CodexState>;

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
  pendingInteractions: new Map(),
  contextUsage: new Map(),
  unconfirmedDispatches: new Map(),

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
      const existing = state.pendingApprovals.get(sessionKey) ?? [];
      // Cheap identity check so a poll returning an unchanged list does not
      // rerender — reconcile calls this on every tick, including with an empty
      // list, so an always-new Map here would rerender the whole tab.
      if (
        existing.length === approvals.length
        && existing.every((entry, index) => isSameApproval(entry, approvals[index]))
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

  setPendingInteractions: (sessionKey, interactions) => {
    // An interaction absent from the authoritative snapshot was resolved or
    // withdrawn elsewhere, so its in-progress input draft goes with it.
    const kept = new Set(interactions.map((entry) => entry.interactionId));
    const withdrawnDraftKeys = (get().pendingInteractions.get(sessionKey) ?? [])
      .filter((entry) => !kept.has(entry.interactionId))
      .map((entry) => codexInteractionDraftKey(entry.interactionId));

    set((state) => {
      const existing = state.pendingInteractions.get(sessionKey) ?? [];
      // Same rationale as `setPendingApprovals`: reconcile calls this on every
      // tick, almost always with an empty list, so an always-new Map here would
      // rerender the whole tab. `expiresAt` is compared as well as the id because
      // the bridge re-reports a pending interaction with a refreshed deadline.
      if (
        existing.length === interactions.length
        && existing.every(
          (entry, index) =>
            entry.interactionId === interactions[index]?.interactionId
            && entry.expiresAt === interactions[index]?.expiresAt,
        )
      ) {
        return state;
      }
      const next = new Map(state.pendingInteractions);
      if (interactions.length === 0) next.delete(sessionKey);
      else next.set(sessionKey, interactions);
      return { pendingInteractions: next };
    });
    usePromptDraftStore.getState().clearDrafts(withdrawnDraftKeys);
  },

  addPendingInteraction: (sessionKey, interaction) =>
    set((state) => {
      const existing = state.pendingInteractions.get(sessionKey) ?? [];
      if (existing.some((entry) => entry.interactionId === interaction.interactionId)) {
        return state;
      }
      const next = new Map(state.pendingInteractions);
      next.set(sessionKey, [...existing, interaction]);
      return { pendingInteractions: next };
    }),

  removePendingInteraction: (sessionKey, interactionId) => {
    set((state) => {
      const existing = state.pendingInteractions.get(sessionKey);
      if (!existing?.some((entry) => entry.interactionId === interactionId)) return state;
      const remaining = existing.filter(
        (entry) => entry.interactionId !== interactionId,
      );
      const next = new Map(state.pendingInteractions);
      if (remaining.length === 0) next.delete(sessionKey);
      else next.set(sessionKey, remaining);
      return { pendingInteractions: next };
    });
    // The interaction is resolved, so the in-progress input draft must not
    // survive to a future interaction that happens to reuse this id.
    usePromptDraftStore
      .getState()
      .clearDraft(codexInteractionDraftKey(interactionId));
  },

  setContextUsage: (sessionKey, usage) =>
    set((state) => {
      const next = new Map(state.contextUsage);
      if (usage) next.set(sessionKey, usage);
      else next.delete(sessionKey);
      return { contextUsage: next };
    }),

  getContextUsage: (sessionKey) => get().contextUsage.get(sessionKey),

  setUnconfirmedDispatch: (sessionKey, dispatch) =>
    set((state) => {
      const next = new Map(state.unconfirmedDispatches);
      next.set(sessionKey, dispatch);
      return { unconfirmedDispatches: next };
    }),

  clearUnconfirmedDispatch: (sessionKey) =>
    set((state) => {
      if (!state.unconfirmedDispatches.has(sessionKey)) return state;
      const next = new Map(state.unconfirmedDispatches);
      next.delete(sessionKey);
      return { unconfirmedDispatches: next };
    }),

  isFastMode: (sessionKey) => get().fastMode.get(sessionKey) ?? false,

  clearEnvironment: (environmentId) => {
    // `pendingInteractions` is session-keyed, so the generic patch drops the
    // entries; the request-id-keyed drafts need an explicit sweep.
    const prefix = sessionKeyPrefixFor(environmentId);
    const sweptDraftKeys: string[] = [];
    for (const [sessionKey, interactions] of get().pendingInteractions) {
      if (!sessionKey.startsWith(prefix)) continue;
      for (const entry of interactions) {
        sweptDraftKeys.push(codexInteractionDraftKey(entry.interactionId));
      }
    }

    set((state) =>
      buildClearEnvironmentPatch(state, environmentId, {
        environmentKeyed: ["serverStatus", "clients", "slashCommands"],
        sessionKeyed: CODEX_SESSION_KEYED_MAPS,
      }),
    );
    usePromptDraftStore.getState().clearDrafts(sweptDraftKeys);
  },

  clearSession: (sessionKey) => {
    const sweptDraftKeys = (get().pendingInteractions.get(sessionKey) ?? []).map(
      (entry) => codexInteractionDraftKey(entry.interactionId),
    );
    set((state) =>
      buildClearSessionPatch(state, sessionKey, CODEX_SESSION_KEYED_MAPS),
    );
    usePromptDraftStore.getState().clearDrafts(sweptDraftKeys);
  },
}));

// Re-export for callers that still import types/helpers from here
export type { FileMention };
