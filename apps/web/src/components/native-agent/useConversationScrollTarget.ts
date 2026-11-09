import { useEffect, useMemo, useRef, useState } from "react";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import {
  CONVERSATION_TARGET_HIGHLIGHT_MS,
  type ConversationTargetHighlight,
} from "@/lib/transcript-scroll/conversation-target-highlight";
import {
  CONVERSATION_SCROLL_TARGET_SETTLED_GRACE_MS,
  conversationScrollTargetKey,
  resolveConversationScrollIndex,
  useConversationScrollTargetStore,
} from "@/stores/conversationScrollTargetStore";

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
  scrollToIndex: (
    index: number,
    anchor?: { rowKey?: string; offset?: number },
    owner?: "message-link",
  ) => boolean;
  /** Overrides for tests. */
  loadEarlier?: () => Promise<unknown>;
  settledGraceMs?: number;
  highlightMs?: number;
}

/**
 * Consumes this tab's pending "scroll to message" request (see
 * `conversationScrollTargetStore`) once the chat is active and the message is
 * rendered, and returns the row to highlight briefly. Every jump returns a new
 * generation, so jumping to the same row again restarts its highlight.
 *
 * A request that cannot be placed is dropped rather than held: shortly after
 * the transcript settles without the message (it may be outside the loaded
 * window), or at the request's TTL, whichever is first. The reader is then
 * simply left where the chat put them, at the bottom.
 *
 * Only requests for this chat's own node (its scope's) are read.
 */
export function useConversationScrollTarget({
  environmentId,
  tabId,
  isActive,
  messages,
  turnBoundaries,
  transcriptSettled,
  scrollToIndex,
  loadEarlier,
  settledGraceMs = CONVERSATION_SCROLL_TARGET_SETTLED_GRACE_MS,
  highlightMs = CONVERSATION_TARGET_HIGHLIGHT_MS,
}: UseConversationScrollTargetOptions): ConversationTargetHighlight | null {
  const nodeId = useScopesWithCommandFallback().scope.nodeId;
  const ref = useMemo(() => ({ nodeId, environmentId, tabId }), [nodeId, environmentId, tabId]);
  const pending = useConversationScrollTargetStore(
    (state) => state.targets.get(conversationScrollTargetKey(ref)) ?? null,
  );
  const clear = useConversationScrollTargetStore((state) => state.clear);
  const [highlight, setHighlight] = useState<ConversationTargetHighlight | null>(null);
  const highlightGeneration = useRef(0);

  const targetIndex = useMemo(
    () => (pending ? resolveConversationScrollIndex(messages, pending, turnBoundaries) : -1),
    [messages, pending, turnBoundaries],
  );
  const targetMessageId = targetIndex >= 0 ? (messages[targetIndex]?.id ?? null) : null;

  // Jump once the message is on screen and the tab is visible.
  useEffect(() => {
    if (!pending || !isActive || targetIndex < 0 || !targetMessageId) return;
    if (pending.expiresAt <= Date.now()) {
      clear(ref, pending.nonce);
      return;
    }
    let attempts = 0;
    let frame: number | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const attempt = () => {
      frame = null;
      retry = null;
      // The view's activation policy defers to this pending request
      // (`explicitTargetPending`), so no ordering between effects decides
      // the outcome; the navigation retires anything still in flight.
      if (scrollToIndex(targetIndex, { rowKey: targetMessageId }, "message-link")) {
        clear(ref, pending.nonce);
        highlightGeneration.current += 1;
        setHighlight({
          messageId: targetMessageId,
          generation: highlightGeneration.current,
          durationMs: highlightMs,
        });
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
  }, [clear, highlightMs, isActive, pending, ref, scrollToIndex, targetIndex, targetMessageId]);

  const paging = useRef<Promise<unknown> | null>(null);
  // Read one page at a time. The request TTL bounds missing/deleted anchors.
  useEffect(() => {
    if (
      !pending ||
      !isActive ||
      targetIndex >= 0 ||
      !loadEarlier ||
      pending.expiresAt <= Date.now()
    )
      return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        // A transcript update may restart this effect while its read is pending.
        // Join that read; never supersede it with another sequence number.
        const request = paging.current ?? loadEarlier();
        paging.current = request;
        try {
          await request;
        } finally {
          if (paging.current === request) paging.current = null;
        }
      } catch {
        if (!stopped) clear(ref, pending.nonce);
        return;
      }
      if (!stopped)
        retry = setTimeout(() => {
          void load();
        }, 100);
    };
    void load();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
    };
  }, [pending, isActive, targetIndex, loadEarlier, messages, clear, ref]);

  // Bounded wait for a message that has not appeared.
  const unresolvedAfterSettle =
    Boolean(pending) && isActive && transcriptSettled && targetIndex < 0 && !loadEarlier;
  useEffect(() => {
    if (!pending) return;
    const remaining = Math.max(0, pending.expiresAt - Date.now());
    const delay = unresolvedAfterSettle ? Math.min(remaining, settledGraceMs) : remaining;
    const timer = setTimeout(() => clear(ref, pending.nonce), delay);
    return () => clearTimeout(timer);
  }, [clear, pending, ref, settledGraceMs, unresolvedAfterSettle]);

  // A new jump replaces the object, so the period restarts with it.
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), highlight.durationMs);
    return () => clearTimeout(timer);
  }, [highlight]);

  return highlight;
}
