import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type {
  CoordinatorSnapshot,
  ProjectGitStatus,
  ProjectGitSwitchConfirmation,
} from "@orkestrator/protocol/coordinator";
import {
  activeCoordinatorTurnLabel,
  projectHomeEnvironmentIds,
} from "@/lib/coordinator-active-turn";
import { checkUpstreamMergeOffer } from "@/lib/coordinator-upstream-check";
import { useNodeScope } from "@/lib/node-scope/providers";
import { environmentStore } from "@/stores/environmentStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import type { RunCoordinatorAction } from "./useCoordinatorActions";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/** How long a message waits on the pre-send fetch before it is sent without merging. */
const UPSTREAM_CHECK_TIMEOUT_MS = 5_000;

interface UseCoordinatorGitActionsOptions {
  projectId: string;
  snapshot: CoordinatorSnapshot | null;
  setGit: (status: ProjectGitStatus) => void;
  refreshView: () => Promise<void>;
  runAction: RunCoordinatorAction;
}

/** What the panel does to the project's checkout: fetch, sync, switch, and fast-forward before a send. */
export function useCoordinatorGitActions({
  projectId,
  snapshot,
  setGit,
  refreshView,
  runAction,
}: UseCoordinatorGitActionsOptions) {
  const nodeBackend = useScopeBackend();
  // The node whose project this is: the one `useEnvironmentStore` reads.
  const scope = useNodeScope();
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
  // The refused or failed action may have left the status it read stale.
  const rereadStatus = useCallback(() => {
    void nodeBackend
      .getProjectGitStatus(projectId)
      .then(setGit)
      .catch(() => undefined);
  }, [projectId, setGit, nodeBackend]);
  const runGit = useCallback(
    (
      kind: "fetch" | "sync" | "switch",
      ref?: string,
      confirmation?: ProjectGitSwitchConfirmation,
    ) =>
      runAction(
        kind,
        async () => {
          const next =
            kind === "fetch"
              ? await nodeBackend.fetchProjectGit(projectId, true)
              : kind === "sync"
                ? await nodeBackend.syncProjectGit(projectId)
                : await nodeBackend.switchProjectGitBranch(
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
        },
        { failureMessage: `Git ${kind} failed`, onFailure: rereadStatus },
      ),
    [projectId, refreshView, rereadStatus, runAction, setGit, nodeBackend],
  );
  /** Asks the backend what switching would discard; `onReady` receives the answer to confirm. */
  const prepareSwitch = useCallback(
    (ref: string, onReady: (confirmation: ProjectGitSwitchConfirmation) => void) =>
      runAction(
        "switch",
        async () => onReady(await nodeBackend.prepareProjectGitBranchSwitch(projectId, ref)),
        { failureMessage: "Could not prepare branch switch", onFailure: rereadStatus },
      ),
    [projectId, rereadStatus, runAction, nodeBackend],
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
      const turnRunning = () =>
        activeCoordinatorTurnLabel({
          workspace: snapshotRef.current?.workspace,
          homeEnvironmentIds: projectHomeEnvironmentIds(
            scope.store(environmentStore).getState().environments,
            projectId,
          ),
          projections: scope.store(nativeAgentProjectionStore).getState().projections,
        }) !== null;
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
            scope,
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
        await runAction(
          "sync",
          async () => {
            const synced = await nodeBackend.syncProjectGit(projectId);
            if (lifetime.signal.aborted) return;
            setGit(synced);
            await refreshView();
          },
          {
            failureMessage: "Could not merge the upstream commits",
            ignoreFailure: (cause) =>
              lifetime.signal.aborted ||
              (cause instanceof Error &&
                cause.message === "Stop the active coordinator turn before changing the checkout"),
            onFailure: rereadStatus,
          },
        );
        return lifetime.signal.aborted ? false : undefined;
      } finally {
        lifetime.signal.removeEventListener("abort", cancel);
      }
    },
    [projectId, refreshView, rereadStatus, runAction, scope, setGit, nodeBackend],
  );
  return { runGit, prepareSwitch, confirmUpstreamMerge };
}
