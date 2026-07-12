/**
 * Hook for managing pull request state and actions.
 *
 * This hook provides access to PR state stored in the environment store
 * and actions for viewing/resetting PRs and setting monitoring modes.
 *
 * Note: PR detection and polling is handled centrally by usePrMonitorService.
 * This hook no longer manages its own polling intervals.
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
}

export function usePullRequest({
  environmentId,
}: UsePullRequestOptions): UsePullRequestReturn {
  const [error, setError] = useState<string | null>(null);

  const { getEnvironmentById, setEnvironmentPR } = useEnvironmentStore();
  const { setMonitoringMode, getMonitoringState } = usePrMonitorStore();

  // Get PR state from environment store
  const environment = environmentId ? getEnvironmentById(environmentId) : null;
  const prUrl = environment?.prUrl ?? null;
  const prState = environment?.prState ?? null;
  const hasMergeConflicts = environment?.hasMergeConflicts ?? null;

  // Get detection status from PR monitor store
  const monitorState = environmentId ? getMonitoringState(environmentId) : null;
  const isDetecting = monitorState?.checkInProgress ?? false;

  // View the PR in the default browser
  const viewPR = useCallback(async () => {
    if (!prUrl) {
      // Fallback: try to get the PR URL from the backend
      if (environmentId) {
        try {
          const url = await backend.getEnvironmentPrUrl(environmentId);
          if (url) {
            await backend.openInBrowser(url);
            return;
          }
        } catch (err) {
          console.error("Failed to get PR URL:", err);
        }
      }

      // If still no URL, set error
      setError("No PR URL available");
      return;
    }

    try {
      await backend.openInBrowser(prUrl);
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

  // Set monitoring mode to create-pending (faster polling after Create PR button)
  const setModeCreatePending = useCallback(() => {
    if (environmentId) {
      console.log(`[usePullRequest] Setting create-pending mode for ${environmentId}`);
      setMonitoringMode(environmentId, "create-pending");
    }
  }, [environmentId, setMonitoringMode]);

  // Set monitoring mode to merge-pending (fast polling after Merge PR button)
  const setModeMergePending = useCallback(() => {
    if (environmentId) {
      console.log(`[usePullRequest] Setting merge-pending mode for ${environmentId}`);
      setMonitoringMode(environmentId, "merge-pending");
    }
  }, [environmentId, setMonitoringMode]);

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
  };
}
