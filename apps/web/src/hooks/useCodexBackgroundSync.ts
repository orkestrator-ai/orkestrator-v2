import { useEffect } from "react";
import {
  fetchPendingApprovals,
  fetchPendingInteractions,
  getSessionMessages,
  lookupSessionActivity,
  lookupSessionStatus,
  type CodexClient,
  type CodexMessage,
  type CodexSessionStatusLookupResult,
  type CodexSessionActivityLookupResult,
} from "@/lib/codex-client";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { getEnvironmentIdFromSessionKey } from "@/lib/utils";
import {
  CODEX_UNCONFIRMED_DISPATCH_ERROR,
  useCodexStore,
} from "@/stores/codexStore";

export interface CodexBackgroundSyncDependencies {
  lookupSessionActivity: (
    client: CodexClient,
    sessionId: string,
  ) => Promise<CodexSessionActivityLookupResult>;
  lookupSessionStatus: (
    client: CodexClient,
    sessionId: string,
  ) => Promise<CodexSessionStatusLookupResult>;
  getSessionMessages: typeof getSessionMessages;
  fetchPendingApprovals: typeof fetchPendingApprovals;
  fetchPendingInteractions: typeof fetchPendingInteractions;
}

export interface CodexBackgroundSynchronizerOptions {
  /**
   * Injected for tests. `useCodexBackgroundSync` keys its effect on this
   * object's identity, so a caller must hoist it rather than pass a literal —
   * otherwise every render disposes and recreates the synchronizer.
   */
  dependencies?: CodexBackgroundSyncDependencies;
  /** Retry delays for transient authoritative-read failures. */
  retryDelaysMs?: readonly number[];
  /**
   * Level-triggered floor between authoritative passes while any session is
   * still loading. `0` disables it.
   */
  safetyIntervalMs?: number;
}

/**
 * A bridge that answers 404 on the non-touching activity route is either older
 * than the route or not the bridge we think it is. Neither is recoverable from
 * the renderer, so the turn stays locked, but the user is told why instead of
 * watching a silent spinner.
 */
export const CODEX_ACTIVITY_UNSUPPORTED_ERROR =
  "This Codex bridge does not support the session activity endpoint. "
  + "Restart the environment to reconnect.";

const DEFAULT_SAFETY_INTERVAL_MS = 30_000;

const DEFAULT_DEPENDENCIES: CodexBackgroundSyncDependencies = {
  lookupSessionActivity,
  lookupSessionStatus,
  getSessionMessages,
  fetchPendingApprovals,
  fetchPendingInteractions,
};

interface SessionTarget {
  sessionKey: string;
  sessionId: string;
  turnId: string | undefined;
  /** Renderer lifecycle generation used until the bridge supplies turnId. */
  loadingRevision: number;
  client: CodexClient;
}

function targetId(target: SessionTarget): string {
  return [
    target.sessionKey,
    target.sessionId,
    target.turnId ?? `local:${target.loadingRevision}`,
  ].join("\u0000");
}

/**
 * True only while this is still the turn the request was started for.
 *
 * Session ids survive across turns, so checking only the id lets a delayed
 * `idle` response from the previous turn unlock a newly started one. The turn
 * id is issued by the bridge and survives renderer reloads.
 */
function isCurrentTurn(target: SessionTarget): boolean {
  const state = useCodexStore.getState();
  const current = state.sessions.get(target.sessionKey);
  if (current?.sessionId !== target.sessionId || !current.isLoading) return false;
  if (target.turnId !== undefined) return current.turnId === target.turnId;
  return current.turnId === undefined
    && (state.sessionLoadingRevisions.get(target.sessionKey) ?? 0)
      === target.loadingRevision;
}

function clearPendingInput(sessionKey: string): void {
  const state = useCodexStore.getState();
  state.setPendingApprovals(sessionKey, []);
  state.setPendingInteractions(sessionKey, []);
}

