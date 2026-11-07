import { startCoordinatedPoll } from "@/lib/coordinated-poll";
import { useEffect, useState } from "react";
import type { NativeAgentTurnPhase } from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { getNativeAgentSessionStateUpdate } from "@/lib/backend";
import { createSessionKey } from "@/lib/utils";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/** Read only action state, without mounting a transcript or relying on its renderer cache. */
export function useMultiReviewPrPhase({
  environmentId,
  tabId,
  agent,
  active,
  loadSessionState: loadSessionStateOverride,
}: {
  environmentId: string;
  tabId: string | undefined;
  agent: AgentPlatform | undefined;
  active: boolean;
  loadSessionState?: typeof getNativeAgentSessionStateUpdate;
}): NativeAgentTurnPhase | undefined {
  const nodeBackend = useScopeBackend();
  const loadSessionState =
    loadSessionStateOverride === undefined
      ? nodeBackend.getNativeAgentSessionStateUpdate
      : loadSessionStateOverride;
  const key = tabId && agent ? `${createSessionKey(environmentId, tabId)}:${agent}` : null;
  const [observed, setObserved] = useState<{ key: string; phase: NativeAgentTurnPhase } | null>(
    null,
  );
  useEffect(() => {
    if (!active || !tabId || !agent || !key) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const update = await loadSessionState({
          environmentId,
          agent,
          logicalSessionKey: createSessionKey(environmentId, tabId),
          viewVersion: 1,
        });
        if (cancelled) return;
        setObserved(update.status === "snapshot" ? { key, phase: update.value.turn.phase } : null);
      } catch {
        if (!cancelled) setObserved(null);
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const stopPolling = startCoordinatedPoll({
      resource: "multi-review-pr-phase",
      target: key,
      intervalMs: 2_000,
      read: refresh,
    });
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [active, agent, environmentId, key, loadSessionState, tabId]);
  return observed?.key === key ? observed?.phase : undefined;
}
