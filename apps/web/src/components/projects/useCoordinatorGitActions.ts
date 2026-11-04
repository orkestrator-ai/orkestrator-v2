import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
  type ProjectGitStatus,
  type ProjectGitSwitchConfirmation,
} from "@orkestrator/protocol/coordinator";
import * as backend from "@/lib/backend";
import { checkUpstreamMergeOffer } from "@/lib/coordinator-upstream-check";
import { createSessionKey } from "@/lib/utils";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";

/** How long a message waits on the pre-send fetch before it is sent without merging. */
const UPSTREAM_CHECK_TIMEOUT_MS = 5_000;

interface UseCoordinatorGitActionsOptions {
  projectId: string;
  snapshot: CoordinatorSnapshot | null;
  setGit: (status: ProjectGitStatus) => void;
  refreshView: () => Promise<void>;
  setOperation: (operation: "fetch" | "sync" | "switch" | "conversation" | null) => void;
  setError: (error: string | null) => void;
}

/** What the panel does to the project's checkout: fetch, sync, switch, and fast-forward before a send. */
export function useCoordinatorGitActions({
  projectId,
  snapshot,
  setGit,
  refreshView,
  setOperation,
  setError,
}: UseCoordinatorGitActionsOptions) {
  const upstreamCheckLifetimeRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    upstreamCheckLifetimeRef.current = lifetime;
    return () => lifetime.abort();
  }, [projectId]);
  const snapshotRef = useRef(snapshot);
  // Before the handlers below read it.
  useLayoutEffect(() => {
    snapshotRef.current = snapshot;
  });
  const runGit = useCallback(
    async (
      kind: "fetch" | "sync" | "switch",
      ref?: string,
      confirmation?: ProjectGitSwitchConfirmation,
    ) => {
      setOperation(kind);
      setError(null);
      try {
        const next =
          kind === "fetch"
            ? await backend.fetchProjectGit(projectId, true)
            : kind === "sync"
              ? await backend.syncProjectGit(projectId)
              : await backend.switchProjectGitBranch(
                  projectId,
                  ref!,
                  confirmation
                    ? {
                        confirmationToken: confirmation.token,
                        includeNestedRepositories: confirmation.requiresEnhancedConfirmation,
                      }
                    : {},
                );
        setGit(next);
        await refreshView();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `Git ${kind} failed`);
        void backend
          .getProjectGitStatus(projectId)
          .then(setGit)
          .catch(() => undefined);
      } finally {
        setOperation(null);
      }
    },
    [projectId, refreshView, setError, setGit, setOperation],
  );
  /*
   * The main coordinator reads this checkout, so a message sent while the
   * branch is behind its upstream is answered from older code. Before each
   * message to the main coordinator (its first prompt included), the backend
   * refreshes the "behind" state with a cooldown-bound fetch and decides
   * whether the upstream commits can be merged
   * (`check_coordinator_upstream_merge`). Whenever Git can fast-forward the
   * checkout cleanly, the panel does so without asking. When the fetch is
   * slow or fails, the backend itself fast-forwards to the upstream commit
   * already fetched and answers `fast-forwarded`, so a slow remote does not
   * leave the checkout behind commits it already has.
   *
   * Merging resolves only after the fast-forward, so the message then reads
   * the merged code. A fast-forward that fails anyway (the remote moved, the
   * network dropped) is reported in the toolbar and the message is still
   * sent: nobody is asked any more, so a failure must not strand the draft
   * with no way to send it. A blocked checkout (local commits, uncommitted
   * changes, an unfinished operation) is left alone: the header already says
   * why it cannot sync. So is one while any of this coordinator's
   * conversations or the project home is running a turn, since the backend
   * refuses to change the checkout under it.
   */
  const confirmUpstreamMerge = useCallback(
    async (conversation: { role?: string }) => {
      const lifetime = upstreamCheckLifetimeRef.current;
      if (!lifetime || lifetime.signal.aborted) return false;
      if (conversation.role === "side") return;
      // Only an older backend needs this panel to judge running turns itself.
      const turnRunning = () => {
        const current = snapshotRef.current;
        const projections = useNativeAgentProjectionStore.getState().projections;
        const active = (phase: string | undefined) =>
          phase === "running" ||
          phase === "blocked" ||
          phase === "cancelling" ||
          phase === "recovering";
        const conversationRunning = current?.workspace.conversations.some(
          (item) =>
            !item.closedAt &&
            item.agent &&
            active(
              projections.get(
                createSessionKey(coordinatorRuntimeId(current.workspace.id, item.id), item.tabId),
              )?.turn.phase,
            ),
        );
        const homeIds = new Set(
          useEnvironmentStore
            .getState()
            .environments.filter(
              (environment) => environment.projectId === projectId && environment.projectHome,
            )
            .map((environment) => environment.id),
        );
        return (
          conversationRunning === true ||
          Array.from(projections.values()).some(
            (projection) => homeIds.has(projection.environmentId) && active(projection.turn.phase),
          )
        );
      };
      let cancel!: () => void;
      const cancelled = new Promise<false>((resolve) => {
        cancel = () => resolve(false);
        lifetime.signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        // An unreachable or slow remote is no reason to hold the message: past
        // the bound it is sent without merging, and the fetch still lands.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const check = await Promise.race([
          cancelled,
          checkUpstreamMergeOffer(projectId, {
            turnRunning,
            onStatus: (fetched) => {
              if (!lifetime.signal.aborted) setGit(fetched);
            },
          }).catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), UPSTREAM_CHECK_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (lifetime.signal.aborted || check === false) return false;
        if (check && !check.offer && check.reason === "fast-forwarded") {
          // The backend already merged what it had fetched; the header has the
          // status, and the view picks up the new commit before sending.
          await refreshView().catch(() => undefined);
          return lifetime.signal.aborted ? false : undefined;
        }
        if (!check?.offer) return;
        setOperation("sync");
        setError(null);
        try {
          const synced = await backend.syncProjectGit(projectId);
          if (lifetime.signal.aborted) return false;
          setGit(synced);
          await refreshView();
          if (lifetime.signal.aborted) return false;
        } catch (cause) {
          if (lifetime.signal.aborted) return false;
          if (
            cause instanceof Error &&
            cause.message === "Stop the active coordinator turn before changing the checkout"
          )
            return;
          setError(cause instanceof Error ? cause.message : "Could not merge the upstream commits");
          void backend
            .getProjectGitStatus(projectId)
            .then(setGit)
            .catch(() => undefined);
        } finally {
          if (!lifetime.signal.aborted) setOperation(null);
        }
      } finally {
        lifetime.signal.removeEventListener("abort", cancel);
      }
    },
    [projectId, refreshView, setError, setGit, setOperation],
  );
  return { runGit, confirmUpstreamMerge };
}