function discardUnconfirmedDispatch(sessionKey: string): void {
  const state = useCodexStore.getState();
  const pending = state.unconfirmedDispatches.get(sessionKey);
  if (!pending) return;
  state.clearUnconfirmedDispatch(sessionKey);
  state.removeMessage(sessionKey, pending.userMessageId);
}

function currentTargets(): SessionTarget[] {
  const state = useCodexStore.getState();
  const targets: SessionTarget[] = [];
  for (const [sessionKey, session] of state.sessions) {
    if (!session.isLoading) continue;
    const environmentId = getEnvironmentIdFromSessionKey(sessionKey);
    if (!environmentId) continue;
    const client = state.clients.get(environmentId);
    if (!client) continue;
    targets.push({
      sessionKey,
      sessionId: session.sessionId,
      turnId: session.turnId,
      loadingRevision: state.sessionLoadingRevisions.get(sessionKey) ?? 0,
      client,
    });
  }
  return targets;
}

/**
 * Reconciles Codex sessions independently of any environment's React tree.
 *
 * A foreground `CodexChatTab` owns the low-latency SSE stream, but switching
 * environments may unmount and remount that tab. This app-level synchronizer
 * treats `/activity`, `/status`, `/messages`, `/approvals`, and `/interactions` as the
 * authoritative catch-up path, so missed terminal frames cannot leave the
 * timer, tool cards, or sidebar activity stuck forever.
 */
