import { useEffect, useEffectEvent } from "react";
import {
  AGENT_ACCOUNTS_CHANGED_EVENT,
  isAgentAccountsChangedEvent,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";
import { agentAccountsChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import { listenAuthoritative } from "@/lib/native/authoritative-events";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { isAppCommandScope, listenInScope, onReconnectInScope } from "@/lib/node-scope-slots";

/**
 * Calls `onChange` when this view's own machine announces that its agent
 * accounts for `platform` changed, and when its event stream resyncs (a change
 * may have been missed). Views read on mount themselves; this keeps them
 * current afterwards. With `scope` (another node shown in the window's tree,
 * plan item 5002) the machine is that scope's node, heard on its own client.
 * Another machine's accounts are otherwise watched through the command node
 * (`subscribeNodeEvents`).
 */
export function useAgentAccountsChanged(
  platform: AgentAccountPlatform | null,
  onChange: () => void,
  scope?: NodeScope,
): void {
  const changed = useEffectEvent(onChange);
  const nodeScope = scope && !isAppCommandScope(scope) ? scope : null;
  useEffect(() => {
    if (!platform) return;
    if (nodeScope) {
      const stops: Array<() => void> = [];
      let stopped = false;
      const keep = (stop: () => void) => {
        if (stopped) stop();
        else stops.push(stop);
      };
      void listenInScope(nodeScope, agentAccountsChangedEvent, (payload) => {
        if (isAgentAccountsChangedEvent(payload) && payload.platform === platform) changed();
      })
        .then(keep)
        .catch(() => undefined);
      void onReconnectInScope(nodeScope, () => changed())
        .then(keep)
        .catch(() => undefined);
      return () => {
        stopped = true;
        for (const stop of stops.splice(0)) stop();
      };
    }
    const controller = new AbortController();
    void listenAuthoritative<unknown>(
      AGENT_ACCOUNTS_CHANGED_EVENT,
      ({ payload }) => {
        if (isAgentAccountsChangedEvent(payload) && payload.platform === platform) changed();
      },
      { onResync: () => changed(), signal: controller.signal },
    ).catch(() => undefined);
    return () => controller.abort();
  }, [nodeScope, platform]);
}
