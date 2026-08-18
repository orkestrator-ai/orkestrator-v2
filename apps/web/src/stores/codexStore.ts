import { create } from "zustand";
import {
  classifyCodexMessagePatch,
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  type CodexApproval,
  type CodexClient,
  type CodexConversationMode,
  type CodexInteraction,
  type CodexMessage,
  type CodexMessagePatch,
  type CodexModel,
  type CodexReasoningEffort,
  type CodexSessionPhase,
  type CodexSlashCommand,
} from "@/lib/codex-client";
import {
  isClientOnlyNativeMessage,
  mergeNativeMessagesPreservingClientOnly,
} from "@/lib/chat/client-only-messages";
import { deepEqualJson } from "@/lib/chat/message-identity";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import type { FileMention } from "@/types";
import { codexInteractionDraftKey, usePromptDraftStore } from "./promptDraftStore";
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
  /**
   * This marker came from bridge status after the renderer lost its original
   * prompt payload. It cannot be matched to an edited compose draft, and is
   * retired when a later authoritative status no longer reports it.
   */
  restoredFromStatus?: boolean;
  /**
   * The authoritative transcript did not contain this prompt, so the original
   * idempotency key must remain available for a safe retry.
   */
  retryable?: boolean;
}

export type CodexUnconfirmedDispatchResolution = "none" | "confirmed" | "retryable";

export const CODEX_UNCONFIRMED_DISPATCH_ERROR =
  "Could not confirm whether Codex received the prompt. You can send it again safely.";

type CodexChatSlice = NativeChatStoreSlice<
  CodexClient,
  CodexMessage,
  CodexAttachment,
  CodexQueuedMessage
>;

interface CodexState extends CodexChatSlice {
  patchMessage: (
    sessionKey: string,
    patch: CodexMessagePatch,
  ) => "applied" | "stale" | "needs-reconcile";
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
  /**
   * Logical prompt requests claimed by this renderer.
   *
   * Component-local refs cannot coordinate React StrictMode's repeated effects
   * or a background-to-foreground remount. The durable pane prompt survives a
   * renderer crash; this map only prevents two live mounts in the same renderer
   * from creating two optimistic bubbles for that one durable request. Accepted
   * one-shot launch claims remain until the tab/session is cleaned up.
   */
  promptDispatchClaims: Map<string, Set<string>>;

  // Agent-specific actions
  setModels: (models: CodexModel[]) => void;
  setSlashCommands: (environmentId: string, commands: CodexSlashCommand[]) => void;
  setSelectedModel: (sessionKey: string, model: string) => void;
  setSelectedMode: (sessionKey: string, mode: CodexConversationMode) => void;
  setSelectedReasoningEffort: (sessionKey: string, effort: CodexReasoningEffort) => void;
  setFastMode: (sessionKey: string, enabled: boolean) => void;
  setSessionPhase: (sessionKey: string, phase: CodexSessionPhase | undefined) => void;
  /** Replaces the whole list — the rehydration path. */
  setPendingApprovals: (sessionKey: string, approvals: CodexApproval[]) => void;
  /** Adds one, ignoring a duplicate id so an SSE replay cannot double-render. */
  addPendingApproval: (sessionKey: string, approval: CodexApproval) => void;
  removePendingApproval: (sessionKey: string, approvalId: string) => void;
  setPendingInteractions: (sessionKey: string, interactions: CodexInteraction[]) => void;
  addPendingInteraction: (sessionKey: string, interaction: CodexInteraction) => void;
  removePendingInteraction: (sessionKey: string, interactionId: string) => void;
  setContextUsage: (sessionKey: string, usage: ContextUsageSnapshot | null) => void;
  getContextUsage: (sessionKey: string) => ContextUsageSnapshot | undefined;
  setUnconfirmedDispatch: (sessionKey: string, dispatch: CodexUnconfirmedDispatch) => void;
  clearUnconfirmedDispatch: (sessionKey: string) => void;
  /** Atomically claims one logical request for a live mount. */
  claimPromptDispatch: (sessionKey: string, requestId: string) => boolean;
  releasePromptDispatch: (sessionKey: string, requestId: string) => void;
  /**
   * Settles an ambiguous dispatch after an authoritative transcript refresh.
   *
   * A matching server echo removes the optimistic message during `setMessages`,
   * while an unmatched optimistic message survives and becomes a durable retry.
   */
  settleUnconfirmedDispatch: (sessionKey: string) => CodexUnconfirmedDispatchResolution;
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
  return (
    a.approvalId === b.approvalId &&
    a.kind === b.kind &&
    a.method === b.method &&
    a.threadId === b.threadId &&
    a.turnId === b.turnId &&
    a.itemId === b.itemId &&
    a.requestedAt === b.requestedAt &&
    a.expiresAt === b.expiresAt &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.reason === b.reason &&
    a.grantRoot === b.grantRoot &&
    a.networkHost === b.networkHost &&
    // `actionable` gates the Approve buttons and must fail closed, so a
    // re-report that only flips it has to reach the card rather than being
    // discarded as an interchangeable snapshot.
    a.actionable === b.actionable &&
    a.supportsApproveForSession === b.supportsApproveForSession &&
    a.permissions?.network === b.permissions?.network &&
    a.permissions?.fileSystem === b.permissions?.fileSystem &&
    (a.changes?.length ?? 0) === (b.changes?.length ?? 0) &&
    (a.changes ?? []).every(
      (change, index) =>
        change.path === b.changes?.[index]?.path && change.kind === b.changes?.[index]?.kind,
    )
  );
}

