import { useEffect, useEffectEvent } from "react";
import {
  AGENT_ACCOUNTS_CHANGED_EVENT,
  isAgentAccountsChangedEvent,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";
import { listenAuthoritative } from "@/lib/native/authoritative-events";

/**
 * Calls `onChange` when this view's own machine announces that its agent
 * accounts for `platform` changed, and when its event stream resyncs (a change
 * may have been missed). Views read on mount themselves; this keeps them
 * current afterwards. Another machine's accounts are watched through the
 * command node instead (`subscribeNodeEvents`).
 */
export function useAgentAccountsChanged(
  platform: AgentAccountPlatform | null,
  onChange: () => void,
): void {
  const changed = useEffectEvent(onChange);
  useEffect(() => {
    if (!platform) return;
    const controller = new AbortController();
    void listenAuthoritative<unknown>(
      AGENT_ACCOUNTS_CHANGED_EVENT,
      ({ payload }) => {
        if (isAgentAccountsChangedEvent(payload) && payload.platform === platform) changed();
      },
      { onResync: () => changed(), signal: controller.signal },
    ).catch(() => undefined);
    return () => controller.abort();
  }, [platform]);
}
