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
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { backendForScope } from "@/lib/backend/scope-backend";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { useCallback, useState } from "react";
import { useEnvironmentStore } from "@/stores";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { openPullRequestUrl } from "@/lib/pull-request-opener";
import type { Environment, PrState } from "@/types";
import type { PrCheckSummary } from "@orkestrator/protocol/pr-monitor";
import type { HydrationStatus } from "@/lib/bounded-hydration";

const log = createLogger("web.github");

function findEnvironment(environments: readonly Environment[], environmentId: string) {
  return environments.find((environment) => environment.id === environmentId);
}

interface UsePullRequestOptions {
  environmentId: string | null;
}

interface UsePullRequestReturn {
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
  checkSummary: PrCheckSummary | null;
  isDetecting: boolean;
  /** Freshness of the PR monitor mirror these fields come from. */
  monitorSyncStatus: HydrationStatus;
  /** When the backend last checked this PR successfully (ISO), if known. */
  lastSuccessfulCheckAt: string | null;
  error: string | null;
  /**
   * Opens the PR in the right-hand files panel of the current view, or on
   * GitHub when `external` or when the panel cannot show it.
   */
  viewPR: (options?: { external?: boolean }) => Promise<void>;
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
  // This node's backend (plan item 4001); the command node outside a node scope.
  const backendScope = useScopesWithCommandFallback().scope;
  const [error, setError] = useState<string | null>(null);

  const setEnvironmentPR = useEnvironmentStore((state) => state.setEnvironmentPR);

  // PR fields of this environment only: primitive selectors, so a change to
  // another environment (or to an unrelated field of this one) does not
  // re-render the action bar and pipeline views that use this hook.
  const prUrl = useEnvironmentStore((state) =>
    environmentId ? (findEnvironment(state.environments, environmentId)?.prUrl ?? null) : null,
  );
  const prState = useEnvironmentStore((state) =>
    environmentId ? (findEnvironment(state.environments, environmentId)?.prState ?? null) : null,
  );
  const hasMergeConflicts = useEnvironmentStore((state) =>
    environmentId
      ? (findEnvironment(state.environments, environmentId)?.hasMergeConflicts ?? null)
      : null,
  );

  // Detection status mirrored from the backend monitor
  const monitorState = usePrMonitorStore((state) =>
    environmentId ? (state.states.get(environmentId) ?? null) : null,
  );
  const isDetecting = monitorState?.checkInProgress ?? false;
  const checkSummary = monitorState?.checkSummary ?? null;
  const monitorSyncStatus = usePrMonitorStore((state) => state.syncStatus);
  const lastSuccessfulCheckAt = monitorState?.lastSuccessfulCheckAt ?? null;

  // View the PR in the files panel, or in the default browser
  const viewPR = useCallback(
    async (options?: { external?: boolean }) => {
      setError(null);
      let url = prUrl;
      if (!url) {
        // Fallback: try to get the PR URL from the backend
        if (environmentId) {
          try {
            url = await backendForScope(backendScope).getEnvironmentPrUrl(environmentId);
          } catch (err) {
            log.error("pull-request.url-failed", { environmentId, error: formatLogError(err) });
          }
        }

        // If still no URL, set error
        if (!url) {
          setError("No PR URL available");
          return;
        }
      }

      try {
        await openPullRequestUrl(url, { external: options?.external });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to open browser";
        setError(message);
      }
    },
    [backendScope, prUrl, environmentId],
  );

  // Reset/clear the PR URL, state, and merge conflicts
  const resetPR = useCallback(async () => {
    if (!environmentId) return;

    try {
      await backendForScope(backendScope).clearEnvironmentPr(environmentId);
      setEnvironmentPR(environmentId, null, null, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reset PR";
      setError(message);
    }
  }, [backendScope, environmentId, setEnvironmentPR]);

  // Request create-pending mode (faster polling after Create PR button).
  // A backend command rather than a store write, so the request survives a
  // renderer reload and keeps polling while another environment is active.
  const setModeCreatePending = useCallback(() => {
    if (environmentId) {
      void backendForScope(backendScope)
        .prMonitorWatch(environmentId, "create-pending")
        .catch((err) => {
          log.warn("pull-request.mode-request-failed", {
            environmentId,
            mode: "create-pending",
            error: formatLogError(err),
          });
        });
    }
  }, [backendScope, environmentId]);

  // Request merge-pending mode (fast polling after Merge PR button)
  const setModeMergePending = useCallback(() => {
    if (environmentId) {
      void backendForScope(backendScope)
        .prMonitorWatch(environmentId, "merge-pending")
        .catch((err) => {
          log.warn("pull-request.mode-request-failed", {
            environmentId,
            mode: "merge-pending",
            error: formatLogError(err),
          });
        });
    }
  }, [backendScope, environmentId]);

  const armRefreshAfterAgentCompletion = useCallback(async () => {
    if (!environmentId) return null;
    return backendForScope(backendScope).armPrRefreshAfterAgentCompletion(environmentId);
  }, [backendScope, environmentId]);

  const disarmRefreshAfterAgentCompletion = useCallback(
    async (armedAt: string) => {
      if (!environmentId) return;
      await backendForScope(backendScope).disarmPrRefreshAfterAgentCompletion(
        environmentId,
        armedAt,
      );
    },
    [backendScope, environmentId],
  );

  return {
    prUrl,
    prState,
    hasMergeConflicts,
    checkSummary,
    isDetecting,
    monitorSyncStatus,
    lastSuccessfulCheckAt,
    error,
    viewPR,
    resetPR,
    setModeCreatePending,
    setModeMergePending,
    armRefreshAfterAgentCompletion,
    disarmRefreshAfterAgentCompletion,
  };
}
