import { useEffect, useEffectEvent } from "react";
import { AGENT_USAGE_READINGS_CHANGED_EVENT } from "@orkestrator/protocol/agent-account-shared-usage";
import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import type { BackendId } from "@orkestrator/protocol/federation";
import { subscribeNodeEvents } from "@/lib/federation/node-events";
import { commandScopeListenAuthoritative } from "@/lib/portal/command-scope";
import { appCommandScope } from "@/lib/node-scope-slots";

/** Settings uses the same machine for its reads and its authoritative events. */
export function useAgentUsageReadingsChanged(
  platform: AgentAccountPlatform | null,
  onChange: (emails?: readonly string[]) => void,
  machine?: string | null,
): void {
  const changed = useEffectEvent(onChange);
  useEffect(() => {
    if (!platform) return;
    let disposed = false;
    const onEvent = (_event: string, payload: unknown) => {
      if (disposed || !payload || typeof payload !== "object") return;
      const data = payload as { platform?: unknown; emails?: unknown };
      if (data.platform !== platform) return;
      const emails = Array.isArray(data.emails)
        ? data.emails.filter((email): email is string => typeof email === "string")
        : undefined;
      changed(emails);
    };
    const onResync = () => {
      if (!disposed) changed();
    };
    if (machine && machine !== appCommandScope().nodeId) {
      const stop = subscribeNodeEvents(machine as BackendId, {
        events: [AGENT_USAGE_READINGS_CHANGED_EVENT],
        onEvent,
        onResync,
      });
      return () => {
        disposed = true;
        stop();
      };
    }
    const controller = new AbortController();
    void commandScopeListenAuthoritative<unknown>(
      AGENT_USAGE_READINGS_CHANGED_EVENT,
      ({ payload }) => onEvent(AGENT_USAGE_READINGS_CHANGED_EVENT, payload),
      { onResync, signal: controller.signal },
    )
      .then((stop) => {
        if (disposed) stop();
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [platform, machine]);
}
