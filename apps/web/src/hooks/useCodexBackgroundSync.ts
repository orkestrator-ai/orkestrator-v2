import { useEffect } from "react";
import {
  fetchPendingApprovals,
  fetchPendingInteractions,
  getSessionMessages,
  lookupSessionStatus,
  type CodexClient,
  type CodexSessionStatusLookupResult,
} from "@/lib/codex-client";
import { getEnvironmentIdFromSessionKey } from "@/lib/utils";
import { useCodexStore } from "@/stores/codexStore";

export const CODEX_BACKGROUND_SYNC_INTERVAL_MS = 2_000;

export interface CodexBackgroundSyncDependencies {
  lookupSessionStatus: (
    client: CodexClient,
    sessionId: string,
  ) => Promise<CodexSessionStatusLookupResult>;
  getSessionMessages: typeof getSessionMessages;
  fetchPendingApprovals: typeof fetchPendingApprovals;
  fetchPendingInteractions: typeof fetchPendingInteractions;
}

interface CodexBackgroundSynchronizerOptions {
  dependencies?: CodexBackgroundSyncDependencies;
}

const DEFAULT_DEPENDENCIES: CodexBackgroundSyncDependencies = {
  lookupSessionStatus,
  getSessionMessages,
  fetchPendingApprovals,
  fetchPendingInteractions,
};

interface SessionTarget {
  sessionKey: string;
  sessionId: string;
  loadingStartedAt: number | undefined;
  client: CodexClient;
}

function targetId(target: SessionTarget): string {
  return [
    target.sessionKey,
    target.sessionId,
    target.loadingStartedAt ?? "",
  ].join("\u0000");
}

/**
 * True only while this is still the turn the request was started for.
 *
 * Session ids survive across turns, so checking only the id lets a delayed
 * `idle` response from the previous turn unlock a newly started one. The
 * loading timestamp is the renderer's per-turn generation token.
 */
function isCurrentTurn(target: SessionTarget): boolean {
  const current = useCodexStore.getState().sessions.get(target.sessionKey);
  return current?.sessionId === target.sessionId
    && current.isLoading
    && current.loadingStartedAt === target.loadingStartedAt;
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
      loadingStartedAt: session.loadingStartedAt,
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
  let disposed = false;

  const refreshPending = (target: SessionTarget): Promise<void> => {
    const id = targetId(target);
    const existing = pendingRequests.get(id);
    if (existing) return existing;
    const stateAtStart = useCodexStore.getState();
    const approvalsAtStart = stateAtStart.pendingApprovals.get(target.sessionKey);
    const interactionsAtStart = stateAtStart.pendingInteractions.get(target.sessionKey);

    const request: Promise<void> = Promise.allSettled([
      dependencies.fetchPendingApprovals(target.client, target.sessionId),
      dependencies.fetchPendingInteractions(target.client, target.sessionId),
    ]).then(([approvals, interactions]) => {
      if (disposed || !isCurrentTurn(target)) return;
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
      const lookup = await dependencies.lookupSessionStatus(
        target.client,
        target.sessionId,
      );
      if (disposed || !isCurrentTurn(target)) return;

      const state = useCodexStore.getState();
      if (lookup.kind === "unavailable") return;
      if (lookup.kind === "missing") {
        state.setSessionPhase(target.sessionKey, undefined);
        state.setSessionError(
          target.sessionKey,
          "The Codex session is no longer available on the server",
        );
        state.setSessionLoading(target.sessionKey, false);
        return;
      }

      const status = lookup.session;
      if (status.status === "running") {
        // The foreground SSE stream owns within-turn phase and usage updates.
        // Applying an HTTP running snapshot here could roll those values back
        // if a newer live frame landed while the request was in flight.
        return;
      }

      try {
        const messages = await dependencies.getSessionMessages(
          target.client,
          target.sessionId,
          { throwOnError: true },
        );
        if (disposed || !isCurrentTurn(target)) return;
        useCodexStore.getState().setMessages(target.sessionKey, messages);
      } catch (error) {
        // Status remains authoritative even if transcript hydration has a
        // transient failure. The visible tab retries `/messages` on remount.
        console.debug(
          "[CodexBackgroundSync] Failed to refresh terminal transcript:",
          error,
        );
      }

      if (disposed || !isCurrentTurn(target)) return;
      const latest = useCodexStore.getState();
      if (status.title?.trim()) {
        latest.setSessionTitle(target.sessionKey, status.title);
      }
      if (status.contextUsage) {
        latest.setContextUsage(target.sessionKey, status.contextUsage);
      }
      latest.setSessionPhase(target.sessionKey, undefined);
      latest.setSessionLoading(target.sessionKey, false);
      latest.setSessionError(
        target.sessionKey,
        status.status === "error"
          ? status.error?.trim() || "Codex session failed"
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
      const requests = currentTargets().flatMap((target) => [
        reconcileStatus(target),
        refreshPending(target),
      ]);
      await Promise.all(requests);
    },
    dispose(): void {
      disposed = true;
    },
  };
}

/** Keep authoritative Codex state current across environment switches. */
export function useCodexBackgroundSync(): void {
  useEffect(() => {
    const synchronizer = createCodexBackgroundSynchronizer();
    void synchronizer.reconcileNow();
    const intervalId = window.setInterval(() => {
      void synchronizer.reconcileNow();
    }, CODEX_BACKGROUND_SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
      synchronizer.dispose();
    };
  }, []);
}