function isSameSlashCommand(a: CodexSlashCommand, b: CodexSlashCommand | undefined): boolean {
  if (a === b) return true;
  if (!b) return false;
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.argumentHint === b.argumentHint &&
    a.source === b.source
  );
}

/**
 * Snapshots are small plain-JSON records (a few counters plus optional
 * rate-limit windows and category arrays), so structural equality is cheap and
 * cannot drift when the snapshot grows a field the way a hand-written compare
 * would.
 */
function isSameContextUsage(a: ContextUsageSnapshot, b: ContextUsageSnapshot): boolean {
  return deepEqualJson(a, b);
}

function shouldReplaceCodexMessage(existing: CodexMessage, incoming: CodexMessage): boolean {
  return !(
    Number.isInteger(existing.revision) &&
    Number.isInteger(incoming.revision) &&
    (incoming.revision as number) < (existing.revision as number)
  );
}

/**
 * Every map keyed by sessionKey, shared by the environment and tab sweeps so
 * the two cannot drift. A new session-keyed map goes here or it leaks.
 */
const CODEX_SESSION_KEYED_MAPS = [
  "sessions",
  /**
   * Codex has no reader for this map today: unlike Claude and OpenCode it never
   * reconciles `isLoading` from an asynchronous REST snapshot — `turnStatus`
   * from the bridge is the authoritative lifecycle signal and `refreshMessages`
   * only rehydrates the transcript. It is still listed here because the shared
   * slice populates it on every `setSessionLoading`, so omitting it would leak
   * one entry per closed Codex tab.
   */
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
] as const satisfies ReadonlyArray<keyof CodexState>;

