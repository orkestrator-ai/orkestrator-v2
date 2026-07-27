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
    notifyCallbacks?: boolean,
  ) => void;
  /** Replace an optimistic observation with an authoritative backend value. */
  reconcileContainerState: (
    containerId: string,
    state: AgentActivityState | undefined,
    occurredAt: string | undefined,
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

export const AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS = 5 * 60_000;

export function parseUsableAgentActivityTime(
  value: string | undefined,
  referenceTime = Date.now(),
): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && parsed <= referenceTime + AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS
    ? parsed
    : Number.NEGATIVE_INFINITY;
}

function nextObservationTime(requested?: string): string {
  const referenceTime = Date.now();
  const requestedTime = parseUsableAgentActivityTime(requested, referenceTime);
  const previousGeneratedTime =
    lastActivityObservationTime <= referenceTime + AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS
      ? lastActivityObservationTime
      : Number.NEGATIVE_INFINITY;
  const time = Number.isFinite(requestedTime)
    ? requestedTime
    : Math.max(
        referenceTime,
        Number.isFinite(previousGeneratedTime)
          ? previousGeneratedTime + 1
          : Number.NEGATIVE_INFINITY,
      );
  lastActivityObservationTime = Math.max(previousGeneratedTime, time);
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

    setContainerState: (
      containerId,
      state,
      requestedOccurredAt,
      notifyCallbacks = true,
    ) => {
      const current = get();
      const hadPreviousObservation = Object.hasOwn(
        current.containerStates,
        containerId,
      );
      const previousState = current.containerStates[containerId] ?? "idle";
      const referenceTime = Date.now();
      const requestedTime = parseUsableAgentActivityTime(
        requestedOccurredAt,
        referenceTime,
      );
      const previousTime = parseUsableAgentActivityTime(
        current.containerStateUpdatedAt[containerId],
        referenceTime,
      );
      if (
        Number.isFinite(requestedTime)
        && Number.isFinite(previousTime)
        && requestedTime <= previousTime
      ) {
        return;
      }
      const occurredAt = nextObservationTime(requestedOccurredAt);

      // A first idle observation is still meaningful: it must override a stale
      // persisted working snapshot and reach the persistence callback. Newer
      // same-state observations refresh local recency without manufacturing a
      // state transition callback.
      set((prev) => ({
        containerStates: { ...prev.containerStates, [containerId]: state },
        containerStateUpdatedAt: {
          ...prev.containerStateUpdatedAt,
          [containerId]: occurredAt,
        },
      }));

      // Notify callbacks if state actually changed
      // Deferred to next microtask to avoid blocking state updates
      if (notifyCallbacks && (!hadPreviousObservation || previousState !== state)) {
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

    reconcileContainerState: (containerId, state, occurredAt) =>
      set((prev) => {
        const { [containerId]: _state, ...restStates } = prev.containerStates;
        const { [containerId]: _time, ...restUpdatedAt } =
          prev.containerStateUpdatedAt;
        const occurredTime = parseUsableAgentActivityTime(occurredAt);
        if (!state || !Number.isFinite(occurredTime)) {
          return {
            containerStates: restStates,
            containerStateUpdatedAt: restUpdatedAt,
          };
        }
        return {
          containerStates: {
            ...restStates,
            [containerId]: state,
          },
          containerStateUpdatedAt: {
            ...restUpdatedAt,
            [containerId]: new Date(occurredTime).toISOString(),
          },
        };
      }),

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
