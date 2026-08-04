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
  lookupSessionActivity?: (
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
  dependencies?: CodexBackgroundSyncDependencies;
}

const DEFAULT_DEPENDENCIES: CodexBackgroundSyncDependencies = {
  lookupSessionActivity,
  lookupSessionStatus,
  getSessionMessages,
  fetchPendingApprovals,
  fetchPendingInteractions,
};

const SAFETY_RECONCILE_INTERVAL_MS = 30_000;

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
 * treats `/status`, `/messages`, `/approvals`, and `/interactions` as the
 * authoritative catch-up path, so missed terminal frames cannot leave the
 * timer, tool cards, or sidebar activity stuck forever.
 */
export function createCodexBackgroundSynchronizer(
  options: CodexBackgroundSynchronizerOptions = {},
) {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const statusRequests = new Map<string, Promise<void>>();
  const pendingRequests = new Map<string, Promise<void>>();
  const terminalTargets = new Set<string>();
  let disposed = false;

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

  const refreshPending = (target: SessionTarget): Promise<void> => {
    const id = targetId(target);
    if (terminalTargets.has(id)) return Promise.resolve();
    const existing = pendingRequests.get(id);
    if (existing) return existing;
    const stateAtStart = useCodexStore.getState();
    const approvalsAtStart = stateAtStart.pendingApprovals.get(target.sessionKey);
    const interactionsAtStart = stateAtStart.pendingInteractions.get(target.sessionKey);

    const request: Promise<void> = Promise.allSettled([
      dependencies.fetchPendingApprovals(target.client, target.sessionId),
      dependencies.fetchPendingInteractions(target.client, target.sessionId),
    ]).then(([approvals, interactions]) => {
      if (disposed || terminalTargets.has(id) || !isCurrentTurn(target)) return;
      const state = useCodexStore.getState();
      // A live SSE event that landed after these requests started is newer than
      // either HTTP snapshot. Reference identity is the store's event token:
      // every real add/remove replaces the corresponding array.
      if (
        approvals.status === "fulfilled"
        && state.pendingApprovals.get(target.sessionKey) === approvalsAtStart
      ) {
        state.setPendingApprovals(target.sessionKey, approvals.value);
      }
      if (
        interactions.status === "fulfilled"
        && state.pendingInteractions.get(target.sessionKey) === interactionsAtStart
      ) {
        state.setPendingInteractions(target.sessionKey, interactions.value);
      }
    }).finally(() => {
      if (pendingRequests.get(id) === request) {
        pendingRequests.delete(id);
      }
    });
    pendingRequests.set(id, request);
    return request;
  };

  const reconcileStatus = (target: SessionTarget): Promise<void> => {
    const id = targetId(target);
    const existing = statusRequests.get(id);
    if (existing) return existing;

    const request: Promise<void> = (async () => {
      const activity = dependencies.lookupSessionActivity
        ? await dependencies.lookupSessionActivity(target.client, target.sessionId)
        : undefined;
      if (activity?.kind === "missing") {
        if (!disposed && isCurrentTurn(target)) finishMissingSession(target, id);
        return;
      }
      // Working and waiting are non-terminal. Pending cards are refreshed by
      // the parallel request; a full transcript/status read waits for idle.
      if (activity?.kind === "found" && activity.activity !== "idle") return;
      if (activity?.kind === "unavailable") {
        // A transport failure is not evidence that a session is terminal or
        // missing. Leave state untouched; the safety timer retries this probe.
        console.debug(
          "[CodexBackgroundSync] Activity probe unavailable:",
          activity.error,
        );
        return;
      }
      // `unsupported` deliberately falls through to the legacy status route.
      const lookup = await dependencies.lookupSessionStatus(
        target.client,
        target.sessionId,
      );
      if (disposed || !isCurrentTurn(target)) return;

      const state = useCodexStore.getState();
      if (lookup.kind === "unavailable") return;
      if (lookup.kind === "missing") {
        finishMissingSession(target, id);
        return;
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
          // The pending-input requests run alongside this status lookup and use
          // the same target as their generation guard. Advance that guard with
          // the authoritative correction so their valid snapshots are not
          // mistaken for results from an older turn.
          if (status.turnId !== undefined) target.turnId = status.turnId;
          target.loadingRevision =
            useCodexStore.getState().sessionLoadingRevisions.get(target.sessionKey)
            ?? target.loadingRevision;
        }
        // The foreground SSE stream owns within-turn phase and usage updates.
        // Applying an HTTP running snapshot here could roll those values back
        // if a newer live frame landed while the request was in flight.
        return;
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

      if (disposed || !isCurrentTurn(target)) return;
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
        return;
      }
      const confirmation = await dependencies.lookupSessionStatus(
        target.client,
        target.sessionId,
      );
      if (
        disposed
        || !isCurrentTurn(target)
        || rendererChangedAfterTerminalStatus()
      ) {
        terminalTargets.delete(id);
        return;
      }
      if (confirmation.kind === "unavailable") {
        terminalTargets.delete(id);
        return;
      }
      if (confirmation.kind === "missing") {
        finishMissingSession(target, id);
        return;
      }
      const confirmedStatus = confirmation.session;
      if (confirmedStatus.status === "running") {
        terminalTargets.delete(id);
        return;
      }
      if (
        confirmedStatus.messageRevision !== status.messageRevision
        || confirmedStatus.engineGeneration !== status.engineGeneration
      ) {
        // A fast turn can start and finish while the transcript is being read,
        // leaving both status snapshots terminal. Revisions/generations are the
        // backend-side generation token for that otherwise invisible ABA race.
        terminalTargets.delete(id);
        return;
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
        return;
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
    })().catch((error) => {
      // A failed authoritative read changes no state; the next interval retries.
      console.debug("[CodexBackgroundSync] Reconcile failed:", error);
    }).finally(() => {
      if (statusRequests.get(id) === request) {
        statusRequests.delete(id);
      }
    });
    statusRequests.set(id, request);
    return request;
  };

  return {
    async reconcileNow(): Promise<void> {
      if (disposed) return;
      const targets = currentTargets();
      const currentTargetIds = new Set(targets.map(targetId));
      for (const id of terminalTargets) {
        if (!currentTargetIds.has(id)) terminalTargets.delete(id);
      }
      const requests = targets.flatMap((target) => [
        reconcileStatus(target),
        refreshPending(target),
      ]);
      await Promise.all(requests);
    },
    dispose(): void {
      disposed = true;
      terminalTargets.clear();
    },
  };
}

