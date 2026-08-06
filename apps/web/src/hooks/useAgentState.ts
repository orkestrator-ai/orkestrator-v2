// Tab-level state is a presentation projection of the backend tmux monitor.
// Environment-level activity and the polling lifecycle remain backend-owned.
import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@/lib/native/events";
import {
  useAgentActivityStore,
  type AgentActivityState,
} from "@/stores/agentActivityStore";

interface AgentStateEvent {
  container_id: string;
  state: string;
}

export function useAgentState(
  containerId: string | null,
  tabId: string
): void {
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

    listen<AgentStateEvent>(eventName, (event) => {
      const state = event.payload.state as AgentActivityState;
      if (state === "working" || state === "waiting" || state === "idle") {
        setTabState(tabId, state);
      }
    })
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
