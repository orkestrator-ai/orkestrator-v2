/**
 * Detects and records event-loop stalls of this process.
 *
 * Everything the backend serves — the renderer gateway, bridge streams, agent
 * MCP (`/mcp`), mail — shares one event loop, so a stall shows up as timeouts
 * everywhere at once and leaves no trace of its own. The desktop main process
 * runs it too: there, a late timer means Chromium's main thread was held. This
 * samples timer
 * lateness: a chained timer due every `intervalMs` that fires late by at least
 * `thresholdMs` is a stall, logged with its length so an incident can be
 * dated from the log afterwards. A setTimeout chain, not
 * `perf_hooks.monitorEventLoopDelay`: Bun's histogram does not see a blocking
 * synchronous call (see `scripts/efficiency/resources.ts`). A host that sleeps
 * also delays the timer and is reported the same way.
 *
 * Cost: one timer callback every `intervalMs` and a few arithmetic updates.
 * Log lines are rate-limited; stalls between lines are folded into the next.
 */
import { createLogger, type LogLevel } from "./logger.js";

const log = createLogger("event-loop");

export const EVENT_LOOP_SAMPLE_INTERVAL_MS = 500;
export const EVENT_LOOP_STALL_THRESHOLD_MS = 1_000;
/** Minimum spacing of stall log lines; a stall at least `alwaysLogMs` long is always logged. */
export const EVENT_LOOP_STALL_LOG_INTERVAL_MS = 30_000;
export const EVENT_LOOP_STALL_ALWAYS_LOG_MS = 10_000;
/** Recent stalls kept for diagnostics. */
export const EVENT_LOOP_RECENT_STALLS = 20;

/** Lateness buckets (ms, lower bounds) counted over the process lifetime. */
const LAG_BUCKETS_MS = [100, 1_000, 5_000, 30_000] as const;

export interface EventLoopStall {
  /** Wall-clock time the late tick fired. */
  at: string;
  lagMs: number;
}

export interface EventLoopSnapshot {
  intervalMs: number;
  thresholdMs: number;
  ticks: number;
  maxLagMs: number;
  /** Ticks at least this late, keyed by the bucket's lower bound in ms. */
  lateTicks: Record<string, number>;
  stalls: number;
  recentStalls: EventLoopStall[];
}

export interface EventLoopStallMonitorOptions {
  intervalMs?: number;
  thresholdMs?: number;
  logIntervalMs?: number;
  alwaysLogMs?: number;
  /** Takes each stall instead of the `event-loop` logger, for a process's own area. */
  report?: (stall: EventLoopStallReport) => void;
  /** Monotonic milliseconds. */
  now?: () => number;
  wallClock?: () => number;
  setTimer?: (callback: () => void, ms: number) => { unref?: () => unknown };
  clearTimer?: (timer: { unref?: () => unknown }) => void;
}

export interface EventLoopStallReport {
  lagMs: number;
  /** Wall-clock end of the stall, as an ISO string. */
  endedAt: string;
  intervalMs: number;
  /** "" or a suffix naming suppressed stalls. */
  folded: string;
  /**
   * `error` for a stall of at least `alwaysLogMs`, because no configured level
   * can filter `error`: such a stall is written whatever the threshold.
   */
  level: Extract<LogLevel, "warn" | "error">;
}

export interface EventLoopStallMonitor {
  snapshot(): EventLoopSnapshot;
  stop(): void;
}

let running: EventLoopStallMonitor | null = null;

/** The running monitor's snapshot, for diagnostics; null when none runs. */
export function eventLoopDiagnostics(): EventLoopSnapshot | null {
  return running?.snapshot() ?? null;
}

function reportStall({ lagMs, endedAt, intervalMs, folded, level }: EventLoopStallReport): void {
  log[level]("stalled", {
    lagMs,
    endedAt,
    intervalMs,
    folded: folded.replace(/^; /, "") || undefined,
  });
}

export function startEventLoopStallMonitor(
  options: EventLoopStallMonitorOptions = {},
): EventLoopStallMonitor {
  const intervalMs = options.intervalMs ?? EVENT_LOOP_SAMPLE_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? EVENT_LOOP_STALL_THRESHOLD_MS;
  const logIntervalMs = options.logIntervalMs ?? EVENT_LOOP_STALL_LOG_INTERVAL_MS;
  const alwaysLogMs = options.alwaysLogMs ?? EVENT_LOOP_STALL_ALWAYS_LOG_MS;
  const report = options.report ?? reportStall;
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? Date.now;
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer: { unref?: () => unknown }) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let ticks = 0;
  let maxLagMs = 0;
  let stalls = 0;
  const lateTicks = LAG_BUCKETS_MS.map(() => 0);
  const recent: EventLoopStall[] = [];
  let lastLogAt = -Infinity;
  let suppressed = 0;
  let suppressedMaxMs = 0;
  let stopped = false;
  let expected = now() + intervalMs;
  let timer: { unref?: () => unknown } | null = null;

  const record = (lagMs: number) => {
    ticks += 1;
    maxLagMs = Math.max(maxLagMs, lagMs);
    LAG_BUCKETS_MS.forEach((bound, index) => {
      if (lagMs >= bound) lateTicks[index]! += 1;
    });
    if (lagMs < thresholdMs) return;
    stalls += 1;
    const at = wallClock();
    recent.push({ at: new Date(at).toISOString(), lagMs });
    if (recent.length > EVENT_LOOP_RECENT_STALLS) recent.shift();
    const monotonic = now();
    if (lagMs < alwaysLogMs && monotonic - lastLogAt < logIntervalMs) {
      suppressed += 1;
      suppressedMaxMs = Math.max(suppressedMaxMs, lagMs);
      return;
    }
    lastLogAt = monotonic;
    const folded =
      suppressed > 0
        ? `; ${suppressed} shorter stall(s) since the last report, longest ${suppressedMaxMs} ms`
        : "";
    suppressed = 0;
    suppressedMaxMs = 0;
    report({
      lagMs,
      endedAt: new Date(at).toISOString(),
      intervalMs,
      folded,
      level: lagMs >= alwaysLogMs ? "error" : "warn",
    });
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimer(tick, intervalMs);
    timer.unref?.();
  };
  const tick = () => {
    if (stopped) return;
    const at = now();
    record(Math.max(0, Math.round(at - expected)));
    expected = at + intervalMs;
    schedule();
  };
  schedule();

  const monitor: EventLoopStallMonitor = {
    snapshot: () => ({
      intervalMs,
      thresholdMs,
      ticks,
      maxLagMs,
      lateTicks: Object.fromEntries(
        LAG_BUCKETS_MS.map((bound, index) => [String(bound), lateTicks[index]!]),
      ),
      stalls,
      recentStalls: recent.map((stall) => ({ ...stall })),
    }),
    stop: () => {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      if (running === monitor) running = null;
    },
  };
  running = monitor;
  return monitor;
}
