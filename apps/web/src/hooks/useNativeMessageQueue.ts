import { useCallback, useEffect, useRef } from "react";

/** The slice of a native chat store the drain needs. */
interface QueueStoreState<TQueued> {
  draftText: Map<string, string>;
  attachments: Map<string, unknown[]>;
  sessions: Map<string, { isLoading: boolean }>;
  messageQueue: Map<string, TQueued[]>;
  removeFromQueue: (sessionKey: string) => TQueued | undefined;
  requeueToFront: (sessionKey: string, message: TQueued) => void;
}

interface QueueStore<TQueued> {
  getState: () => QueueStoreState<TQueued>;
}

interface UseNativeMessageQueueOptions<TQueued> {
  agentLabel: string;
  sessionKey: string;
  store: QueueStore<TQueued>;
  /** False while disconnected, mid-setup, or otherwise unable to dispatch. */
  canDrain: boolean;
  /** Drives the effect — re-runs when work arrives. */
  queueLength: number;
  /** Drives the effect — re-runs when the running turn settles. */
  isLoading: boolean;
  /**
   * True while the composer holds an unsent draft.
   *
   * Passed in rather than only read inside `process` so that clearing the
   * draft re-runs the effect: otherwise a queue blocked behind a draft would
   * sit there until some other dependency happened to change.
   */
  blockedByDraft: boolean;
  /**
   * Dispatch one entry. Returning undefined means the sender was not ready; the
   * entry is put back at the head of the queue and the drain stops without
   * consuming further entries. Any resolved value is ignored — only settling
   * matters.
   */
  send: (entry: TQueued) => Promise<unknown> | undefined;
  /** Report a failed dispatch — each agent surfaces this its own way. */
  onError: (error: unknown, entry: TQueued) => void;
}

/**
 * Drain queued prompts one at a time as the session becomes able to accept them.
 *
 * The three tabs each had their own version with a different bug profile:
 * Claude reset its re-entrancy flag on a 100ms timer and never re-drove the
 * drain, so a queue could strand; OpenCode re-entered through an unconditional
 * `queueMicrotask` with no queue-length or loading check. This is Codex's
 * version, which was the correct one, generalised.
 */
export function useNativeMessageQueue<TQueued>({
  agentLabel,
  sessionKey,
  store,
  canDrain,
  queueLength,
  isLoading,
  blockedByDraft,
  send,
  onError,
}: UseNativeMessageQueueOptions<TQueued>): void {
  const isProcessingRef = useRef(false);
  const processRef = useRef<() => void>(() => {});
  // Held in refs so `process` stays stable and the effect below does not
  // re-enter simply because the caller re-rendered.
  const sendRef = useRef(send);
  const onErrorRef = useRef(onError);
  sendRef.current = send;
  onErrorRef.current = onError;

  const process = useCallback(() => {
    if (isProcessingRef.current) return;
    if (!canDrain) return;

    const state = store.getState();

    // A draft in progress owns the composer. Draining under it would send the
    // queued prompt while the user is still typing their next one.
    if (
      (state.draftText.get(sessionKey)?.trim().length ?? 0) > 0
      || (state.attachments.get(sessionKey)?.length ?? 0) > 0
    ) {
      return;
    }

    const session = state.sessions.get(sessionKey);
    if (!session || session.isLoading) return;

    const entry = state.removeFromQueue(sessionKey);
    if (!entry) return;

    isProcessingRef.current = true;

    const sendPromise = sendRef.current(entry);
    if (!sendPromise) {
      // The entry was already dequeued, so dropping it here would lose the
      // user's prompt silently. Put it back and wait to be re-driven.
      state.requeueToFront(sessionKey, entry);
      isProcessingRef.current = false;
      return;
    }

    sendPromise
      .catch((error) => {
        console.error(`[${agentLabel}ChatTab] Failed to send queued prompt:`, error);
        onErrorRef.current(error, entry);
      })
      .finally(() => {
        isProcessingRef.current = false;
        /**
         * Normally the effect below drives the next drain, so this does not
         * recurse. But that effect can fire *while* this send is still in
         * flight — the re-entrancy guard above turns that into a no-op — and if
         * the turn settled in the same pass there is no later dependency change
         * to retry on, stranding the rest of the queue. Only re-enter when the
         * queue is genuinely idle with work left; each pass dequeues one entry,
         * so this cannot spin.
         */
        const settled = store.getState();
        if (
          (settled.messageQueue.get(sessionKey)?.length ?? 0) > 0
          && settled.sessions.get(sessionKey)?.isLoading !== true
        ) {
          processRef.current();
        }
      });
  }, [agentLabel, canDrain, sessionKey, store]);

  useEffect(() => {
    processRef.current = process;
  }, [process]);

  useEffect(() => {
    if (queueLength > 0 && !blockedByDraft) {
      process();
    }
    // `isLoading` and `blockedByDraft` are dependencies rather than reads: the
    // drain must re-run when the running turn settles or the draft clears, not
    // only when the queue changes.
  }, [process, queueLength, isLoading, blockedByDraft]);
}
