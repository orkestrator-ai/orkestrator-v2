import { useEffect, useRef } from "react";
import { toast } from "sonner";

/** Distinguishes a user-initiated refresh from a background reconcile. */
export interface RefreshSessionOptions {
  /**
   * The user asked for this refresh.
   *
   * Manual requests are tracked on their own sequence so only a newer *manual*
   * refresh supersedes one, and only they pay for a forced model-catalog reload.
   */
  manual?: boolean;
}

interface UseManualSessionRefreshOptions {
  /**
   * Monotonically increasing counter bumped by the tab chrome's refresh
   * button. A watermark rather than a boolean so a second click while the
   * first refresh is still running is not swallowed.
   */
  refreshRequestId: number;
  /** Skip until the tab actually has something to refresh. */
  isReady: boolean;
  agentLabel: string;
  refresh: (options: RefreshSessionOptions) => Promise<void>;
}

/**
 * Run an authoritative session refresh when the user asks for one.
 *
 * Extracted from the three chat tabs, where it was the same watermark effect
 * with only the log prefix and toast label differing.
 */
export function useManualSessionRefresh({
  refreshRequestId,
  isReady,
  agentLabel,
  refresh,
}: UseManualSessionRefreshOptions): void {
  const lastHandledRefreshRequestIdRef = useRef(0);

  useEffect(() => {
    if (refreshRequestId <= lastHandledRefreshRequestIdRef.current || !isReady) {
      return;
    }

    lastHandledRefreshRequestIdRef.current = refreshRequestId;
    void refresh({ manual: true }).catch((error) => {
      console.error(`[${agentLabel}ChatTab] Manual refresh failed:`, error);
      toast.error(`Failed to refresh ${agentLabel} tab`, {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, [refreshRequestId, isReady, agentLabel, refresh]);
}
