// Tab-level state is a presentation projection of the backend tmux monitor.
// Environment-level activity and the polling lifecycle remain backend-owned.
import { useEffect, useRef } from "react";
import { getClaudeTerminalState } from "@/lib/backend";
import { listenAuthoritative } from "@/lib/native/authoritative-events";
import type { UnlistenFn } from "@/lib/native/events";
import { useAgentActivityStore, type AgentActivityState } from "@/stores/agentActivityStore";

interface AgentStateEvent {
  container_id: string;
  state: string;
  occurred_at?: string;
}

function isTabState(state: string): state is AgentActivityState {
  return state === "working" || state === "waiting" || state === "idle";
}

export function useAgentState(containerId: string | null, tabId: string): void {
  const setTabState = useAgentActivityStore((state) => state.setTabState);
  const removeTabState = useAgentActivityStore((state) => state.removeTabState);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    if (!containerId) {
      removeTabState(tabId);
      return;
    }

    const eventName = `claude-state-${containerId}`;
    let disposed = false;
    // Newest observation applied so far. A snapshot read can resolve after a
    // newer live event and must not roll the tab back to an older state.
    let appliedAt = Number.NEGATIVE_INFINITY;
    const apply = (state: string, occurredAt: string | undefined) => {
      if (disposed || !isTabState(state)) return;
      const at = occurredAt ? Date.parse(occurredAt) : Number.NaN;
      if (Number.isFinite(at)) {
        if (at < appliedAt) return;
        appliedAt = at;
      }
      setTabState(tabId, state);
    };

    // Frames are emitted only on change, so one missed during a disconnect
    // replay could not cover would otherwise stick until the next transition.
    listenAuthoritative<AgentStateEvent>(
      eventName,
      (event) => apply(event.payload.state, event.payload.occurred_at),
      {
        resyncOnSubscribe: true,
        onResync: async () => {
          if (disposed) return;
          const snapshot = await getClaudeTerminalState(containerId);
          if (snapshot) apply(snapshot.state, snapshot.occurredAt);
        },
      },
    )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenRef.current = unlisten;
        }
      })
      .catch((error) => {
        console.error("Failed to listen for agent state events:", error);
      });

    return () => {
      disposed = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
      removeTabState(tabId);
    };
  }, [containerId, tabId, setTabState, removeTabState]);
}
