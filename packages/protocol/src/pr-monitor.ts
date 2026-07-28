/**
 * Backend-owned pull-request monitoring.
 *
 * PR polling used to live in each renderer and only ever watched the active
 * environment: switch tabs and the previous environment's merge went unnoticed
 * until it was selected again, and closing the last window stopped the work
 * entirely. A pull request is a fact about an environment's branch, not about a
 * window, so the backend owns the polling loop now and announces what it finds
 * here.
 *
 * Like `diff-stats`, the payload carries the state rather than only an
 * identifier: the state is a handful of scalars and it is the entire reason a
 * client subscribes. The persisted PR fields on the environment record still
 * flow through the ordinary `environment` resource-changed channel; this event
 * additionally carries the *monitoring* state (mode, errors) and the transition
 * that just happened, which no persisted record captures.
 */

/** SSE/IPC event name carrying a {@link PrMonitorEvent}. */
export const PR_MONITOR_CHANGED_EVENT = "pr-monitor-changed";

/**
 * Mirror of the backend and frontend `PrState`. Declared here so the wire
 * contract cannot drift from either side without a type error at the boundary.
 */
export type PrState = "open" | "merged" | "closed";

/**
 * Polling cadence for one monitored environment.
 * - normal: an open PR being tracked for merge/close
 * - create-pending: a PR creation was just requested; poll fast until it exists
 * - merge-pending: a merge was just requested; poll fastest until it lands
 */
export type PrMonitorMode = "normal" | "create-pending" | "merge-pending";

export const PR_MONITOR_MODES: readonly PrMonitorMode[] = [
  "normal",
  "create-pending",
  "merge-pending",
];

/** Base polling interval for each mode, before error backoff. */
export const PR_MONITOR_INTERVALS_MS: Record<PrMonitorMode, number> = {
  normal: 20_000,
  "create-pending": 5_000,
  "merge-pending": 1_000,
};

/**
 * How long a pending mode may run before reverting.
 *
 * merge-pending matches the renderer implementation this replaced. The
 * create-pending timeout is new: the renderer demoted create-pending when the
 * environment lost focus, but the backend has no focus, so an agent that never
 * opens a PR would otherwise be polled at the fast cadence forever.
 */
export const PR_MONITOR_MODE_TIMEOUTS_MS: Partial<Record<PrMonitorMode, number>> = {
  "merge-pending": 20_000,
  "create-pending": 10 * 60_000,
};

/** Exponential backoff configuration for consecutive detection errors. */
export const PR_MONITOR_BACKOFF = {
  /** Errors beyond this no longer grow the interval. */
  maxErrors: 5,
  /** Ceiling for the backed-off interval (5 minutes). */
  maxIntervalMs: 300_000,
} as const;

/**
 * Effective polling interval: baseInterval * 2^min(errors, maxErrors), capped.
 * Identical to the formula the renderer used, so the observable cadence of the
 * migration is unchanged.
 */
export function getEffectivePrMonitorInterval(
  mode: PrMonitorMode,
  consecutiveErrors: number,
): number {
  const base = PR_MONITOR_INTERVALS_MS[mode];
  if (consecutiveErrors <= 0) return base;
  const capped = Math.min(consecutiveErrors, PR_MONITOR_BACKOFF.maxErrors);
  return Math.min(base * 2 ** capped, PR_MONITOR_BACKOFF.maxIntervalMs);
}

/** Monitoring state for one environment, as owned by the backend service. */
export interface PrMonitorEnvironmentState {
  environmentId: string;
  mode: PrMonitorMode;
  /** True while a detection is running right now. */
  checkInProgress: boolean;
  consecutiveErrors: number;
  /** ISO timestamp of the last completed check, or null before the first. */
  lastCheckAt: string | null;
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
}

/**
 * A confirmed change of the PR itself, distinct from monitoring bookkeeping.
 * Emitted exactly once per observed change so clients can notify without
 * diffing snapshots.
 */
export interface PrMonitorTransition {
  url: string;
  state: PrState;
  previousState: PrState | null;
}

export interface PrMonitorStateEvent {
  environmentId: string;
  state: PrMonitorEnvironmentState;
  transition?: PrMonitorTransition;
}

/** Emitted when an environment stops being monitored. */
export interface PrMonitorRemovalEvent {
  environmentId: string;
  removed: true;
}

export type PrMonitorEvent = PrMonitorStateEvent | PrMonitorRemovalEvent;

/** Full snapshot returned by the `get_pr_monitor_state` command. */
export interface PrMonitorSnapshot {
  entries: PrMonitorEnvironmentState[];
}

const PR_STATES: ReadonlySet<string> = new Set(["open", "merged", "closed"]);
const MODE_SET: ReadonlySet<string> = new Set(PR_MONITOR_MODES);

export function isPrMonitorMode(value: unknown): value is PrMonitorMode {
  return typeof value === "string" && MODE_SET.has(value);
}

function isPrStateOrNull(value: unknown): value is PrState | null {
  return value === null || (typeof value === "string" && PR_STATES.has(value));
}

export function isPrMonitorEnvironmentState(
  value: unknown,
): value is PrMonitorEnvironmentState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.environmentId === "string"
    && candidate.environmentId.length > 0
    && isPrMonitorMode(candidate.mode)
    && typeof candidate.checkInProgress === "boolean"
    && Number.isSafeInteger(candidate.consecutiveErrors)
    && (candidate.consecutiveErrors as number) >= 0
    && (candidate.lastCheckAt === null || typeof candidate.lastCheckAt === "string")
    && (candidate.prUrl === null || typeof candidate.prUrl === "string")
    && isPrStateOrNull(candidate.prState)
    && (candidate.hasMergeConflicts === null || typeof candidate.hasMergeConflicts === "boolean");
}

export function isPrMonitorTransition(value: unknown): value is PrMonitorTransition {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.url === "string"
    && candidate.url.length > 0
    && typeof candidate.state === "string"
    && PR_STATES.has(candidate.state)
    && isPrStateOrNull(candidate.previousState);
}

export function isPrMonitorEvent(value: unknown): value is PrMonitorEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.environmentId !== "string" || candidate.environmentId.length === 0) {
    return false;
  }
  if (candidate.removed === true) return true;
  if (!isPrMonitorEnvironmentState(candidate.state)) return false;
  if (candidate.state.environmentId !== candidate.environmentId) return false;
  return candidate.transition === undefined || isPrMonitorTransition(candidate.transition);
}

export function isPrMonitorSnapshot(value: unknown): value is PrMonitorSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const entries = (value as Record<string, unknown>).entries;
  return Array.isArray(entries) && entries.every(isPrMonitorEnvironmentState);
}
