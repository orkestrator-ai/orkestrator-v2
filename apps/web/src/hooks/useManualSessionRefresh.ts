import { useEffect, useRef } from "react";
import { toast } from "sonner";

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
  refresh: () => Promise<void>;
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
    void refresh().catch((error) => {
      console.error(`[${agentLabel}ChatTab] Manual refresh failed:`, error);
      toast.error(`Failed to refresh ${agentLabel} tab`, {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, [refreshRequestId, isReady, agentLabel, refresh]);
}
