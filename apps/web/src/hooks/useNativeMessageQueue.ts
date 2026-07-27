import { useCallback, useEffect, useRef } from "react";

/** The slice of a native chat store the drain needs. */
interface QueueStoreState<TQueued> {
  draftText: Map<string, string>;
  attachments: Map<string, unknown[]>;
  sessions: Map<string, { isLoading: boolean }>;
  messageQueue: Map<string, TQueued[]>;
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
   * Claims the next queued prompt, resolving null when there is nothing to
   * send. The claim is arbitrated by the backend queue mirror (see
   * prompt-queue-persistence): the store is only the optimistic front, and two
   * clients must not both take the same head, so the head is not removed
   * locally — it is claimed through this callback.
   */
  claimHead: () => Promise<TQueued | null>;
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
  claimHead,
  send,
  onError,
}: UseNativeMessageQueueOptions<TQueued>): void {
  const isProcessingRef = useRef(false);
  const processRef = useRef<() => void>(() => {});
  // Held in refs so `process` stays stable and the effect below does not
  // re-enter simply because the caller re-rendered.
  const claimHeadRef = useRef(claimHead);
  const sendRef = useRef(send);
  const onErrorRef = useRef(onError);
  claimHeadRef.current = claimHead;
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
    if ((state.messageQueue.get(sessionKey)?.length ?? 0) === 0) return;

    // Set before the asynchronous claim begins so a second render cannot start
    // a competing claim for this client.
    isProcessingRef.current = true;
    /**
     * Whether this pass actually consumed an entry — dispatched it, or failed
     * trying. Only then may the re-drive below fire.
     *
     * A denied claim (the backend gave the head to another client), a failed
     * claim, and a requeue all leave the queue exactly as it was, so re-driving
     * on those would immediately re-attempt the same entry and spin.
     */
    let consumedEntry = false;
    claimHeadRef.current()
      .then((entry) => {
        if (!entry) return;

        let sendPromise: Promise<unknown> | undefined;
        try {
          sendPromise = sendRef.current(entry);
        } catch (error) {
          // A synchronous throw must behave exactly like a rejection —
          // escaping here would leave the re-entrancy flag stuck and the
          // drain dead for the rest of the mount.
          consumedEntry = true;
          console.error(`[${agentLabel}ChatTab] Failed to send queued prompt:`, error);
          onErrorRef.current(error, entry);
          return;
        }
        if (!sendPromise) {
          // The entry was already claimed, so dropping it here would lose the
          // user's prompt silently. Put it back and wait to be re-driven by a
          // dependency change — re-driving from here would re-claim the entry
          // the sender just refused.
          store.getState().requeueToFront(sessionKey, entry);
          return;
        }
        consumedEntry = true;
        return sendPromise.catch((error) => {
          console.error(`[${agentLabel}ChatTab] Failed to send queued prompt:`, error);
          onErrorRef.current(error, entry);
        });
      })
      .catch((error) => {
        // The claim itself failed — nothing was dequeued, nothing is lost, and
        // the next drain pass will retry against the backend.
        console.error(`[${agentLabel}ChatTab] Failed to claim queued prompt:`, error);
      })
      .finally(() => {
        isProcessingRef.current = false;
        /**
         * Normally the effect below drives the next drain, so this does not
         * recurse. But that effect can fire *while* this send is still in
         * flight — the re-entrancy guard above turns that into a no-op — and if
         * the turn settled in the same pass there is no later dependency change
         * to retry on, stranding the rest of the queue. Only re-enter when this
         * pass consumed an entry and the queue is genuinely idle with work
         * left; each such pass removes one entry, so this cannot spin.
         */
        const settled = store.getState();
        if (
          consumedEntry
          && (settled.messageQueue.get(sessionKey)?.length ?? 0) > 0
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
