import { useEffect, useReducer } from "react";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import type { EnvironmentProcessUsageSnapshot, SystemUsageSnapshot } from "@/lib/backend";
import { backendClientOver, NO_ARGS } from "@/lib/node-scope/domains/invoke-over";
import { asSystemModel, systemApi } from "@/lib/node-scope/domains/system";
import { scopeBackendClient } from "@/lib/backend/client";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { isAppCommandScope } from "@/lib/node-scope-slots";
import { portalStore } from "@/lib/portal/portal-store";
import {
  getReadCoordinator,
  readCoordinatorFor,
  readKeyId,
  type ReadCoordinator,
  type ReadCoordinatorClock,
  type ReadKey,
} from "@/lib/read-coordinator";
import type { BackendId } from "@orkestrator/protocol/federation";
import { useScopeBackend } from "@/hooks/useScopeBackend";

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

/**
 * A usage read that has not answered by now counts as failed. It sits above the
 * backend's own bounds: process enumeration admits probes for ten seconds,
 * and its final batch has a two-second timeout. This leaves transport headroom.
 */
export const USAGE_READ_TIMEOUT_MS = 20_000;

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
  /**
   * The latest finished read failed or this backend lacks the command; any
   * retained sample is from an earlier read. A retry in flight does not clear it.
   */
  failed: boolean;
}

/** One bounded result per physical request, retained until that request settles. */
const outstandingRequests = new WeakMap<ReadCoordinator, Map<string, Promise<unknown>>>();

/**
 * Fails a read that outlives {@link USAGE_READ_TIMEOUT_MS}. `invoke` cannot be
 * aborted, so the request stays open; retrying alongside it would add one more
 * open request per retry, and in a browser those use up the connections the
 * whole app shares. The key therefore fails at once until its request settles,
 * and that late answer is dropped, since it describes the past.
 */
