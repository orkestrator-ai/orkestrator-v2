/**
 * Hook for managing pull request state and actions.
 *
 * This hook provides access to PR state stored in the environment store
 * and actions for viewing/resetting PRs and requesting monitoring modes.
 *
 * Note: PR detection and polling is owned by the backend PR monitor service;
 * mode requests are backend commands so they survive a renderer reload, and
 * detection status is mirrored into prMonitorStore by usePrMonitorService.
 */
import { useCallback, useState } from "react";
import * as backend from "@/lib/backend";
import { useEnvironmentStore } from "@/stores";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import type { PrState } from "@/types";

interface UsePullRequestOptions {
  environmentId: string | null;
}

interface UsePullRequestReturn {
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
  isDetecting: boolean;
  error: string | null;
  /** Open the PR in the default browser */
  viewPR: () => Promise<void>;
  /** Clear the stored PR data */
  resetPR: () => Promise<void>;
  /** Set monitoring mode to create-pending (5s polling until PR found) */
  setModeCreatePending: () => void;
  /** Set monitoring mode to merge-pending (1s polling for 20s) */
  setModeMergePending: () => void;
  /** Ask the backend to refresh this conflicting PR after agent completion. */
  armRefreshAfterAgentCompletion: () => Promise<string | null>;
  /** Roll back the exact refresh arm when its corresponding agent launch fails. */
  disarmRefreshAfterAgentCompletion: (armedAt: string) => Promise<void>;
}

export function usePullRequest({ environmentId }: UsePullRequestOptions): UsePullRequestReturn {
  const [error, setError] = useState<string | null>(null);

  const { getEnvironmentById, setEnvironmentPR } = useEnvironmentStore();

  // Get PR state from environment store
  const environment = environmentId ? getEnvironmentById(environmentId) : null;
  const prUrl = environment?.prUrl ?? null;
  const prState = environment?.prState ?? null;
  const hasMergeConflicts = environment?.hasMergeConflicts ?? null;

  // Detection status mirrored from the backend monitor
  const monitorState = usePrMonitorStore((state) =>
    environmentId ? (state.states.get(environmentId) ?? null) : null,
  );
  const isDetecting = monitorState?.checkInProgress ?? false;

  // View the PR in the default browser
  const viewPR = useCallback(async () => {
    setError(null);
    let url = prUrl;
    if (!url) {
      // Fallback: try to get the PR URL from the backend
      if (environmentId) {
        try {
          url = await backend.getEnvironmentPrUrl(environmentId);
        } catch (err) {
          console.error("Failed to get PR URL:", err);
        }
      }

      // If still no URL, set error
      if (!url) {
        setError("No PR URL available");
        return;
      }
    }

    try {
      await backend.openInBrowser(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to open browser";
      setError(message);
    }
  }, [prUrl, environmentId]);

  // Reset/clear the PR URL, state, and merge conflicts
  const resetPR = useCallback(async () => {
    if (!environmentId) return;

    try {
      await backend.clearEnvironmentPr(environmentId);
      setEnvironmentPR(environmentId, null, null, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reset PR";
      setError(message);
    }
  }, [environmentId, setEnvironmentPR]);

  // Request create-pending mode (faster polling after Create PR button).
  // A backend command rather than a store write, so the request survives a
  // renderer reload and keeps polling while another environment is active.
  const setModeCreatePending = useCallback(() => {
    if (environmentId) {
      void backend.prMonitorWatch(environmentId, "create-pending").catch((err) => {
        console.warn(
          `[usePullRequest] Failed to request create-pending mode for ${environmentId}:`,
          err,
        );
      });
    }
  }, [environmentId]);

  // Request merge-pending mode (fast polling after Merge PR button)
  const setModeMergePending = useCallback(() => {
    if (environmentId) {
      void backend.prMonitorWatch(environmentId, "merge-pending").catch((err) => {
        console.warn(
          `[usePullRequest] Failed to request merge-pending mode for ${environmentId}:`,
          err,
        );
      });
    }
  }, [environmentId]);

  const armRefreshAfterAgentCompletion = useCallback(async () => {
    if (!environmentId) return null;
    return backend.armPrRefreshAfterAgentCompletion(environmentId);
  }, [environmentId]);

  const disarmRefreshAfterAgentCompletion = useCallback(
    async (armedAt: string) => {
      if (!environmentId) return;
      await backend.disarmPrRefreshAfterAgentCompletion(environmentId, armedAt);
    },
    [environmentId],
  );

  return {
    prUrl,
    prState,
    hasMergeConflicts,
    isDetecting,
    error,
    viewPR,
    resetPR,
    setModeCreatePending,
    setModeMergePending,
    armRefreshAfterAgentCompletion,
    disarmRefreshAfterAgentCompletion,
  };
}