export function createCodexBackgroundSynchronizer(
  options: CodexBackgroundSynchronizerOptions = {},
) {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const retryDelaysMs = options.retryDelaysMs?.length
    ? options.retryDelaysMs
    : [1_000, 2_000, 5_000, 15_000, 30_000];
  const safetyIntervalMs = options.safetyIntervalMs ?? DEFAULT_SAFETY_INTERVAL_MS;
  const statusRequests = new Map<string, Promise<boolean>>();
  const pendingRequests = new Map<string, Promise<boolean>>();
  const terminalTargets = new Set<string>();
  // Consecutive `unsupported` activity answers per target. A 404 is retried
  // rather than trusted — a stale port bound by an unrelated process answers
  // the same way — but a bridge that never recovers must surface an error.
  const unsupportedActivityStreaks = new Map<string, number>();
  let reconcileRequest: Promise<void> | undefined;
  let trailingReconcileRequested = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;
  let disposed = false;

  const clearRetryTimer = (): void => {
    if (retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const finishMissingSession = (target: SessionTarget, id: string): void => {
    terminalTargets.add(id);
    const state = useCodexStore.getState();
    state.setSessionPhase(target.sessionKey, undefined);
    state.setSessionError(
      target.sessionKey,
      "The Codex session is no longer available on the server",
    );
    // A missing session cannot still own actionable requests. Clear these
    // before unlocking so a delayed pending snapshot cannot strand a card.
    clearPendingInput(target.sessionKey);
    // Missing is definitive: there is no server-side session that could have
    // accepted the ambiguous prompt or accept a same-key retry.
    discardUnconfirmedDispatch(target.sessionKey);
    state.setSessionLoading(target.sessionKey, false);
  };

  const refreshPending = (target: SessionTarget): Promise<boolean> => {
    const id = targetId(target);
    if (terminalTargets.has(id)) return Promise.resolve(false);
    const existing = pendingRequests.get(id);
    if (existing) return existing;
    const stateAtStart = useCodexStore.getState();
    const approvalsAtStart = stateAtStart.pendingApprovals.get(target.sessionKey);
    const interactionsAtStart = stateAtStart.pendingInteractions.get(target.sessionKey);

    const request: Promise<boolean> = Promise.allSettled([
      dependencies.fetchPendingApprovals(target.client, target.sessionId),
      dependencies.fetchPendingInteractions(target.client, target.sessionId),
    ]).then(([approvals, interactions]) => {
      if (disposed || terminalTargets.has(id) || !isCurrentTurn(target)) {
        return false;
      }
      const state = useCodexStore.getState();
      // A live SSE event that landed after these requests started is newer than
      // either HTTP snapshot. Reference identity is the store's event token:
      // every real add/remove replaces the corresponding array.
      if (
        approvals.status === "fulfilled"
        && state.pendingApprovals.get(target.sessionKey) === approvalsAtStart
      ) {
        state.setPendingApprovals(
          target.sessionKey,
          approvals.value,
        );
      }
      if (
        interactions.status === "fulfilled"
        && state.pendingInteractions.get(target.sessionKey) === interactionsAtStart
      ) {
        state.setPendingInteractions(
          target.sessionKey,
          interactions.value,
        );
      }
      return approvals.status === "rejected" || interactions.status === "rejected";
    }).finally(() => {
      if (pendingRequests.get(id) === request) {
        pendingRequests.delete(id);
      }
    });
    pendingRequests.set(id, request);
    return request;
  };

  const reconcileStatus = (target: SessionTarget): Promise<boolean> => {
    const id = targetId(target);
    const existing = statusRequests.get(id);
    if (existing) return existing;

    const request: Promise<boolean> = (async () => {
      const activity = await dependencies.lookupSessionActivity(
        target.client,
        target.sessionId,
      );
      if (activity?.kind !== "unsupported") unsupportedActivityStreaks.delete(id);
      if (activity?.kind === "missing") {
        if (!disposed && isCurrentTurn(target)) finishMissingSession(target, id);
        return false;
      }
      // Working and waiting are non-terminal. Pending cards are refreshed
      // after this authoritative activity decision.
      if (activity?.kind === "found" && activity.activity !== "idle") return false;
      if (activity?.kind === "unavailable") {
        // A transport failure is not evidence that a session is terminal or
        // missing. Leave state untouched; reconnect/activity events retry it.
        console.debug(
          "[CodexBackgroundSync] Activity probe unavailable:",
          activity.error,
        );
        return true;
      }
      // The activity route is the non-touching authority used by backend
      // supervisors. A bridge that predates it is outside the supported rolling
      // upgrade window; polling /status would keep an idle thread attached, so
      // this retries the same route rather than falling back. A 404 is not
      // evidence that the turn ended, so the turn stays locked either way —
      // but once the retry ladder is spent, say so instead of spinning.
      if (activity?.kind === "unsupported") {
        const streak = (unsupportedActivityStreaks.get(id) ?? 0) + 1;
        unsupportedActivityStreaks.set(id, streak);
        if (streak > retryDelaysMs.length && !disposed && isCurrentTurn(target)) {
          useCodexStore.getState().setSessionError(
            target.sessionKey,
            CODEX_ACTIVITY_UNSUPPORTED_ERROR,
          );
        }
        return true;
      }
      const lookup = await dependencies.lookupSessionStatus(
        target.client,
        target.sessionId,
      );
      if (disposed || !isCurrentTurn(target)) return false;

      const state = useCodexStore.getState();
      if (lookup.kind === "unavailable") return true;
      if (lookup.kind === "missing") {
        finishMissingSession(target, id);
        return false;
      }

      let status = lookup.session;
      if (status.status === "running") {
        terminalTargets.delete(id);
        if (status.turnStartedAt !== undefined || status.turnId !== undefined) {
          // Keep inactive tabs synchronized even when no mounted SSE consumer
          // was present to observe the turn-start frame.
          state.setSessionLoading(
            target.sessionKey,
            true,
            status.turnStartedAt,
            status.turnId,
          );
          // Pending-input requests use the same target as their generation
          // guard. Advance it before requesting their snapshot so valid results
          // are not mistaken for an older turn.
          if (status.turnId !== undefined) target.turnId = status.turnId;
          target.loadingRevision =
            useCodexStore.getState().sessionLoadingRevisions.get(target.sessionKey)
            ?? target.loadingRevision;
        }
        // The foreground SSE stream owns within-turn phase and usage updates.
        // Applying an HTTP running snapshot here could roll those values back
        // if a newer live frame landed while the request was in flight.
        return false;
      }

      terminalTargets.add(id);
      const sessionAtTerminalStatus = state.sessions.get(target.sessionKey);
      const phaseAtTerminalStatus = state.sessionPhase.get(target.sessionKey);
      const approvalsAtTerminalStatus =
        state.pendingApprovals.get(target.sessionKey);
      const interactionsAtTerminalStatus =
        state.pendingInteractions.get(target.sessionKey);
      let dispatchResolution: "none" | "confirmed" | "retryable" = "none";
      let transcriptHydrationFailed = false;
      let terminalMessages: CodexMessage[] | undefined;
      try {
        terminalMessages = await dependencies.getSessionMessages(
          target.client,
          target.sessionId,
          { throwOnError: true },
        );
      } catch (error) {
        transcriptHydrationFailed = true;
        // Status remains authoritative even if transcript hydration has a
        // transient failure. Do not settle an ambiguous dispatch without the
        // fresh transcript that proves whether its prompt landed.
        console.debug(
          "[CodexBackgroundSync] Failed to refresh terminal transcript:",
          error,
        );
      }

      if (disposed || !isCurrentTurn(target)) return false;
      const rendererChangedAfterTerminalStatus = (): boolean => {
        const current = useCodexStore.getState();
        return (
          current.sessions.get(target.sessionKey) !== sessionAtTerminalStatus
          || current.sessionPhase.get(target.sessionKey) !== phaseAtTerminalStatus
          || current.pendingApprovals.get(target.sessionKey)
            !== approvalsAtTerminalStatus
          || current.pendingInteractions.get(target.sessionKey)
            !== interactionsAtTerminalStatus
        );
      };
      if (rendererChangedAfterTerminalStatus()) {
        // A live frame changed this renderer after the terminal status snapshot
        // was observed. The loading timestamp can remain unchanged when this
        // renderer missed the prior idle transition, so object/map identities
        // are the additional generation token. Re-poll instead of clearing a
        // newer turn or its pending input.
        terminalTargets.delete(id);
        return true;
      }
      const confirmation = await dependencies.lookupSessionStatus(
        target.client,
        target.sessionId,
      );
      if (disposed) return false;
      if (!isCurrentTurn(target) || rendererChangedAfterTerminalStatus()) {
        // Same reasoning as the pre-confirmation check above, which this used
        // to contradict by returning "settled". Aborting here discards a
        // terminal status that was already observed, so the turn is still
        // locked and nothing else guarantees another authoritative read.
        // Re-poll rather than leaving it that way.
        terminalTargets.delete(id);
        return true;
      }
      if (confirmation.kind === "unavailable") {
        terminalTargets.delete(id);
        return true;
      }
      if (confirmation.kind === "missing") {
        finishMissingSession(target, id);
        return false;
      }
      const confirmedStatus = confirmation.session;
      if (confirmedStatus.status === "running") {
        terminalTargets.delete(id);
        return false;
      }
      if (
        confirmedStatus.messageRevision !== status.messageRevision
        || confirmedStatus.engineGeneration !== status.engineGeneration
      ) {
        // A fast turn can start and finish while the transcript is being read,
        // leaving both status snapshots terminal. Revisions/generations are the
        // backend-side generation token for that otherwise invisible ABA race.
        terminalTargets.delete(id);
        return true;
      }
      status = confirmedStatus;
      const confirmedState = useCodexStore.getState();
      if (terminalMessages) {
        confirmedState.setMessages(target.sessionKey, terminalMessages);
        dispatchResolution =
          confirmedState.settleUnconfirmedDispatch(target.sessionKey);
      }
      if (status.title?.trim()) {
        confirmedState.setSessionTitle(target.sessionKey, status.title);
      }
      if (status.contextUsage) {
        confirmedState.setContextUsage(target.sessionKey, status.contextUsage);
      }
      confirmedState.setSessionPhase(target.sessionKey, undefined);
      // Terminal status is authoritative for pending input. Perform this
      // synchronously before unlocking; any older in-flight pending request
      // then fails `isCurrentTurn` and cannot resurrect the cleared entries.
      clearPendingInput(target.sessionKey);
      if (
        transcriptHydrationFailed
        && confirmedState.unconfirmedDispatches.has(target.sessionKey)
      ) {
        // The transcript is the only safe way to settle an ambiguous prompt.
        // Keep this turn eligible for the next poll instead of unlocking with
        // a local-only message or discarding its idempotency key.
        if (status.status === "error") {
          confirmedState.setSessionError(
            target.sessionKey,
            status.error?.trim() || "Codex session failed",
          );
        }
        return true;
      }
      confirmedState.setSessionLoading(target.sessionKey, false);
      confirmedState.setSessionError(
        target.sessionKey,
        status.status === "error"
          ? status.error?.trim() || "Codex session failed"
          : dispatchResolution === "retryable"
            ? CODEX_UNCONFIRMED_DISPATCH_ERROR
            : undefined,
      );
      return false;
    })().catch((error) => {
      // A failed authoritative read changes no state; bounded backoff retries it.
      console.debug("[CodexBackgroundSync] Reconcile failed:", error);
      return true;
    }).finally(() => {
      if (statusRequests.get(id) === request) {
        statusRequests.delete(id);
      }
    });
    statusRequests.set(id, request);
    return request;
  };

  const runReconcile = async (): Promise<void> => {
    if (disposed) return;
    const targets = currentTargets();
    const currentTargetIds = new Set(targets.map(targetId));
    for (const id of terminalTargets) {
      if (!currentTargetIds.has(id)) terminalTargets.delete(id);
    }
    for (const id of unsupportedActivityStreaks.keys()) {
      if (!currentTargetIds.has(id)) unsupportedActivityStreaks.delete(id);
    }
    // Resolve activity/status before pending input for each session. This
    // prevents an older approvals snapshot from racing ahead of a turn-state
    // correction and erasing a newer live card. Sessions still reconcile in
    // parallel with one another.
    const requests = targets.map(async (target) => {
      const statusFailed = await reconcileStatus(target);
      // A failed/invalidated status pass cannot establish that its pending
      // snapshots belong to the current activity generation. Retry the whole
      // ordered sequence instead of letting those reads clear newer live input.
      const pendingFailed = !statusFailed && isCurrentTurn(target)
        ? await refreshPending(target)
        : false;
      return statusFailed || pendingFailed;
    });
    const shouldRetry = (await Promise.all(requests)).some(Boolean);
    if (disposed) return;
    if (shouldRetry && currentTargets().length > 0) {
      const delay = retryDelaysMs[
        Math.min(retryAttempt, retryDelaysMs.length - 1)
      ] ?? 30_000;
      retryAttempt += 1;
      clearRetryTimer();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void reconcileNow();
      }, Math.max(0, delay));
    } else {
      retryAttempt = 0;
      clearRetryTimer();
      // A successful read is not on its own enough to stop watching. Codex has
      // no renderer-side stall detector left, and a half-open event stream
      // produces neither an error nor an event, so no edge would ever
      // re-trigger a pass. This level-triggered floor is the detector of last
      // resort. Only loading sessions are targets, so an idle app still runs
      // no timer at all.
      if (safetyIntervalMs > 0 && currentTargets().length > 0) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void reconcileNow();
        }, safetyIntervalMs);
      }
    }
  };

  const reconcileNow = (queueIfRunning = false): Promise<void> => {
    if (disposed) return Promise.resolve();
    // An external event supersedes a pending delayed retry. In-flight work is
    // still shared so reconnect/activity bursts cannot multiply HTTP reads.
    clearRetryTimer();
    if (reconcileRequest) {
      if (queueIfRunning) trailingReconcileRequested = true;
      return reconcileRequest;
    }
    let settle!: () => void;
    let fail!: (error: unknown) => void;
    const request = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    reconcileRequest = request;
    void (async () => {
      let failure: { error: unknown } | undefined;
      try {
        do {
          trailingReconcileRequested = false;
          await runReconcile();
          // An activity/reconnect edge received during the HTTP pass may be the
          // only notification that its snapshot just became stale. Consume one
          // queued trailing pass before releasing the coalesced request.
          if (trailingReconcileRequested) clearRetryTimer();
        } while (!disposed && trailingReconcileRequested);
      } catch (error) {
        failure = { error };
      }
      // Released here rather than in a trailing `.finally()`. The loop
      // condition is evaluated before this promise settles, so an edge landing
      // in that gap would set `trailingReconcileRequested` on a request that
      // can no longer consume it — silently losing the edge the trailing pass
      // exists to catch.
      if (reconcileRequest === request) reconcileRequest = undefined;
      if (failure) fail(failure.error);
      else settle();
    })();
    return request;
  };

  return {
    reconcileNow,
    reconcileAfterCurrent(): Promise<void> {
      return reconcileNow(true);
    },
    dispose(): void {
      disposed = true;
      clearRetryTimer();
      reconcileRequest = undefined;
      trailingReconcileRequested = false;
      retryAttempt = 0;
      terminalTargets.clear();
      unsupportedActivityStreaks.clear();
    },
  };
}

