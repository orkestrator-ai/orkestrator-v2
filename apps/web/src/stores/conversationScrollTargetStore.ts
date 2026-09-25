import { create } from "zustand";

/**
 * Pending "scroll this chat to a message" requests, keyed by environment and
 * tab.
 *
 * A request is made by navigation (e.g. "Open full conversation" on a web
 * annotation) before the destination chat is necessarily mounted, active, or
 * holding the message: the tab may be in another pane, its transcript may
 * still be loading, or the message may be outside the loaded window. The chat
 * consumes the request once the message is present and clears it; otherwise it
 * expires, so a stale request can never yank a reader around later.
 *
 * Renderer-only view state: it carries identifiers, never message content.
 */

export interface ConversationScrollTarget {
  /** Transcript message id (`NativeMessage.id` / projection message id). */
  messageId?: string;
  /** Turn id, resolved through the projection's `turnBoundaries`. */
  turnId?: string;
}

export interface PendingConversationScrollTarget extends ConversationScrollTarget {
  /** Distinguishes repeated requests for the same message. */
  nonce: number;
  requestedAt: number;
  expiresAt: number;
}

/** How long an unresolved request stays pending. */
export const CONVERSATION_SCROLL_TARGET_TTL_MS = 30_000;
/**
 * Once the transcript has settled without the message, how long to keep
 * waiting for it (a streamed echo or a late page) before giving up and
 * leaving the reader at the bottom.
 */
export const CONVERSATION_SCROLL_TARGET_SETTLED_GRACE_MS = 3_000;
/** Bounded: one request per tab, and at most this many tabs at once. */
export const MAX_PENDING_CONVERSATION_SCROLL_TARGETS = 32;

export function conversationScrollTargetKey(environmentId: string, tabId: string): string {
  return `${environmentId}\u0000${tabId}`;
}

interface ConversationScrollTargetState {
  targets: Map<string, PendingConversationScrollTarget>;
  /** Replaces any earlier request for this tab (the "next attempt" wins). */
  request: (
    environmentId: string,
    tabId: string,
    target: ConversationScrollTarget,
    now?: number,
  ) => PendingConversationScrollTarget | null;
  /** Unexpired request for this tab, if any. */
  peek: (
    environmentId: string,
    tabId: string,
    now?: number,
  ) => PendingConversationScrollTarget | null;
  /**
   * Clears the request, but only if it is still the one identified by
   * `nonce` — a newer request made meanwhile is left alone.
   */
  clear: (environmentId: string, tabId: string, nonce?: number) => void;
}

let nextNonce = 1;

function nonBlank(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export const useConversationScrollTargetStore = create<ConversationScrollTargetState>(
  (set, get) => ({
    targets: new Map(),

    request: (environmentId, tabId, target, now = Date.now()) => {
      const messageId = nonBlank(target.messageId);
      const turnId = nonBlank(target.turnId);
      const key = conversationScrollTargetKey(environmentId, tabId);
      const targets = new Map(get().targets);
      // Prune expired requests on every write so the map stays bounded even
      // for tabs that never mounted to consume theirs.
      for (const [candidateKey, candidate] of Array.from(targets)) {
        if (candidate.expiresAt <= now) targets.delete(candidateKey);
      }
      targets.delete(key);
      if (!messageId && !turnId) {
        set({ targets });
        return null;
      }
      const pending: PendingConversationScrollTarget = {
        ...(messageId ? { messageId } : {}),
        ...(turnId ? { turnId } : {}),
        nonce: nextNonce++,
        requestedAt: now,
        expiresAt: now + CONVERSATION_SCROLL_TARGET_TTL_MS,
      };
      targets.set(key, pending);
      while (targets.size > MAX_PENDING_CONVERSATION_SCROLL_TARGETS) {
        const oldest = targets.keys().next().value;
        if (oldest === undefined) break;
        targets.delete(oldest);
      }
      set({ targets });
      return pending;
    },

    peek: (environmentId, tabId, now = Date.now()) => {
      const pending = get().targets.get(conversationScrollTargetKey(environmentId, tabId));
      return pending && pending.expiresAt > now ? pending : null;
    },

    clear: (environmentId, tabId, nonce) => {
      const key = conversationScrollTargetKey(environmentId, tabId);
      const current = get().targets.get(key);
      if (!current || (nonce !== undefined && current.nonce !== nonce)) return;
      const targets = new Map(get().targets);
      targets.delete(key);
      set({ targets });
    },
  }),
);

/** Test helper: forget every pending request. */
export function resetConversationScrollTargets(): void {
  useConversationScrollTargetStore.setState({ targets: new Map() });
}

/**
 * Index of the rendered row for a scroll target, or -1.
 *
 * How the ids line up (see `anchorInProjection` in the backend's
 * `web-annotation-dispatch.ts`, which records `WebAnnotationTranscriptRef`):
 *
 * - `transcript.messageId` is the `id` of the *user* message in the native
 *   runtime projection whose content carries the request marker. The renderer
 *   keeps projection message ids as `NativeMessage.id`; normalization only
 *   re-ids the *later* blocks of a split assistant message
 *   (`<id>:text-block:<n>`), so a user message id is rendered unchanged. A
 *   `<id>:` prefix match is still accepted so a split row resolves to its
 *   first block.
 * - `transcript.turnId` is the `turnId` of the projection's `turnBoundaries`
 *   entry whose `messageId` is that message. With only a turn id we map it back
 *   through the same boundaries; a turn with no boundary in the loaded window
 *   cannot be placed and resolves to -1. When both are known the message id
 *   wins and the turn is the fallback.
 */
export function resolveConversationScrollIndex(
  messages: ReadonlyArray<{ id: string }>,
  target: ConversationScrollTarget,
  turnBoundaries?: ReadonlyArray<{ turnId: string; messageId?: string }>,
): number {
  const turnMessageId = target.turnId
    ? nonBlank(turnBoundaries?.find((boundary) => boundary.turnId === target.turnId)?.messageId)
    : undefined;
  for (const messageId of [nonBlank(target.messageId), turnMessageId]) {
    if (!messageId) continue;
    const exact = messages.findIndex((message) => message.id === messageId);
    if (exact >= 0) return exact;
    const prefix = `${messageId}:`;
    const split = messages.findIndex((message) => message.id.startsWith(prefix));
    if (split >= 0) return split;
  }
  return -1;
}
