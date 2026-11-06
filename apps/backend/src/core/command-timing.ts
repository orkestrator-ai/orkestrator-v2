import type { EventLoopStallContext } from "@orkestrator/protocol/event-loop-stall-monitor";
import { createLogger } from "@orkestrator/protocol/logger";

/**
 * Durations of registered backend commands, for evidence when the backend is
 * slow: a `backend` `command.slow` line for a command that took long, and the
 * commands in flight for the event-loop stall line. Every caller reaches a
 * command through the registry (`commands-registry.ts`), whether it arrived
 * over the gateway's `/__orkestrator/invoke` (the renderer, a node link, the
 * CLI), the control MCP or another command, so one wrapper covers them all.
 *
 * Content-free: a command's registered name, never its arguments or result.
 * Cost per call: two `performance.now()` reads, one map insert and delete, and
 * a `.then` on an asynchronous result.
 */
const log = createLogger("backend");

/** A command this long, start to settle, is logged. */
export const SLOW_COMMAND_MS = 2_000;
/** A command whose synchronous part ran this long blocked the event loop, and warns. */
export const SLOW_COMMAND_SYNC_MS = 250;
/** Minimum spacing of `command.slow` lines per command; the rest are folded in. */
export const SLOW_COMMAND_LOG_INTERVAL_MS = 60_000;
/** In-flight commands tracked by name; more are only counted. */
export const MAX_TRACKED_IN_FLIGHT_COMMANDS = 256;
/** Commands kept per name for log spacing; past it, a new name logs unspaced. */
const MAX_SPACED_COMMANDS = 512;
const RECENT_BLOCKING_COMMANDS = 16;
/** Names in a stall line. */
const STALL_COMMAND_NAMES = 3;

interface Spacing {
  lastLoggedAtMs: number;
  folded: number;
  foldedMaxMs: number;
}

interface BlockingCommand {
  name: string;
  startedAtMs: number;
  syncMs: number;
}

export class CommandTimings {
  private readonly inFlight = new Map<number, { name: string; startedAtMs: number }>();
  private untracked = 0;
  private nextId = 0;
  private readonly spacing = new Map<string, Spacing>();
  private readonly blocking: BlockingCommand[] = [];

  constructor(
    private readonly options: {
      slowMs?: number;
      slowSyncMs?: number;
      logIntervalMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : performance.now();
  }

  /** Runs `run` as command `name`, timing it to settle. Preserves a synchronous result. */
  time<T>(name: string, run: () => T): T {
    const startedAtMs = this.now();
    let id = -1;
    if (this.inFlight.size < MAX_TRACKED_IN_FLIGHT_COMMANDS) {
      id = this.nextId++;
      this.inFlight.set(id, { name, startedAtMs });
    } else {
      this.untracked += 1;
    }
    let result: T;
    try {
      result = run();
    } catch (error) {
      const syncMs = this.now() - startedAtMs;
      this.recordBlocking(name, startedAtMs, syncMs);
      this.finish(id, name, startedAtMs, syncMs, syncMs, "failed");
      throw error;
    }
    const syncMs = this.now() - startedAtMs;
    this.recordBlocking(name, startedAtMs, syncMs);
    if (!isThenable(result)) {
      this.finish(id, name, startedAtMs, syncMs, syncMs, "ok");
      return result;
    }
    // A new chain, not a handler on the original, so a rejection nobody
    // awaits still reaches the fatal rejection guard.
    return result.then(
      (value) => {
        this.finish(id, name, startedAtMs, syncMs, this.now() - startedAtMs, "ok");
        return value;
      },
      (error: unknown) => {
        this.finish(id, name, startedAtMs, syncMs, this.now() - startedAtMs, "failed");
        throw error;
      },
    ) as T;
  }

  private recordBlocking(name: string, startedAtMs: number, syncMs: number): void {
    if (syncMs < (this.options.slowSyncMs ?? SLOW_COMMAND_SYNC_MS)) return;
    // The overdue stall timer runs before an asynchronous command may settle.
    this.blocking.push({ name, startedAtMs, syncMs });
    if (this.blocking.length > RECENT_BLOCKING_COMMANDS) this.blocking.shift();
  }

  private finish(
    id: number,
    name: string,
    startedAtMs: number,
    syncMs: number,
    durationMs: number,
    outcome: "ok" | "failed",
  ): void {
    if (id === -1) this.untracked -= 1;
    else this.inFlight.delete(id);
    const blocked = syncMs >= (this.options.slowSyncMs ?? SLOW_COMMAND_SYNC_MS);
    if (!blocked && durationMs < (this.options.slowMs ?? SLOW_COMMAND_MS)) return;
    const endedAtMs = startedAtMs + durationMs;
    let spacing = this.spacing.get(name);
    if (!spacing && this.spacing.size < MAX_SPACED_COMMANDS) {
      spacing = { lastLoggedAtMs: -Infinity, folded: 0, foldedMaxMs: 0 };
      this.spacing.set(name, spacing);
    }
    const roundedMs = Math.round(durationMs);
    if (
      spacing &&
      endedAtMs - spacing.lastLoggedAtMs <
        (this.options.logIntervalMs ?? SLOW_COMMAND_LOG_INTERVAL_MS)
    ) {
      spacing.folded += 1;
      spacing.foldedMaxMs = Math.max(spacing.foldedMaxMs, roundedMs);
      return;
    }
    const folded = spacing?.folded ?? 0;
    const foldedMaxMs = spacing?.foldedMaxMs ?? 0;
    if (spacing) {
      spacing.lastLoggedAtMs = endedAtMs;
      spacing.folded = 0;
      spacing.foldedMaxMs = 0;
    }
    log[blocked ? "warn" : "info"]("command.slow", {
      command: name,
      durationMs: roundedMs,
      syncMs: Math.round(syncMs),
      outcome,
      folded: folded > 0 ? folded : undefined,
      foldedMaxMs: folded > 0 ? foldedMaxMs : undefined,
    });
  }

  /**
   * For the stall line: the command whose synchronous part overlapped the
   * window longest, and how many commands were in flight, with the names of
   * the most recently started.
   */
  stallContext({ fromMs, toMs }: { fromMs: number; toMs: number }): EventLoopStallContext {
    let blocking: BlockingCommand | null = null;
    for (const entry of this.blocking) {
      if (entry.startedAtMs + entry.syncMs < fromMs || entry.startedAtMs > toMs) continue;
      if (!blocking || entry.syncMs > blocking.syncMs) blocking = entry;
    }
    const names: string[] = [];
    const entries = Array.from(this.inFlight.values());
    for (
      let index = entries.length - 1;
      index >= 0 && names.length < STALL_COMMAND_NAMES;
      index--
    ) {
      const { name, startedAtMs } = entries[index]!;
      if (startedAtMs <= toMs && !names.includes(name)) names.push(name);
    }
    return {
      commandsInFlight: this.inFlight.size + this.untracked,
      commands: names.length > 0 ? names.join(",") : undefined,
      blockingCommand: blocking?.name,
      blockingCommandMs: blocking ? Math.round(blocking.syncMs) : undefined,
    };
  }

  inFlightCount(): number {
    return this.inFlight.size + this.untracked;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** The process-wide timings the command registry reports into. */
export const commandTimings = new CommandTimings();