/** Keep authoritative Codex state current across environment switches. */
export function useCodexBackgroundSync(
  options?: CodexBackgroundSynchronizerOptions,
): void {
  const dependencies = options?.dependencies;
  // Keyed on the contents, not the array identity. Callers naturally pass an
  // inline literal, and depending on its identity would dispose and recreate
  // the synchronizer on every render — cancelling each in-flight retry before
  // its timer could ever fire.
  const retryDelaysKey = options?.retryDelaysMs?.join(",");
  const safetyIntervalMs = options?.safetyIntervalMs;
  useEffect(() => {
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies,
      retryDelaysMs: retryDelaysKey ? retryDelaysKey.split(",").map(Number) : undefined,
      safetyIntervalMs,
    });
    const unsubscribeEnvironment = useEnvironmentStore.subscribe((current, previous) => {
      const before = new Map(previous.environments.map((environment) => [
        environment.id,
        environment.agentActivityState,
      ]));
      // Any departure from `working` is the edge, including the field being
      // absent: `agentActivityState` is optional, so a snapshot that simply
      // omits it is not evidence the turn is still running, and narrowing this
      // to an explicit idle/waiting would silently drop that transition.
      if (current.environments.some((environment) =>
        before.get(environment.id) === "working"
        && environment.agentActivityState !== "working"
      )) {
        void synchronizer.reconcileAfterCurrent();
      }
    });
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let unlistenActivity: (() => void) | undefined;

    // `listen` registers its handler synchronously before its returned promise
    // waits for stream readiness. Invoke both first, then take the snapshot, so
    // a terminal transition cannot land in the old snapshot-before-subscribe
    // gap. Listener readiness must not delay authoritative catch-up.
    void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
      void synchronizer.reconcileAfterCurrent();
    }).then((release) => {
      if (cancelled) release();
      else unlisten = release;
    }).catch((error) => {
      console.debug(
        "[CodexBackgroundSync] Failed to install stream listener:",
        error,
      );
    });
    void listen<{ state?: unknown }>("native-agent-session-activity", (event) => {
      if (event.payload.state === "idle" || event.payload.state === "waiting") {
        void synchronizer.reconcileAfterCurrent();
      }
    }).then((release) => {
      if (cancelled) release();
      else unlistenActivity = release;
    }).catch((error) => {
      console.debug(
        "[CodexBackgroundSync] Failed to install activity listener:",
        error,
      );
    });
    void synchronizer.reconcileNow();
    return () => {
      cancelled = true;
      unlisten?.();
      unlistenActivity?.();
      unsubscribeEnvironment();
      synchronizer.dispose();
    };
  }, [dependencies, retryDelaysKey, safetyIntervalMs]);
}
