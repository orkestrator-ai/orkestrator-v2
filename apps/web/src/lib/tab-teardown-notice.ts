import { toast } from "sonner";
import { tabTeardownFailureKind } from "@orkestrator/protocol/tab-teardown";

/** How long the bridge-upgrade notice stays visible. */
export const TAB_TEARDOWN_BRIDGE_UPGRADE_TOAST_DURATION_MS = 12_000;

/** Stable toast id so closing many tabs in one environment shows one notice. */
export function tabTeardownBridgeUpgradeToastId(environmentId: string): string {
  return `tab-teardown-bridge-upgrade:${environmentId}`;
}

/**
 * Handle a rejected native `teardown_tab` call. The backend keeps the close
 * pending and retries it, so most failures only need a debug log. A bridge
 * that predates non-destructive close needs the user to restart the
 * environment, so that failure gets one deduplicated, informational toast.
 */
export function reportNativeTabTeardownFailure(
  environmentId: string,
  label: string,
  error: unknown,
): void {
  if (tabTeardownFailureKind(error) === "bridge-upgrade-required") {
    toast.warning("Restart the environment to finish closing this tab", {
      id: tabTeardownBridgeUpgradeToastId(environmentId),
      description:
        "The conversation was kept. The agent bridge is out of date, so the close will be retried after the environment restarts.",
      duration: TAB_TEARDOWN_BRIDGE_UPGRADE_TOAST_DURATION_MS,
    });
  }
  console.debug(`[PaneLayout] ${label} teardown remains pending:`, error);
}
