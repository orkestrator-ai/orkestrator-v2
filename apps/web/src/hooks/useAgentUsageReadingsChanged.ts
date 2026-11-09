import { useEffect, useEffectEvent } from "react";
import { AGENT_USAGE_READINGS_CHANGED_EVENT } from "@orkestrator/protocol/agent-account-shared-usage";
import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import { listenAuthoritative } from "@/lib/native/authoritative-events";

/**
 * Calls `onChange` when this window's own machine keeps a newer usage reading
 * of one of `platform`'s logins: one it read, or one its command node shared
 * with it (docs/architecture/agent-accounts.md, "Shared readings"). The event
 * carries no reading, so views read again; a resync calls it too, in case one
 * was missed.
 */
export function useAgentUsageReadingsChanged(
  platform: AgentAccountPlatform | null,
  onChange: () => void,
): void {
  const changed = useEffectEvent(onChange);
  useEffect(() => {
    if (!platform) return;
    const controller = new AbortController();
    void listenAuthoritative<unknown>(
      AGENT_USAGE_READINGS_CHANGED_EVENT,
      ({ payload }) => {
        if ((payload as { platform?: unknown } | null)?.platform === platform) changed();
      },
      { onResync: () => changed(), signal: controller.signal },
    ).catch(() => undefined);
    return () => controller.abort();
  }, [platform]);
}
