import { useCallback, useEffect, useRef } from "react";

/** The slice of a native chat store the drain needs. */
interface QueueStoreState<TQueued extends { id: string }> {
  draftText: Map<string, string>;
  attachments: Map<string, unknown[]>;
  sessions: Map<string, { isLoading: boolean }>;
  messageQueue: Map<string, TQueued[]>;
}

interface QueueStore<TQueued extends { id: string }> {
  getState: () => QueueStoreState<TQueued>;
}

export interface ClaimedQueueEntry<TQueued> {
  entry: TQueued;
  claimToken: string;
}

export type QueueDispatchOutcome = "accepted" | "rejected" | "unknown";

interface UseNativeMessageQueueOptions<TQueued extends { id: string }> {
  agentLabel: string;
  sessionKey: string;
  store: QueueStore<TQueued>;
  /** False while disconnected, mid-setup, or otherwise unable to dispatch. */
  canDrain: boolean;
  /** Drives the effect — re-runs when work arrives. */
  queueLength: number;
  /** Re-drives a denied stale claim even when the queue length stayed equal. */
  queueHeadId?: string;
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
   * send. The claim is arbitrated by the authoritative backend queue; the
   * store is only a read projection, and two clients must not both take the
   * same head, so it is claimed through this callback.
   */
  claimHead: () => Promise<ClaimedQueueEntry<TQueued> | null>;
  /** Permanently removes a claim after the agent accepted the dispatch. */
  acknowledgeClaim: (claimToken: string) => Promise<void>;
  /** Restores a claim after the agent definitively declined the dispatch. */
  rejectClaim: (claimToken: string) => Promise<void>;
  /**
   * Dispatch one entry. Returning undefined means the sender was not ready; the
   * claim is rejected back to the head and the drain stops without consuming
   * further entries. A resolved outcome decides whether the durable claim is
   * acknowledged, rejected, or retained while an ambiguous dispatch recovers.
   */
  send: (
    entry: TQueued,
  ) => Promise<QueueDispatchOutcome | void> | undefined;
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
export function useNativeMessageQueue<TQueued extends { id: string }>({
  agentLabel,
  sessionKey,
  store,
  canDrain,
  queueLength,
  queueHeadId,
  isLoading,
  blockedByDraft,
  claimHead,
  acknowledgeClaim,
  rejectClaim,
  send,
  onError,
}: UseNativeMessageQueueOptions<TQueued>): void {
  const isProcessingRef = useRef(false);
  const processRef = useRef<() => void>(() => {});
  const mountedRef = useRef(true);
  const settlementRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retrySettlementRef = useRef<
    (
      operation: "acknowledge" | "reject",
      claim: ClaimedQueueEntry<TQueued>,
      attempt: number,
      reported: boolean,
    ) => Promise<boolean>
  >(async () => false);
  // Held in refs so `process` stays stable and the effect below does not
  // re-enter simply because the caller re-rendered.
  const claimHeadRef = useRef(claimHead);
  const acknowledgeClaimRef = useRef(acknowledgeClaim);
  const rejectClaimRef = useRef(rejectClaim);
  const sendRef = useRef(send);
  const onErrorRef = useRef(onError);
  claimHeadRef.current = claimHead;
  acknowledgeClaimRef.current = acknowledgeClaim;
  rejectClaimRef.current = rejectClaim;
  sendRef.current = send;
  onErrorRef.current = onError;

  retrySettlementRef.current = async (operation, claim, attempt, reported) => {
    try {
      await (
        operation === "acknowledge"
          ? acknowledgeClaimRef.current(claim.claimToken)
          : rejectClaimRef.current(claim.claimToken)
      );
      return true;
    } catch (error) {
      if (!reported) {
        const detail = error instanceof Error ? error.message : "Unknown error";
        const recoveryError = new Error(
          operation === "acknowledge"
            ? `The prompt was sent, but its queue claim could not be acknowledged: ${detail}`
            : `The prompt was not sent and could not yet be restored to the queue: ${detail}`,
          { cause: error },
        );
        console.error(
          `[${agentLabel}ChatTab] Failed to ${operation} queued prompt claim:`,
          error,
        );
        onErrorRef.current(recoveryError, claim.entry);
      }
      if (!mountedRef.current) return false;

      // Keep ownership of the durable claim and retry settlement. Rejecting an
      // acknowledged dispatch would duplicate it; abandoning a failed reject
      // would hide the prompt until the backend lease expires.
      const delay = Math.min(250 * (2 ** attempt), 30_000);
      settlementRetryTimerRef.current = setTimeout(() => {
        settlementRetryTimerRef.current = null;
        // Snapshot application during settlement may re-render the hook. Keep
        // the normal drain guard raised until this retry fully finishes.
        isProcessingRef.current = true;
        void retrySettlementRef.current(
          operation,
          claim,
          attempt + 1,
          true,
        ).then((settled) => {
          isProcessingRef.current = false;
          // A recovered acknowledgement may unblock the next queue entry. A
          // recovered reject restored the same head and must wait for a real
          // dependency change, otherwise an unavailable sender hot-loops.
          if (settled && operation === "acknowledge") processRef.current();
        }).catch(() => {
          // `retrySettlementRef` handles operation failures itself; this is a
          // last-resort guard against wedging the drain on an implementation
          // error in the recovery path.
          isProcessingRef.current = false;
        });
      }, delay);
      return false;
    }
  };

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
    const headBeforeClaimId = state.messageQueue.get(sessionKey)?.[0]?.id;
    /**
     * Whether this pass actually consumed an entry — dispatched it, or failed
     * trying. Only then may the re-drive below fire.
     *
     * A failed claim and a requeue leave the same head in place, so re-driving
     * would immediately retry and spin. A denied stale claim is re-driven only
     * when the returned authoritative snapshot changed the head.
     */
    let consumedEntry = false;
    let authoritativeHeadChanged = false;
    void (async () => {
      let claim: ClaimedQueueEntry<TQueued> | null;
      try {
        claim = await claimHeadRef.current();
        if (!claim) {
          authoritativeHeadChanged =
            store.getState().messageQueue.get(sessionKey)?.[0]?.id
            !== headBeforeClaimId;
          return;
        }
      } catch (error) {
        // The claim itself failed — nothing was dequeued, nothing is lost, and
        // the next drain pass will retry against the backend.
        console.error(`[${agentLabel}ChatTab] Failed to claim queued prompt:`, error);
        return;
      }

      let sendPromise: Promise<QueueDispatchOutcome | void> | undefined;
      try {
        sendPromise = sendRef.current(claim.entry);
      } catch (error) {
        console.error(`[${agentLabel}ChatTab] Failed to send queued prompt:`, error);
        onErrorRef.current(error, claim.entry);
        await retrySettlementRef.current("reject", claim, 0, false);
        return;
      }
      if (!sendPromise) {
        // The sender was not ready after the durable claim was granted. Nack it
        // immediately so the authoritative backend restores the same head.
        await retrySettlementRef.current("reject", claim, 0, false);
        return;
      }

      try {
        const outcome = await sendPromise;
        if (outcome === "unknown") {
          // The request may already be running. Retain the durable lease: an
          // ack could lose an unaccepted prompt and a reject could duplicate a
          // request that the agent did accept.
          return;
        }
        if (outcome === "rejected") {
          await retrySettlementRef.current("reject", claim, 0, false);
          return;
        }
        consumedEntry = true;
        await retrySettlementRef.current("acknowledge", claim, 0, false);
      } catch (error) {
        console.error(`[${agentLabel}ChatTab] Failed to send queued prompt:`, error);
        onErrorRef.current(error, claim.entry);
        await retrySettlementRef.current("reject", claim, 0, false);
      }
    })()
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
          (consumedEntry || authoritativeHeadChanged)
          && (settled.messageQueue.get(sessionKey)?.length ?? 0) > 0
          && settled.sessions.get(sessionKey)?.isLoading !== true
        ) {
          processRef.current();
        }
      });
  }, [agentLabel, canDrain, sessionKey, store]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (settlementRetryTimerRef.current) {
        clearTimeout(settlementRetryTimerRef.current);
        settlementRetryTimerRef.current = null;
      }
    };
  }, []);

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
  }, [process, queueLength, queueHeadId, isLoading, blockedByDraft]);
}