function readWithTimeout<T>(
  coordinator: ReadCoordinator,
  id: string,
  read: () => Promise<T>,
): Promise<T> {
  const outstanding = outstandingRequests.get(coordinator) ?? new Map<string, Promise<unknown>>();
  outstandingRequests.set(coordinator, outstanding);
  const pending = outstanding.get(id);
  if (pending) return pending as Promise<T>;
  const request = Promise.resolve(read());
  const result = new Promise<T>((resolve, reject) => {
    const timer = coordinator.clock.setTimeout(() => {
      reject(new Error("The usage read timed out"));
    }, USAGE_READ_TIMEOUT_MS);
    request.then(
      (value) => {
        coordinator.clock.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        coordinator.clock.clearTimeout(timer);
        reject(error);
      },
    );
  });
  outstanding.set(id, result);
  const settled = () => {
    if (outstanding.get(id) === result) outstanding.delete(id);
  };
  void request.then(settled, settled);
  return result;
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
  /** The node whose coordinator reads; the app's command scope when omitted. */
  scope?: NodeScope;
}): UsageView<T> {
  const { key, active, intervalMs, read, isSample, scope } = options;
  const coordinator = scope ? readCoordinatorFor(scope) : getReadCoordinator();
  const { state } = useCoordinatedRead<T>({
    key,
    coordinator,
    enabled: active,
    demand: { active, intervalMs, priority: "auxiliary" },
    read: async ({ connectionGeneration }) => {
      // A request to a previous server says nothing about the current one.
      const id = `${readKeyId(key)}@${connectionGeneration}`;
      const sample = await readWithTimeout(coordinator, id, read);
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
    failed: state !== null && (state.failures > 0 || state.status === "unsupported"),
  };
}

/**
 * Host CPU/RAM/GPU/disk sample shared by every mounted meter. With `scope`
 * (another node's workspace in the window's tree, plan item 4001) the sample
 * is that node's, read on its own scope; the app's command scope keeps the
 * `@/lib/backend` read suites spy on.
 */
export function useSystemUsage({
  intervalMs,
  active = true,
  scope,
}: {
  intervalMs: number;
  active?: boolean;
  scope?: NodeScope;
}): UsageView<SystemUsageSnapshot> {
  const nodeBackend = useScopeBackend();
  const own = !scope || isAppCommandScope(scope);
  return useUsageRead({
    key: SYSTEM_USAGE_READ_KEY,
    active,
    intervalMs,
    read: own
      ? nodeBackend.getSystemUsage
      : () =>
          asSystemModel<SystemUsageSnapshot>(
            systemApi(scopeBackendClient(scope)).get_system_usage(NO_ARGS),
          ),
    isSample: isSystemUsageSnapshot,
    ...(own ? {} : { scope }),
  });
}

/**
 * One machine's host sample, for a view of several machines. The machine this
 * window is on shares the title-bar meters' read, so both show the same figure.
 * A machine passed with its node scope (one shown in the window's own tree,
 * plan items 4001 and 5002) is read on that scope, the same read its
 * title-bar meters and popovers join (`useSystemUsage({ scope })`). Pass a
 * scope only while it is live: a hidden scope's reads pause, so its figure
 * would go stale. Every other machine has a read of its own through the
 * command node, so a slow or unreachable machine holds up nothing but its own
 * figure.
 */
export function useMachineSystemUsage({
  nodeId,
  bound,
  intervalMs,
  active = true,
  scope,
}: {
  nodeId: BackendId;
  bound: boolean;
  intervalMs: number;
  active?: boolean;
  /** `nodeId`'s scope in this window, only while it is shown (tier `live`). */
  scope?: NodeScope | null;
}): UsageView<SystemUsageSnapshot> {
  const nodeBackend = useScopeBackend();
  const onScope = !bound && scope && !isAppCommandScope(scope) ? scope : null;
  return useUsageRead({
    key:
      bound || onScope
        ? SYSTEM_USAGE_READ_KEY
        : { ...SYSTEM_USAGE_READ_KEY, target: `node:${nodeId}` },
    active,
    intervalMs,
    read: bound
      ? nodeBackend.getSystemUsage
      : onScope
        ? () =>
            asSystemModel<SystemUsageSnapshot>(
              systemApi(scopeBackendClient(onScope)).get_system_usage(NO_ARGS),
            )
        : () =>
            asSystemModel<SystemUsageSnapshot>(
              systemApi(routedClient(nodeId)).get_system_usage(NO_ARGS),
            ),
    isSample: isSystemUsageSnapshot,
    ...(onScope ? { scope: onScope } : {}),
  });
}

/**
 * `nodeId` through the command node (`invoke_on_node`), as the `system`
 * domain's client: today's call, `invokeOnNode(nodeId, command)` for a read
 * without arguments.
 */
function routedClient(nodeId: BackendId) {
  return backendClientOver(<T>(command: string, args?: Record<string, unknown>) =>
    args === undefined
      ? portalStore.invokeOnNode<T>(nodeId, command)
      : portalStore.invokeOnNode<T>(nodeId, command, args),
  );
}

/**
 * Per-environment process list; only read while a panel shows it. With
 * `scope` (another node shown in the window's tree) the list is that node's.
 */
export function useEnvironmentProcessUsage({
  intervalMs,
  active = true,
  scope,
}: {
  intervalMs: number;
  active?: boolean;
  scope?: NodeScope;
}): UsageView<EnvironmentProcessUsageSnapshot> {
  const nodeBackend = useScopeBackend();
  const own = !scope || isAppCommandScope(scope);
  return useUsageRead({
    key: ENVIRONMENT_PROCESS_USAGE_READ_KEY,
    active,
    intervalMs,
    read: own
      ? nodeBackend.getEnvironmentProcessUsage
      : () =>
          asSystemModel<EnvironmentProcessUsageSnapshot>(
            systemApi(scopeBackendClient(scope)).get_environment_process_usage(NO_ARGS),
          ),
    isSample: isProcessUsageSnapshot,
    ...(own ? {} : { scope }),
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
