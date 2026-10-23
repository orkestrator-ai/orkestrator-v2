import { useEffect, useState } from "react";
import type { NativeAgentTurnPhase } from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { getNativeAgentSessionStateUpdate } from "@/lib/backend";
import { createSessionKey } from "@/lib/utils";

/** Read only action state, without mounting a transcript or relying on its renderer cache. */
export function useMultiReviewPrPhase({
  environmentId,
  tabId,
  agent,
  active,
  loadSessionState = getNativeAgentSessionStateUpdate,
}: {
  environmentId: string;
  tabId: string | undefined;
  agent: AgentPlatform | undefined;
  active: boolean;
  loadSessionState?: typeof getNativeAgentSessionStateUpdate;
}): NativeAgentTurnPhase | undefined {
  const key = tabId && agent ? `${createSessionKey(environmentId, tabId)}:${agent}` : null;
  const [observed, setObserved] = useState<{ key: string; phase: NativeAgentTurnPhase } | null>(
    null,
  );
  useEffect(() => {
    if (!active || !tabId || !agent || !key) return;
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
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
      }
      if (!cancelled) timer = window.setTimeout(() => void refresh(), 2_000);
    };
    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, agent, environmentId, key, loadSessionState, tabId]);
  return observed?.key === key ? observed?.phase : undefined;
}
