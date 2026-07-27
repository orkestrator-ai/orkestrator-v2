import { create } from "zustand";
import type { AgentActivityState } from "@/types";

export type { AgentActivityState } from "@/types";

/** Callback type for state transitions */
export type AgentStateCallback = (
  containerId: string,
  previousState: AgentActivityState,
  newState: AgentActivityState,
  occurredAt?: string,
) => void;

/** Unique identifier for registered callbacks */
type CallbackId = string;

interface AgentActivityStoreState {
  // State: Map of tabId -> activity state
  tabStates: Record<string, AgentActivityState>;
  // State: Map of containerId/environmentId -> activity state (for sidebar display)
  containerStates: Record<string, AgentActivityState>;
  // Last local observation time for each container/environment activity key.
  containerStateUpdatedAt: Record<string, string>;
  // Reference counts: Map of containerId -> number of tabs using it
  containerRefCounts: Record<string, number>;
  // Callbacks: Map of callbackId -> callback function
  stateChangeCallbacks: Map<CallbackId, AgentStateCallback>;

  // Actions
  setTabState: (tabId: string, state: AgentActivityState) => void;
  removeTabState: (tabId: string) => void;
  setContainerState: (
    containerId: string,
    state: AgentActivityState,
    occurredAt?: string,
  ) => void;
  removeContainerState: (containerId: string) => void;
  /** Increment the reference count for a container (call when tab mounts) */
  incrementContainerRef: (containerId: string) => void;
  /** Decrement the reference count (call when tab unmounts) */
  decrementContainerRef: (containerId: string) => void;

  // Callback registration
  registerStateCallback: (callback: AgentStateCallback) => CallbackId;
  unregisterStateCallback: (callbackId: CallbackId) => void;

  // Selectors
  getTabState: (tabId: string) => AgentActivityState;
  getContainerState: (containerId: string) => AgentActivityState;
}

// Counter for generating unique callback IDs
let callbackIdCounter = 0;
let lastActivityObservationTime = 0;

function nextObservationTime(requested?: string): string {
  const requestedTime = requested ? Date.parse(requested) : Number.NaN;
  const time = Number.isFinite(requestedTime)
    ? requestedTime
    : Math.max(Date.now(), lastActivityObservationTime + 1);
  lastActivityObservationTime = Math.max(lastActivityObservationTime, time);
  return new Date(time).toISOString();
}

export const useAgentActivityStore = create<AgentActivityStoreState>()(
  (set, get) => ({
    // Initial state
    tabStates: {},
    containerStates: {},
    containerStateUpdatedAt: {},
    containerRefCounts: {},
    stateChangeCallbacks: new Map(),

    // Actions
    setTabState: (tabId, state) =>
      set((prev) => ({
        tabStates: { ...prev.tabStates, [tabId]: state },
      })),

    removeTabState: (tabId) =>
      set((prev) => {
        const { [tabId]: _, ...rest } = prev.tabStates;
        return { tabStates: rest };
      }),

    setContainerState: (containerId, state, requestedOccurredAt) => {
      const previousState = get().containerStates[containerId] || "idle";
      const requestedTime = requestedOccurredAt
        ? Date.parse(requestedOccurredAt)
        : Number.NaN;
      const previousTime = Date.parse(
        get().containerStateUpdatedAt[containerId] ?? "",
      );
      if (
        Number.isFinite(requestedTime)
        && Number.isFinite(previousTime)
        && requestedTime <= previousTime
      ) {
        return;
      }
      if (previousState === state) return;
      const occurredAt = nextObservationTime(requestedOccurredAt);

      // Update state first
      set((prev) => ({
        containerStates: { ...prev.containerStates, [containerId]: state },
        containerStateUpdatedAt: {
          ...prev.containerStateUpdatedAt,
          [containerId]: occurredAt,
        },
      }));

      // Notify callbacks if state actually changed
      // Deferred to next microtask to avoid blocking state updates
      if (previousState !== state) {
        queueMicrotask(() => {
          const callbacks = get().stateChangeCallbacks;
          callbacks.forEach((callback) => {
            try {
              callback(containerId, previousState, state, occurredAt);
            } catch (e) {
              console.error("[agentActivityStore] Callback error:", e);
            }
          });
        });
      }
    },

    removeContainerState: (containerId) =>
      set((prev) => {
        const { [containerId]: _, ...rest } = prev.containerStates;
        const { [containerId]: ___, ...restUpdatedAt } =
          prev.containerStateUpdatedAt;
        const { [containerId]: __, ...restCounts } = prev.containerRefCounts;
        return {
          containerStates: rest,
          containerStateUpdatedAt: restUpdatedAt,
          containerRefCounts: restCounts,
        };
      }),

    incrementContainerRef: (containerId) =>
      set((prev) => ({
        containerRefCounts: {
          ...prev.containerRefCounts,
          [containerId]: (prev.containerRefCounts[containerId] || 0) + 1,
        },
      })),

    decrementContainerRef: (containerId) =>
      set((prev) => {
        const currentCount = prev.containerRefCounts[containerId] || 0;
        const newCount = Math.max(0, currentCount - 1);

        if (newCount === 0) {
          // No more tabs using this container — remove ref count but preserve
          // activity state so the sidebar icon keeps showing the correct color
          // even when the user navigates to a different project.
          const { [containerId]: _, ...restCounts } = prev.containerRefCounts;
          return { containerRefCounts: restCounts };
        }

        // Still have tabs, just decrement count
        return {
          containerRefCounts: {
            ...prev.containerRefCounts,
            [containerId]: newCount,
          },
        };
      }),

    // Callback registration
    registerStateCallback: (callback) => {
      const callbackId = `cb-${++callbackIdCounter}`;
      set((prev) => {
        const newCallbacks = new Map(prev.stateChangeCallbacks);
        newCallbacks.set(callbackId, callback);
        return { stateChangeCallbacks: newCallbacks };
      });
      console.log("[agentActivityStore] Registered state callback:", callbackId);
      return callbackId;
    },

    unregisterStateCallback: (callbackId) => {
      set((prev) => {
        const newCallbacks = new Map(prev.stateChangeCallbacks);
        newCallbacks.delete(callbackId);
        return { stateChangeCallbacks: newCallbacks };
      });
      console.log("[agentActivityStore] Unregistered state callback:", callbackId);
    },

    // Selectors
    getTabState: (tabId) => get().tabStates[tabId] || "idle",
    getContainerState: (containerId) => get().containerStates[containerId] || "idle",
  })
);
