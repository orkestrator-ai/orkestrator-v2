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
 * synchronous call (see `scripts/efficiency/resources.ts`).
 *
 * A host that sleeps also delays the timer when the monotonic clock counts
 * sleep (macOS's does). With a `hostCpuTimes` reader the monitor takes that
 * sleep out: the host's CPU time counters stop while it sleeps, so the part of
 * a late tick no CPU was awake for is a suspension, not a stall. It is written
 * as `host-suspended` (info, essential) and kept out of `stalls`, `maxLagMs`
 * and `lateTicks`; a stall that remains once the sleep is taken out is still
 * reported, with `hostSuspendedMs` saying how much was removed.
 *
 * Cost: one timer callback every `intervalMs` and a few arithmetic updates.
 * Log lines are rate-limited; stalls between lines are folded into the next.
 *
 * A stall line names what ran during it when a process registers a context
 * source ({@link addEventLoopStallContext}): the backend names its slowest
 * SQLite call, the commands in flight and the recurring jobs that ran. Sources
 * run only for a stall that is reported, never on an ordinary tick.
 *
 * With a `cpuUsage` reader the line also says how much CPU the process used
 * during the stall (`cpuMs`). Close to `lagMs` means this process was busy on
 * its own thread (JavaScript, a synchronous call that computes); far below it
 * means the thread waited (a synchronous call blocked on disk or a lock, or the
 * host did not schedule the process). The reader is one `getrusage` per tick.
 */
import { createLogger, type LogLevel, type LogScalar } from "./logger.js";

const log = createLogger("event-loop");

export const EVENT_LOOP_SAMPLE_INTERVAL_MS = 500;
export const EVENT_LOOP_STALL_THRESHOLD_MS = 1_000;
/** Minimum spacing of stall log lines; a stall at least `alwaysLogMs` long is always logged. */
export const EVENT_LOOP_STALL_LOG_INTERVAL_MS = 30_000;
export const EVENT_LOOP_STALL_ALWAYS_LOG_MS = 10_000;
/** Recent stalls kept for diagnostics. */
export const EVENT_LOOP_RECENT_STALLS = 20;
/** How often the host's CPU times are read while ticks are on time. */
export const EVENT_LOOP_HOST_SAMPLE_INTERVAL_MS = 5_000;

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
  /** Late ticks the host slept through (`hostCpuTimes`); not stalls. */
  suspensions: number;
  /** Longest of those sleeps, in ms. */
  maxSuspendedMs: number;
}

export interface EventLoopStallMonitorOptions {
  intervalMs?: number;
  thresholdMs?: number;
  logIntervalMs?: number;
  alwaysLogMs?: number;
  /** Takes each stall instead of the `event-loop` logger, for a process's own area. */
  report?: (stall: EventLoopStallReport) => void;
  /**
   * The process's CPU time so far, user and system, in microseconds
   * (`process.cpuUsage()` summed). Read once per tick; absent, no `cpuMs`.
   */
  cpuUsage?: () => number;
  /**
   * Milliseconds each host CPU has spent in any state (`readHostCpuTimes`).
   * They stop while the host sleeps; absent, a sleep is reported as a stall.
   */
  hostCpuTimes?: () => readonly number[] | null;
  /** Takes each host suspension instead of the `event-loop` logger. */
  reportSuspension?: (suspension: EventLoopSuspensionReport) => void;
  hostSampleIntervalMs?: number;
  /** Monotonic milliseconds. */
  now?: () => number;
  wallClock?: () => number;
  setTimer?: (callback: () => void, ms: number) => { unref?: () => unknown };
  clearTimer?: (timer: { unref?: () => unknown }) => void;
}

/** Content-free fields a context source adds to a stall line. */
export type EventLoopStallContext = Readonly<Record<string, LogScalar>>;

/**
 * Says what ran between `fromMs` and `toMs`, in `performance.now()`
 * milliseconds: the last on-time tick and the late one. Must be cheap, must
 * not throw (a throw is ignored) and must return content-free scalars only.
 */
export type EventLoopStallContextSource = (window: {
  fromMs: number;
  toMs: number;
}) => EventLoopStallContext | undefined;

const contextSources = new Set<EventLoopStallContextSource>();

/** Adds a source to every later stall line; returns its removal. */
export function addEventLoopStallContext(source: EventLoopStallContextSource): () => void {
  contextSources.add(source);
  return () => {
    contextSources.delete(source);
  };
}

function stallContext(fromMs: number, toMs: number): EventLoopStallContext | undefined {
  if (contextSources.size === 0) return undefined;
  let merged: Record<string, LogScalar> | undefined;
  for (const source of contextSources) {
    let fields: EventLoopStallContext | undefined;
    try {
      fields = source({ fromMs, toMs });
    } catch {
      continue;
    }
    if (fields) merged = { ...merged, ...fields };
  }
  return merged;
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
  /**
   * CPU time the process used between the last on-time tick and the late one,
   * all threads; absent without a `cpuUsage` reader.
   */
  cpuMs?: number;
  /** What the registered context sources say ran during the stall. */
  context?: EventLoopStallContext;
  /**
   * Time the host slept within this late tick, already taken out of `lagMs`;
   * absent when it did not sleep.
   */
  hostSuspendedMs?: number;
}

/** A late tick the host slept through: the process was not held, the machine was off. */
export interface EventLoopSuspensionReport {
  /** How long no host CPU was awake within the late tick. */
  suspendedMs: number;
  /** The tick's whole lateness, sleep included. */
  lagMs: number;
  /** Wall-clock end, as an ISO string. */
  endedAt: string;
  intervalMs: number;
  /** Suspensions not written since the last line (spaced like stall lines). */
  suppressed: number;
}