/** Keep authoritative Codex state current across environment switches. */
export function useCodexBackgroundSync(
  options?: CodexBackgroundSynchronizerOptions,
): void {
  const dependencies = options?.dependencies;
  useEffect(() => {
    const synchronizer = createCodexBackgroundSynchronizer({ dependencies });
    const unsubscribeEnvironment = useEnvironmentStore.subscribe((current, previous) => {
      const before = new Map(previous.environments.map((environment) => [
        environment.id,
        environment.agentActivityState,
      ]));
      if (current.environments.some((environment) =>
        before.get(environment.id) === "working"
        && environment.agentActivityState !== "working"
      )) {
        void synchronizer.reconcileNow();
      }
    });
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let unlistenActivity: (() => void) | undefined;
    let safetyInterval: number | undefined;

    // `listen` registers its handler synchronously before its returned promise
    // waits for stream readiness. Invoke both first, then take the snapshot, so
    // a terminal transition cannot land in the old snapshot-before-subscribe
    // gap. Listener readiness must not delay authoritative catch-up.
    void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
      void synchronizer.reconcileNow();
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
        void synchronizer.reconcileNow();
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
    // Events are the low-latency path, but this bounded retry ensures a
    // listener setup race, half-open stream, or transient probe failure can
    // never strand a loading session indefinitely.
    safetyInterval = window.setInterval(() => {
      void synchronizer.reconcileNow();
    }, SAFETY_RECONCILE_INTERVAL_MS);
    return () => {
      cancelled = true;
      unlisten?.();
      unlistenActivity?.();
      if (safetyInterval !== undefined) window.clearInterval(safetyInterval);
      unsubscribeEnvironment();
      synchronizer.dispose();
    };
  }, [dependencies]);
}
