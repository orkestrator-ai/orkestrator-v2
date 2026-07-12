import { create } from "zustand";

/**
 * PR Monitoring modes control the polling interval for PR status checks.
 * - idle: No polling (environment not active)
 * - normal: 20 second intervals (standard active environment)
 * - create-pending: 5 second intervals (after Create PR button pressed)
 * - merge-pending: 1 second intervals (after Merge PR button pressed)
 */
export type PrMonitoringMode = "idle" | "normal" | "create-pending" | "merge-pending";

/** Polling intervals for each mode (in milliseconds) */
export const PR_MONITOR_INTERVALS: Record<PrMonitoringMode, number> = {
  idle: Infinity,
  normal: 20_000,        // 20 seconds
  "create-pending": 5_000,  // 5 seconds
  "merge-pending": 1_000,   // 1 second
};

/** Mode timeouts - how long before reverting to normal (in milliseconds) */
export const PR_MONITOR_TIMEOUTS: Partial<Record<PrMonitoringMode, number>> = {
  "merge-pending": 20_000,  // 20 seconds max for merge pending
};

/** Exponential backoff configuration for consecutive errors */
export const PR_MONITOR_BACKOFF = {
  /** Maximum number of errors before capping backoff */
  maxErrors: 5,
  /** Maximum backoff interval (5 minutes) */
  maxInterval: 300_000,
} as const;

/**
 * Calculate the effective polling interval with exponential backoff.
 * Formula: baseInterval * 2^min(consecutiveErrors, maxErrors)
 * Capped at maxInterval (5 minutes).
 */
export function getEffectiveInterval(
  mode: PrMonitoringMode,
  consecutiveErrors: number
): number {
  const baseInterval = PR_MONITOR_INTERVALS[mode];
  if (baseInterval === Infinity) return Infinity;
  if (consecutiveErrors === 0) return baseInterval;

  const cappedErrors = Math.min(consecutiveErrors, PR_MONITOR_BACKOFF.maxErrors);
  const multiplier = Math.pow(2, cappedErrors);
  const backoffInterval = baseInterval * multiplier;

  return Math.min(backoffInterval, PR_MONITOR_BACKOFF.maxInterval);
}

/** Per-environment monitoring state */
export interface MonitoringState {
  mode: PrMonitoringMode;
  lastCheckTime: number;
  checkInProgress: boolean;
  modeStartTime: number;
  consecutiveErrors: number;
}

interface PrMonitorStore {
  /** Per-environment monitoring state */
  monitoredEnvironments: Record<string, MonitoringState>;

  /** Currently active environment ID */
  activeEnvironmentId: string | null;

  // Public API

  /** Start monitoring an environment with the specified mode */
  startMonitoring: (environmentId: string, mode?: PrMonitoringMode) => void;

  /** Stop monitoring an environment (removes from tracking) */
  stopMonitoring: (environmentId: string) => void;

  /** Set the monitoring mode for an environment */
  setMonitoringMode: (environmentId: string, mode: PrMonitoringMode) => void;

  /** Set the active environment (only active environment gets polled) */
  setActiveEnvironment: (environmentId: string | null) => void;

  /** Get monitoring state for an environment */
  getMonitoringState: (environmentId: string) => MonitoringState | null;

  // Internal API (used by usePrMonitorService)

  /** Mark check as in progress */
  _setCheckInProgress: (environmentId: string, inProgress: boolean) => void;

  /** Update the last check time */
  _updateLastCheckTime: (environmentId: string) => void;

  /** Increment consecutive error count */
  _incrementErrors: (environmentId: string) => void;

  /** Reset consecutive error count */
  _resetErrors: (environmentId: string) => void;
}

const createDefaultMonitoringState = (mode: PrMonitoringMode = "normal"): MonitoringState => ({
  mode,
  lastCheckTime: 0,
  checkInProgress: false,
  modeStartTime: Date.now(),
  consecutiveErrors: 0,
});

export const usePrMonitorStore = create<PrMonitorStore>()((set, get) => ({
  monitoredEnvironments: {},
  activeEnvironmentId: null,

  startMonitoring: (environmentId, mode = "normal") => {
    console.log(`[PrMonitorStore] Starting monitoring for ${environmentId} in ${mode} mode`);
    set((state) => ({
      monitoredEnvironments: {
        ...state.monitoredEnvironments,
        [environmentId]: createDefaultMonitoringState(mode),
      },
    }));
  },

  stopMonitoring: (environmentId) => {
    console.log(`[PrMonitorStore] Stopping monitoring for ${environmentId}`);
    set((state) => {
      const { [environmentId]: _, ...rest } = state.monitoredEnvironments;
      return { monitoredEnvironments: rest };
    });
  },

  setMonitoringMode: (environmentId, mode) => {
    const existing = get().monitoredEnvironments[environmentId];
    if (!existing) {
      console.log(`[PrMonitorStore] Cannot set mode for ${environmentId} - not being monitored`);
      return;
    }

    if (existing.mode === mode) {
      return; // No change needed
    }

    console.log(`[PrMonitorStore] Mode change for ${environmentId}: ${existing.mode} -> ${mode}`);
    set((state) => ({
      monitoredEnvironments: {
        ...state.monitoredEnvironments,
        [environmentId]: {
          ...existing,
          mode,
          modeStartTime: Date.now(),
        },
      },
    }));
  },

  setActiveEnvironment: (environmentId) => {
    const currentActive = get().activeEnvironmentId;
    if (currentActive === environmentId) {
      return; // No change
    }

    console.log(`[PrMonitorStore] Active environment changed: ${currentActive} -> ${environmentId}`);
    set({ activeEnvironmentId: environmentId });
  },

  getMonitoringState: (environmentId) => {
    return get().monitoredEnvironments[environmentId] ?? null;
  },

  _setCheckInProgress: (environmentId, inProgress) => {
    set((state) => {
      const existing = state.monitoredEnvironments[environmentId];
      if (!existing) return state;

      return {
        monitoredEnvironments: {
          ...state.monitoredEnvironments,
          [environmentId]: { ...existing, checkInProgress: inProgress },
        },
      };
    });
  },

  _updateLastCheckTime: (environmentId) => {
    set((state) => {
      const existing = state.monitoredEnvironments[environmentId];
      if (!existing) return state;

      return {
        monitoredEnvironments: {
          ...state.monitoredEnvironments,
          [environmentId]: { ...existing, lastCheckTime: Date.now() },
        },
      };
    });
  },

  _incrementErrors: (environmentId) => {
    set((state) => {
      const existing = state.monitoredEnvironments[environmentId];
      if (!existing) return state;

      return {
        monitoredEnvironments: {
          ...state.monitoredEnvironments,
          [environmentId]: {
            ...existing,
            consecutiveErrors: existing.consecutiveErrors + 1,
          },
        },
      };
    });
  },

  _resetErrors: (environmentId) => {
    set((state) => {
      const existing = state.monitoredEnvironments[environmentId];
      if (!existing) return state;

      return {
        monitoredEnvironments: {
          ...state.monitoredEnvironments,
          [environmentId]: { ...existing, consecutiveErrors: 0 },
        },
      };
    });
  },
}));