/**
 * How long the host slept between two readings of its CPU times: the monotonic
 * time that passed minus the longest any one CPU was counted awake. The
 * longest, not the average, so a CPU whose idle time is accounted late cannot
 * make an awake host look asleep. Null when the readings do not compare.
 */
export function hostSleptMs(
  before: readonly number[],
  after: readonly number[],
  elapsedMs: number,
): number | null {
  if (before.length === 0 || before.length !== after.length) return null;
  let awakeMs = -Infinity;
  for (let index = 0; index < after.length; index += 1) {
    awakeMs = Math.max(awakeMs, after[index]! - before[index]!);
  }
  if (!Number.isFinite(awakeMs)) return null;
  return Math.max(0, Math.round(elapsedMs - awakeMs));
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

function reportStall({
  lagMs,
  endedAt,
  intervalMs,
  folded,
  level,
  cpuMs,
  context,
  hostSuspendedMs,
}: EventLoopStallReport): void {
  log[level]("stalled", {
    lagMs,
    endedAt,
    intervalMs,
    cpuMs,
    hostSuspendedMs,
    folded: folded.replace(/^; /, "") || undefined,
    ...context,
  });
}

function reportSuspension({
  suspendedMs,
  lagMs,
  endedAt,
  intervalMs,
  suppressed,
}: EventLoopSuspensionReport): void {
  log.info("host-suspended", {
    suspendedMs,
    lagMs,
    endedAt,
    intervalMs,
    suppressed: suppressed || undefined,
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
  const cpuUsage = options.cpuUsage;
  const readCpu = (): number | null => {
    if (!cpuUsage) return null;
    try {
      const micros = cpuUsage();
      return Number.isFinite(micros) ? micros : null;
    } catch {
      return null;
    }
  };
  const hostCpuTimes = options.hostCpuTimes;
  const readHost = (): readonly number[] | null => {
    if (!hostCpuTimes) return null;
    try {
      const times = hostCpuTimes();
      return times && times.length > 0 && times.every(Number.isFinite) ? times : null;
    } catch {
      return null;
    }
  };
  const hostSampleIntervalMs = options.hostSampleIntervalMs ?? EVENT_LOOP_HOST_SAMPLE_INTERVAL_MS;
  const suspensionReport = options.reportSuspension ?? reportSuspension;
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
  let cpuAtLastTick = readCpu();
  let suspensions = 0;
  let maxSuspendedMs = 0;
  let lastSuspensionLogAt = -Infinity;
  let suspensionsSuppressed = 0;
  const firstHostTimes = readHost();
  let hostBaseline: { at: number; times: readonly number[] } | null = firstHostTimes
    ? { at: now(), times: firstHostTimes }
    : null;
  let timer: { unref?: () => unknown } | null = null;

  /**
   * How much of a late tick the host slept through. Reads the host's CPU times
   * every `hostSampleIntervalMs` and on every late tick, so the comparison
   * spans at most that much on-time running plus the late tick itself.
   */
  const suspendedWithin = (at: number, rawLagMs: number, cpuMs: number | undefined): number => {
    if (!hostCpuTimes) return 0;
    const late = rawLagMs >= thresholdMs;
    if (!late && hostBaseline && at - hostBaseline.at < hostSampleIntervalMs) return 0;
    const times = readHost();
    let sleptMs = 0;
    if (late && hostBaseline && times) {
      const slept = hostSleptMs(hostBaseline.times, times, at - hostBaseline.at);
      // A process that ran for most of the lateness was not on a sleeping host,
      // whatever the counters say.
      const ran = cpuMs !== undefined && cpuMs * 2 >= rawLagMs;
      if (slept !== null && slept >= thresholdMs && !ran) sleptMs = Math.min(rawLagMs, slept);
    }
    hostBaseline = times ? { at, times } : null;
    return sleptMs;
  };

  const noteSuspension = (suspendedMs: number, rawLagMs: number) => {
    suspensions += 1;
    maxSuspendedMs = Math.max(maxSuspendedMs, suspendedMs);
    const monotonic = now();
    // A night of short wakes is many suspensions; one line per log interval.
    if (monotonic - lastSuspensionLogAt < logIntervalMs) {
      suspensionsSuppressed += 1;
      return;
    }
    lastSuspensionLogAt = monotonic;
    const suppressedSince = suspensionsSuppressed;
    suspensionsSuppressed = 0;
    suspensionReport({
      suspendedMs,
      lagMs: rawLagMs,
      endedAt: new Date(wallClock()).toISOString(),
      intervalMs,
      suppressed: suppressedSince,
    });
  };

  const record = (
    lagMs: number,
    fromMs: number,
    toMs: number,
    cpuMs: number | undefined,
    hostSuspendedMs: number,
  ) => {
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
      ...(cpuMs === undefined ? {} : { cpuMs }),
      context: stallContext(fromMs, toMs),
      ...(hostSuspendedMs > 0 ? { hostSuspendedMs } : {}),
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
    const cpu = readCpu();
    const cpuMs =
      cpu !== null && cpuAtLastTick !== null
        ? Math.max(0, Math.round((cpu - cpuAtLastTick) / 1000))
        : undefined;
    cpuAtLastTick = cpu;
    const rawLagMs = Math.max(0, Math.round(at - expected));
    const suspendedMs = suspendedWithin(at, rawLagMs, cpuMs);
    if (suspendedMs > 0) noteSuspension(suspendedMs, rawLagMs);
    // Only the time the host was awake counts as lateness: a sleep held no one.
    record(rawLagMs - suspendedMs, expected - intervalMs, at, cpuMs, suspendedMs);
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
      suspensions,
      maxSuspendedMs,
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
