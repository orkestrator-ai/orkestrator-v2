import { create } from "zustand";
import { parseUsableAgentActivityTime } from "@orkestrator/protocol/agent-activity";
import type { AgentActivityState } from "@/types";

export type { AgentActivityState } from "@/types";
// Re-exported so callers keep importing activity ordering from the store they
// already depend on, while the backend and the renderer share one definition.
export {
  AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS,
  parseUsableAgentActivityTime,
} from "@orkestrator/protocol/agent-activity";

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
  /**
   * Record an observation. Returns false when it was discarded as older than
   * the one already held, so the caller can avoid committing to a per-source
   * view of the world that the store did not adopt.
   */
  setContainerState: (
    containerId: string,
    state: AgentActivityState,
    occurredAt?: string,
    notifyCallbacks?: boolean,
  ) => boolean;
  /**
   * Replace an optimistic observation with an authoritative backend value.
   * A missing state or unusable timestamp is a no-op — see the implementation.
   */
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

/**
 * Mint the token for one observation.
 *
 * A caller-supplied token (the backend poller's) is authoritative and used as
 * given. A locally-generated one only has to beat *this key's* previous token,
 * which is what keeps two observations landing in the same millisecond
 * distinguishable. Deriving it per key rather than from a shared counter means
 * a backend token that is slightly ahead of the local clock cannot push an
 * unrelated environment's token into the future.
 */
function nextObservationTime(
  requestedTime: number,
  previousTime: number,
  referenceTime: number,
): string {
  const time = Number.isFinite(requestedTime)
    ? requestedTime
    : Math.max(
        referenceTime,
        Number.isFinite(previousTime)
          ? previousTime + 1
          : Number.NEGATIVE_INFINITY,
      );
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
        return false;
      }
      const occurredAt = nextObservationTime(
        requestedTime,
        previousTime,
        referenceTime,
      );

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
      return true;
    },

    reconcileContainerState: (containerId, state, occurredAt) =>
      set((prev) => {
        const occurredTime = parseUsableAgentActivityTime(occurredAt);
        // No usable authoritative pair means there is nothing to reconcile
        // *to* — not that the local observation was wrong. Dropping it here
        // would turn a failed backend write into a sidebar that reads idle
        // while the agent is still working. `removeContainerState` is the
        // deliberate way to forget a key.
        if (!state || !Number.isFinite(occurredTime)) return prev;
        const { [containerId]: _state, ...restStates } = prev.containerStates;
        const { [containerId]: _time, ...restUpdatedAt } =
          prev.containerStateUpdatedAt;
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