export const useCodexStore = create<CodexState>()((set, get, api) => ({
  ...createNativeChatStoreSlice<CodexClient, CodexMessage, CodexAttachment, CodexQueuedMessage>({
    mergeMessages: mergeNativeMessagesPreservingClientOnly,
    shouldReplaceMessage: shouldReplaceCodexMessage,
  })(set, get, api),

  /**
   * Installs a live full-message frame.
   *
   * Codex streams authoritative user messages for backend-owned prompt
   * dispatches. A renderer-owned send already has an optimistic user row, so a
   * newly arriving user echo must pass through the same fingerprint merge as a
   * transcript snapshot. Otherwise direct sends briefly render twice while the
   * queue-only case renders correctly. Assistant updates keep the cheaper
   * id-based path because they cannot acknowledge optimistic user messages.
   */
  upsertMessage: (sessionKey, message) =>
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;
      const existingIndex = session.messages.findIndex((candidate) => candidate.id === message.id);
      const existing = existingIndex < 0 ? undefined : session.messages[existingIndex];
      if (existing && !shouldReplaceCodexMessage(existing, message)) {
        return state;
      }

      let messages: CodexMessage[];
      if (existingIndex >= 0) {
        messages = session.messages.slice();
        messages[existingIndex] = message;
      } else if (message.role === "user") {
        const authoritative = session.messages.filter(
          (candidate) => !isClientOnlyNativeMessage(candidate),
        );
        messages = mergeNativeMessagesPreservingClientOnly(session.messages, [
          ...authoritative,
          message,
        ]);
      } else {
        messages = [...session.messages, message];
      }

      const sessions = new Map(state.sessions);
      sessions.set(sessionKey, { ...session, messages });
      return { sessions };
    }),

  patchMessage: (sessionKey, patch) => {
    if (!patch?.messageId) return "needs-reconcile";
    let outcome: "applied" | "stale" | "needs-reconcile" = "needs-reconcile";
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;
      const index = session.messages.findIndex((message) => message.id === patch.messageId);
      const target = index < 0 ? undefined : session.messages[index];
      if (!target) return state;
      const result = classifyCodexMessagePatch(target, patch);
      outcome = result.outcome;
      if (result.outcome !== "applied") return state;
      const messages = session.messages.slice();
      messages[index] = result.message;
      const sessions = new Map(state.sessions);
      sessions.set(sessionKey, { ...session, messages });
      return { sessions };
    });
    return outcome;
  },

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
  promptDispatchClaims: new Map(),

  // Agent-specific actions
  setModels: (models) => set({ models: models.length > 0 ? models : CODEX_MODELS }),

  setSlashCommands: (environmentId, commands) =>
    set((state) => {
      const existing = state.slashCommands.get(environmentId);
      // Same rationale as `setPendingApprovals`: refreshes re-report the same
      // list with fresh array/object identities, and an always-new Map here
      // would rerender every subscriber for a no-op.
      if (commands.length === 0 && !existing) return state;
      if (
        existing &&
        existing.length === commands.length &&
        existing.every((entry, index) => isSameSlashCommand(entry, commands[index]))
      ) {
        return state;
      }
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
        existing.length === approvals.length &&
        existing.every((entry, index) => isSameApproval(entry, approvals[index]))
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
      .map((entry) => codexInteractionDraftKey(sessionKey, entry.interactionId));

    set((state) => {
      const existing = state.pendingInteractions.get(sessionKey) ?? [];
      // Same rationale as `setPendingApprovals`: reconcile calls this on every
      // tick, almost always with an empty list, so an always-new Map here would
      // rerender the whole tab. `expiresAt` is compared as well as the id because
      // the bridge re-reports a pending interaction with a refreshed deadline.
      if (
        existing.length === interactions.length &&
        existing.every(
          (entry, index) =>
            entry.interactionId === interactions[index]?.interactionId &&
            entry.expiresAt === interactions[index]?.expiresAt,
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
      const remaining = existing.filter((entry) => entry.interactionId !== interactionId);
      const next = new Map(state.pendingInteractions);
      if (remaining.length === 0) next.delete(sessionKey);
      else next.set(sessionKey, remaining);
      return { pendingInteractions: next };
    });
    // The interaction is resolved, so the in-progress input draft must not
    // survive to a future interaction that happens to reuse this id.
    usePromptDraftStore.getState().clearDraft(codexInteractionDraftKey(sessionKey, interactionId));
  },

  setContextUsage: (sessionKey, usage) =>
    set((state) => {
      const existing = state.contextUsage.get(sessionKey);
      // Value-equality bail: token accounting is re-reported on every event
      // batch, usually unchanged, and each write rerenders the compose bar.
      if (!usage && !existing) return state;
      if (usage && existing && isSameContextUsage(existing, usage)) return state;
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

  claimPromptDispatch: (sessionKey, requestId) => {
    let claimed = false;
    set((state) => {
      const current = state.promptDispatchClaims.get(sessionKey);
      if (current?.has(requestId)) return state;
      const next = new Map(state.promptDispatchClaims);
      next.set(sessionKey, new Set([...(current ?? []), requestId]));
      claimed = true;
      return { promptDispatchClaims: next };
    });
    return claimed;
  },

  releasePromptDispatch: (sessionKey, requestId) =>
    set((state) => {
      const current = state.promptDispatchClaims.get(sessionKey);
      if (!current?.has(requestId)) return state;
      const remaining = new Set(current);
      remaining.delete(requestId);
      const next = new Map(state.promptDispatchClaims);
      if (remaining.size === 0) next.delete(sessionKey);
      else next.set(sessionKey, remaining);
      return { promptDispatchClaims: next };
    }),

  settleUnconfirmedDispatch: (sessionKey) => {
    const state = get();
    const pending = state.unconfirmedDispatches.get(sessionKey);
    if (!pending) return "none";
    if (pending.retryable) return "retryable";

    const session = state.sessions.get(sessionKey);
    const optimisticStillPresent =
      session?.messages.some((message) => message.id === pending.userMessageId) === true;
    if (!optimisticStillPresent) {
      state.clearUnconfirmedDispatch(sessionKey);
      return "confirmed";
    }

    set((latest) => {
      const currentPending = latest.unconfirmedDispatches.get(sessionKey);
      const currentSession = latest.sessions.get(sessionKey);
      if (
        currentPending !== pending ||
        !currentSession?.messages.some((message) => message.id === pending.userMessageId)
      ) {
        return latest;
      }

      const sessions = new Map(latest.sessions);
      sessions.set(sessionKey, {
        ...currentSession,
        messages: currentSession.messages.filter((message) => message.id !== pending.userMessageId),
        error: CODEX_UNCONFIRMED_DISPATCH_ERROR,
      });
      const unconfirmedDispatches = new Map(latest.unconfirmedDispatches);
      unconfirmedDispatches.set(sessionKey, {
        ...pending,
        retryable: true,
      });
      return { sessions, unconfirmedDispatches };
    });
    return get().unconfirmedDispatches.get(sessionKey)?.retryable ? "retryable" : "confirmed";
  },

  isFastMode: (sessionKey) => get().fastMode.get(sessionKey) ?? false,

  clearEnvironment: (environmentId) => {
    // `pendingInteractions` is session-keyed, so the generic patch drops the
    // entries; the request-id-keyed drafts need an explicit sweep.
    const prefix = sessionKeyPrefixFor(environmentId);
    const sweptDraftKeys: string[] = [];
    for (const [sessionKey, interactions] of get().pendingInteractions) {
      if (!sessionKey.startsWith(prefix)) continue;
      for (const entry of interactions) {
        sweptDraftKeys.push(codexInteractionDraftKey(sessionKey, entry.interactionId));
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
    const sweptDraftKeys = (get().pendingInteractions.get(sessionKey) ?? []).map((entry) =>
      codexInteractionDraftKey(sessionKey, entry.interactionId),
    );
    set((state) => buildClearSessionPatch(state, sessionKey, CODEX_SESSION_KEYED_MAPS));
    usePromptDraftStore.getState().clearDrafts(sweptDraftKeys);
  },
}));

// Re-export for callers that still import types/helpers from here
export type { FileMention };
