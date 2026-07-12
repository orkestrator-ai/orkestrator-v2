// Hook for monitoring agent activity state at the tab level.
// Container-level state (for sidebar icons) and polling lifecycle are
// handled globally by useGlobalActivityMonitor in App.tsx.
import { useEffect, useRef } from "react";
import { listen, UnlistenFn } from "@/lib/native/events";
import {
  useAgentActivityStore,
  type AgentActivityState,
} from "@/stores/agentActivityStore";

interface AgentStateEvent {
  container_id: string;
  state: string;
}

/**
 * Hook to monitor agent activity state for a terminal tab.
 * Listens for Electron events and updates tab-level state only.
 * Polling and container-level state are managed by useGlobalActivityMonitor.
 *
 * @param containerId - The Docker container ID to monitor (null to disable)
 * @param tabId - The terminal tab ID to associate state with
 */
export function useAgentState(
  containerId: string | null,
  tabId: string
): void {
  const { setTabState, removeTabState } = useAgentActivityStore();
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    if (!containerId) {
      removeTabState(tabId);
      return;
    }

    const eventName = `claude-state-${containerId}`;

    listen<AgentStateEvent>(eventName, (event) => {
      const state = event.payload.state as AgentActivityState;
      if (state === "working" || state === "waiting" || state === "idle") {
        setTabState(tabId, state);
      }
    })
      .then((unlisten) => {
        unlistenRef.current = unlisten;
      })
      .catch((e) => {
        console.error("Failed to listen for agent state events:", e);
      });

    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      removeTabState(tabId);
    };
  }, [containerId, tabId, setTabState, removeTabState]);
}
