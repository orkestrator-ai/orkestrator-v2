import { useEffect, useReducer } from "react";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import {
  getEnvironmentProcessUsage,
  getSystemUsage,
  type EnvironmentProcessUsageSnapshot,
  type SystemUsageSnapshot,
} from "@/lib/backend";
import {
  getReadCoordinator,
  type ReadCoordinatorClock,
  type ReadKey,
} from "@/lib/read-coordinator";

/**
 * Shared, demand-driven system and process meters.
 *
 * Every consumer of the backend's host sample subscribes to the same read
 * coordinator key, so the always-mounted title bar (five seconds) and an open
 * agent-information popover (three seconds) run one read at the fastest active
 * cadence; closing the faster consumer restores the slower one. The coordinator
 * also pauses both while the document is hidden and reconciles once on return.
 *
 * The disk reading is taken on the backend's data directory — the only disk
 * target `get_system_usage` samples — so the key names that target and the
 * coordinator's connection identity scopes it to one backend. A future
 * per-project disk target must extend `options` rather than share this key.
 */
export const SYSTEM_USAGE_READ_KEY: ReadKey = {
  resource: "system-usage",
  target: "backend",
  options: "disk=data-dir",
};

/** Environment process enumeration: separate, demand-driven (open panels only). */
export const ENVIRONMENT_PROCESS_USAGE_READ_KEY: ReadKey = {
  resource: "environment-process-usage",
  target: "backend",
};

/**
 * A sample is presented as current only while the read that produced it
 * started less than this long ago, measured on this client's clock.
 */
export const SYSTEM_USAGE_STALE_AFTER_MS = 10_000;

export interface UsageView<T> {
  /** Last successful sample, retained across failures. */
  sample: T | null;
  /** Backend `sampledAt` of that sample (the source measurement time). */
  sampledAt: string | null;
  /**
   * Coordinator-clock start time of the read that produced `sample`. Compare
   * only with `getReadCoordinator().clock.now()`.
   */
  observedAt: number | null;
  /**
   * The retained sample must not be presented as a current measurement: the
   * read that produced it started more than {@link SYSTEM_USAGE_STALE_AFTER_MS}
   * ago. A failed, paused or hung refresh never makes a sample younger.
   */
  stale: boolean;
  /** The latest refresh failed; the retained sample is from an earlier read. */
  failed: boolean;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSystemUsageSnapshot(value: unknown): value is SystemUsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.cpuPercent === "number" &&
    typeof candidate.ramPercent === "number" &&
    isTimestamp(candidate.sampledAt)
  );
}

function isProcessUsageSnapshot(value: unknown): value is EnvironmentProcessUsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.environments) && isTimestamp(candidate.sampledAt);
}

/**
 * Forces one render when the retained observation crosses the staleness
 * threshold. Without it a hung or paused read would keep showing an old sample
 * as current, because nothing else changes state.
 */
function useStalenessDeadline(clock: ReadCoordinatorClock, observedAt: number | null): void {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (observedAt === null) return;
    const remaining = observedAt + SYSTEM_USAGE_STALE_AFTER_MS - clock.now();
    if (remaining < 0) return;
    const timer = clock.setTimeout(rerender, remaining + 1);
    return () => clock.clearTimeout(timer);
  }, [clock, observedAt]);
}

function useUsageRead<T extends { sampledAt: string }>(options: {
  key: ReadKey;
  active: boolean;
  intervalMs: number;
  read: () => Promise<T>;
  isSample: (value: unknown) => value is T;
}): UsageView<T> {
  const { key, active, intervalMs, read, isSample } = options;
  const coordinator = getReadCoordinator();
  const { state } = useCoordinatedRead<T>({
    key,
    coordinator,
    enabled: active,
    demand: { active, intervalMs, priority: "auxiliary" },
    read: async () => {
      const sample = await read();
      // A malformed answer is a failed read, never a new measurement.
      if (!isSample(sample)) throw new Error("The backend returned an invalid usage sample");
      return sample;
    },
    trackState: true,
  });
  const sample = state?.hasValue ? (state.value ?? null) : null;
  // `observedAt` is when the read that produced `sample` started; the
  // coordinator never advances it for a failed read.
  const observedAt = sample ? (state?.observedAt ?? null) : null;
  useStalenessDeadline(coordinator.clock, observedAt);
  return {
    sample,
    sampledAt: sample?.sampledAt ?? null,
    observedAt,
    stale:
      observedAt !== null && coordinator.clock.now() - observedAt > SYSTEM_USAGE_STALE_AFTER_MS,
    failed: state?.status === "error",
  };
}

/** Host CPU/RAM/GPU/disk sample shared by every mounted meter. */
export function useSystemUsage({
  intervalMs,
  active = true,
}: {
  intervalMs: number;
  active?: boolean;
}): UsageView<SystemUsageSnapshot> {
  return useUsageRead({
    key: SYSTEM_USAGE_READ_KEY,
    active,
    intervalMs,
    read: getSystemUsage,
    isSample: isSystemUsageSnapshot,
  });
}

/** Per-environment process list; only read while a panel shows it. */
export function useEnvironmentProcessUsage({
  intervalMs,
  active = true,
}: {
  intervalMs: number;
  active?: boolean;
}): UsageView<EnvironmentProcessUsageSnapshot> {
  return useUsageRead({
    key: ENVIRONMENT_PROCESS_USAGE_READ_KEY,
    active,
    intervalMs,
    read: getEnvironmentProcessUsage,
    isSample: isProcessUsageSnapshot,
  });
}

/** Local time of a backend sample, for "sampled at" labels. */
export function formatSampleTime(sampledAt: string | null): string | null {
  if (!sampledAt) return null;
  const parsed = Date.parse(sampledAt);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
