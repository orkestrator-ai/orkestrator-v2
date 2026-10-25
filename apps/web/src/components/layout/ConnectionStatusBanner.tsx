import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { useTransportConnectivity } from "@/lib/transport-connectivity";

/**
 * A blip shorter than this never shows the banner. The first reconnect is
 * 2 s away, so a backend restart or a brief network hiccup that recovers on
 * the first retry stays silent; a real outage shows within a few seconds.
 */
export const CONNECTION_BANNER_DELAY_MS = 4_000;

/**
 * App-wide notice that the backend transport is down.
 *
 * One banner for the connection rather than one per view: every event-led
 * view is behind for the same reason during an outage, and views keep
 * showing the last data they received. Per-view indicators (PR, diff badge,
 * Files) only describe failures specific to that view.
 */
export function ConnectionStatusBanner({
  delayMs = CONNECTION_BANNER_DELAY_MS,
}: {
  delayMs?: number;
}) {
  const { disconnected, since } = useTransportConnectivity();
  // The outage (identified by its start) whose delay has elapsed.
  const [shownOutage, setShownOutage] = useState<number | null>(null);

  useEffect(() => {
    if (!disconnected || since === null) return;
    const timer = setTimeout(
      () => setShownOutage(since),
      Math.max(0, since + delayMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [disconnected, since, delayMs]);

  if (!disconnected || since === null || shownOutage !== since) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-status-banner"
      className="pointer-events-none fixed inset-x-0 top-2 z-[85] flex justify-center px-4"
    >
      <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-950/95 px-3 py-1.5 text-xs text-amber-100 shadow-lg">
        <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          Connection to the backend lost. Reconnecting; views show the last data received.
        </span>
      </div>
    </div>
  );
}
