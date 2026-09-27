import { useEffect, useMemo, useState } from "react";
import {
  CONVERSATION_SCROLL_TARGET_SETTLED_GRACE_MS,
  conversationScrollTargetKey,
  resolveConversationScrollIndex,
  useConversationScrollTargetStore,
} from "@/stores/conversationScrollTargetStore";

/** How long the jumped-to message stays highlighted. */
export const CONVERSATION_TARGET_HIGHLIGHT_MS = 2_500;
/**
 * Retries while the list handle is not ready (the shell can still be showing
 * its connecting state). Bounded; after that the request waits for the next
 * transcript change or its expiry.
 */
const SCROLL_READY_MAX_ATTEMPTS = 40;
const SCROLL_READY_RETRY_MS = 50;

interface UseConversationScrollTargetOptions {
  environmentId: string;
  tabId: string;
  /** The chat is the visible tab; a jump is only performed when it is. */
  isActive: boolean;
  /** The rows exactly as rendered (their `id` is the list item key). */
  messages: ReadonlyArray<{ id: string }>;
  turnBoundaries?: ReadonlyArray<{ turnId: string; messageId?: string }>;
  /**
   * The transcript has been read and is current. Until then a missing message
   * may simply not have loaded yet, so the request keeps waiting.
   */
  transcriptSettled: boolean;
  /** Scroll the list to one row; false when the list is not ready yet. */
  scrollToIndex: (index: number) => boolean;
  /** Overrides for tests. */
  settledGraceMs?: number;
  highlightMs?: number;
}

/**
 * Consumes this tab's pending "scroll to message" request (see
 * `conversationScrollTargetStore`) once the chat is active and the message is
 * rendered, and returns the id of the row to highlight briefly.
 *
 * A request that cannot be placed is dropped rather than held: shortly after
 * the transcript settles without the message (it may be outside the loaded
 * window), or at the request's TTL, whichever is first. The reader is then
 * simply left where the chat put them, at the bottom.
 */
export function useConversationScrollTarget({
  environmentId,
  tabId,
  isActive,
  messages,
  turnBoundaries,
  transcriptSettled,
  scrollToIndex,
  settledGraceMs = CONVERSATION_SCROLL_TARGET_SETTLED_GRACE_MS,
  highlightMs = CONVERSATION_TARGET_HIGHLIGHT_MS,
}: UseConversationScrollTargetOptions): string | null {
  const pending = useConversationScrollTargetStore(
    (state) => state.targets.get(conversationScrollTargetKey(environmentId, tabId)) ?? null,
  );
  const clear = useConversationScrollTargetStore((state) => state.clear);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  const targetIndex = useMemo(
    () => (pending ? resolveConversationScrollIndex(messages, pending, turnBoundaries) : -1),
    [messages, pending, turnBoundaries],
  );
  const targetMessageId = targetIndex >= 0 ? (messages[targetIndex]?.id ?? null) : null;

  // Jump once the message is on screen and the tab is visible.
  useEffect(() => {
    if (!pending || !isActive || targetIndex < 0 || !targetMessageId) return;
    if (pending.expiresAt <= Date.now()) {
      clear(environmentId, tabId, pending.nonce);
      return;
    }
    let attempts = 0;
    let frame: number | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const attempt = () => {
      frame = null;
      retry = null;
      // Deferred one frame so the activation jump-to-bottom scheduled by the
      // same commit runs first; `scrollToIndex` then retires it.
      if (scrollToIndex(targetIndex)) {
        clear(environmentId, tabId, pending.nonce);
        setHighlightedMessageId(targetMessageId);
        return;
      }
      attempts += 1;
      if (attempts < SCROLL_READY_MAX_ATTEMPTS) retry = setTimeout(attempt, SCROLL_READY_RETRY_MS);
    };
    frame = requestAnimationFrame(attempt);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (retry !== null) clearTimeout(retry);
    };
  }, [clear, environmentId, isActive, pending, scrollToIndex, tabId, targetIndex, targetMessageId]);

  // Bounded wait for a message that has not appeared.
  const unresolvedAfterSettle =
    Boolean(pending) && isActive && transcriptSettled && targetIndex < 0;
  useEffect(() => {
    if (!pending) return;
    const remaining = Math.max(0, pending.expiresAt - Date.now());
    const delay = unresolvedAfterSettle ? Math.min(remaining, settledGraceMs) : remaining;
    const timer = setTimeout(() => clear(environmentId, tabId, pending.nonce), delay);
    return () => clearTimeout(timer);
  }, [clear, environmentId, pending, settledGraceMs, tabId, unresolvedAfterSettle]);

  useEffect(() => {
    if (!highlightedMessageId) return;
    const timer = setTimeout(() => setHighlightedMessageId(null), highlightMs);
    return () => clearTimeout(timer);
  }, [highlightMs, highlightedMessageId]);

  return highlightedMessageId;
}
