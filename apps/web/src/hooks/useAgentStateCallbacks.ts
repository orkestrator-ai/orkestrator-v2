// Hook for registering callbacks when agent state changes
import { useEffect, useRef, useCallback } from "react";
import {
  useAgentActivityStore,
  type AgentActivityState,
  type AgentStateCallback,
} from "@/stores/agentActivityStore";

export type { AgentStateCallback };

interface UseAgentStateCallbacksOptions {
  /** Container/environment ID to filter callbacks for (optional - if not provided, receives all state changes) */
  containerId?: string | null;
  /** Callback when agent transitions to idle from any other state */
  onBecomeIdle?: (containerId: string) => void;
  /** Callback when agent transitions to working from any other state */
  onBecomeWorking?: (containerId: string) => void;
  /** Callback when agent transitions to waiting from any other state */
  onBecomeWaiting?: (containerId: string) => void;
  /** Generic callback for any state transition */
  onStateChange?: AgentStateCallback;
}

/**
 * Hook to register callbacks for agent state transitions.
 * Callbacks are automatically unregistered on cleanup.
 *
 * @example
 * // Detect when an agent becomes idle for a specific environment
 * useAgentStateCallbacks({
 *   containerId: myContainerId,
 *   onBecomeIdle: (containerId) => {
 *     console.log("Agent is now idle in:", containerId);
 *     detectPR();
 *   },
 * });
 *
 * @example
 * // Listen to all state changes across all environments
 * useAgentStateCallbacks({
 *   onStateChange: (containerId, previousState, newState) => {
 *     console.log(`${containerId}: ${previousState} -> ${newState}`);
 *   },
 * });
 */
export function useAgentStateCallbacks({
  containerId,
  onBecomeIdle,
  onBecomeWorking,
  onBecomeWaiting,
  onStateChange,
}: UseAgentStateCallbacksOptions): void {
  const { registerStateCallback, unregisterStateCallback } = useAgentActivityStore();
  const callbackIdRef = useRef<string | null>(null);

  // Store callbacks in refs to avoid re-registering on every render
  const onBecomeIdleRef = useRef(onBecomeIdle);
  const onBecomeWorkingRef = useRef(onBecomeWorking);
  const onBecomeWaitingRef = useRef(onBecomeWaiting);
  const onStateChangeRef = useRef(onStateChange);

  // Update refs when callbacks change
  useEffect(() => {
    onBecomeIdleRef.current = onBecomeIdle;
    onBecomeWorkingRef.current = onBecomeWorking;
    onBecomeWaitingRef.current = onBecomeWaiting;
    onStateChangeRef.current = onStateChange;
  }, [onBecomeIdle, onBecomeWorking, onBecomeWaiting, onStateChange]);

  // Create a stable callback that dispatches to the appropriate handlers
  const handleStateChange = useCallback(
    (
      eventContainerId: string,
      previousState: AgentActivityState,
      newState: AgentActivityState
    ) => {
      // Filter by containerId if specified
      if (containerId && eventContainerId !== containerId) {
        return;
      }

      // Call generic state change handler
      onStateChangeRef.current?.(eventContainerId, previousState, newState);

      // Call specific transition handlers
      if (newState === "idle" && previousState !== "idle") {
        onBecomeIdleRef.current?.(eventContainerId);
      }
      if (newState === "working" && previousState !== "working") {
        onBecomeWorkingRef.current?.(eventContainerId);
      }
      if (newState === "waiting" && previousState !== "waiting") {
        onBecomeWaitingRef.current?.(eventContainerId);
      }
    },
    [containerId]
  );

  // Register callback on mount, unregister on unmount
  useEffect(() => {
    // Only register if we have at least one callback
    const hasCallbacks =
      onBecomeIdleRef.current ||
      onBecomeWorkingRef.current ||
      onBecomeWaitingRef.current ||
      onStateChangeRef.current;

    if (!hasCallbacks) {
      return;
    }

    callbackIdRef.current = registerStateCallback(handleStateChange);

    return () => {
      if (callbackIdRef.current) {
        unregisterStateCallback(callbackIdRef.current);
        callbackIdRef.current = null;
      }
    };
  }, [handleStateChange, registerStateCallback, unregisterStateCallback]);
}
