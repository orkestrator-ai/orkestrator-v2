// A Claude CLI kept warm between turns.
//
// A turn that leaves nothing owed no longer closes its CLI's input. The
// process stays open, so the next prompt is written into it rather than
// paying a cold spawn, and composer changes reach it through
// `applyClaudeLiveSettings`. The runtime releases itself once it has been
// idle for the detach window: no foreground turn, no work it owns, nothing
// waiting on the user, and no frame for the whole window. That is the same
// silence rule the per-turn continuation watchdog used, now owned by the
// process it bounds.
//
// No route touch extends the window. The backend polls `GET /session/:id`
// for an open tab and `/session/:id/activity` for every session, so a window
// that reads counted as use would never let an open tab's CLI go.

import type { SessionState } from "../types/index.js";
import { debugLog } from "./logger.js";
import { claudeRuntimeOwnsLiveWork } from "./session-manager-background-tasks.js";
import { sessions } from "./session-manager-core.js";
import { sessionHasPendingInteractions } from "./session-manager-lifecycle.js";
import {
  type ClaudeRuntime,
  drainClaudeRuntime,
  openClaudeRuntime,
} from "./session-manager-runtime.js";

/** How long an idle CLI stays open for the next prompt. */
export const DEFAULT_CLAUDE_RUNTIME_IDLE_MS = 10 * 60 * 1000;

/**
 * The shortest silence that releases a CLI still owing the continuation a
 * background-task notification triggers.
 *
 * Generous on purpose: cutting a legitimate continuation short is the
 * corruption this wait exists to avoid. Only matters when the idle window is
 * configured below it.
 */
export const CONTINUATION_SILENCE_MS = 5 * 60 * 1000;

/**
 * Idle CLIs one bridge keeps warm at once. Each is a whole Claude Code process
 * (about 300 MB resident at the current pin); past the cap the one idle
 * longest is released first.
 */
export const DEFAULT_MAX_IDLE_CLAUDE_RUNTIMES = 3;

/**
 * The shortest wait before a runtime that was not idle when its window ran out
 * is looked at again; the window itself when that is longer. Only a fallback:
 * a turn ending normally re-arms the window directly.
 */
const BUSY_RECHECK_MS = 30_000;

export const CLAUDE_RUNTIME_IDLE_MS_ENV = "CLAUDE_BRIDGE_RUNTIME_IDLE_MS";
export const CLAUDE_MAX_IDLE_RUNTIMES_ENV = "CLAUDE_BRIDGE_MAX_IDLE_RUNTIMES";

/** A scheduled idle check; `cancel` is idempotent. */
export interface ClaudeRuntimeIdleTimer {
  cancel(): void;
}

type IdleTiming = {
  idleMs: number;
  continuationSilenceMs: number;
  maxIdle: number;
  /** Replaces `setTimeout`, so a test fires the window instead of waiting it out. */
  schedule: (fire: () => void, delayMs: number) => ClaudeRuntimeIdleTimer;
};
let timingForTesting: Partial<IdleTiming> | undefined;

function scheduleIdleCheck(fire: () => void, delayMs: number): ClaudeRuntimeIdleTimer {
  if (timingForTesting?.schedule) return timingForTesting.schedule(fire, delayMs);
  const timer = setTimeout(fire, delayMs);
  // Never holds an exiting bridge open.
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

/** Override the idle timing and scheduler; tests only. Pass nothing to restore them. */
export function setClaudeRuntimeIdleTimingForTesting(timing?: Partial<IdleTiming>): void {
  timingForTesting = timing;
}

function nonNegativeIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** The idle window. Zero restores the old lifetime: input closes at turn end. */
export function claudeRuntimeIdleMs(): number {
  return (
    timingForTesting?.idleMs ??
    nonNegativeIntegerFromEnv(CLAUDE_RUNTIME_IDLE_MS_ENV, DEFAULT_CLAUDE_RUNTIME_IDLE_MS)
  );
}

function maxIdleClaudeRuntimes(): number {
  return (
    timingForTesting?.maxIdle ??
    nonNegativeIntegerFromEnv(CLAUDE_MAX_IDLE_RUNTIMES_ENV, DEFAULT_MAX_IDLE_CLAUDE_RUNTIMES)
  );
}

/**
 * Whether the runtime can be released once its window has passed: it is the
 * session's open CLI, no turn holds or is claiming the foreground, it owns no
 * live task, and nothing waits on the user.
 *
 * An owed continuation does not make it busy, only lengthens the window
 * (`CONTINUATION_SILENCE_MS`): a CLI that answers a task notification with
 * nothing at all must still be released.
 */
export function claudeRuntimeIsIdle(runtime: ClaudeRuntime): boolean {
  const { session } = runtime;
  if (openClaudeRuntime(session) !== runtime) return false;
  // A prompt claims `abortController` at admission, before it joins.
  if (session.status === "running" || session.abortController) return false;
  // A rewind runs on the live CLI's control channel.
  if (session.rewindInProgress || session.deleting) return false;
  if (claudeRuntimeOwnsLiveWork(runtime)) return false;
  return !sessionHasPendingInteractions(session.id);
}

export function disarmClaudeRuntimeIdleDetach(runtime: ClaudeRuntime | undefined): void {
  runtime?.idleTimer?.cancel();
  if (runtime) runtime.idleTimer = undefined;
}

/** Release `runtime`'s CLI: input closes, and it exits once it has nothing left. */
function detachClaudeRuntime(runtime: ClaudeRuntime, reason: "idle" | "capacity"): void {
  disarmClaudeRuntimeIdleDetach(runtime);
  debugLog("[session-manager] Releasing idle Claude runtime", {
    sessionId: runtime.session.id,
    reason,
    idleMs: Date.now() - runtime.lastFrameAt,
  });
  drainClaudeRuntime(runtime);
}

/**
 * Start, or restart, the runtime's idle window.
 *
 * Called when a turn hands the foreground back, and again for every frame the
 * runtime receives while the window runs: the window measures silence, so a
 * continuation that is slow but still talking is never cut off.
 */
export function armClaudeRuntimeIdleDetach(
  runtime: ClaudeRuntime | undefined,
  minimumMs = 0,
): void {
  if (!runtime) return;
  disarmClaudeRuntimeIdleDetach(runtime);
  if (runtime.state !== "open") return;
  const idleMs = claudeRuntimeIdleMs();
  const windowMs = runtime.latestTurn.isAwaitingContinuation()
    ? Math.max(idleMs, timingForTesting?.continuationSilenceMs ?? CONTINUATION_SILENCE_MS)
    : idleMs;
  runtime.idleTimer = scheduleIdleCheck(
    () => {
      runtime.idleTimer = undefined;
      if (runtime.state !== "open") return;
      if (claudeRuntimeIsIdle(runtime)) {
        detachClaudeRuntime(runtime, "idle");
        return;
      }
      // Looked at again later, whatever keeps it busy: a turn that holds the
      // foreground normally re-arms the window when it hands it back, but one
      // that fails before its prompt is written never had the window disarmed.
      armClaudeRuntimeIdleDetach(runtime, BUSY_RECHECK_MS);
    },
    Math.max(windowMs, minimumMs),
  );
}

/**
 * A frame arrived: the CLI is not silent, so an armed window starts over.
 * Not while a turn holds the foreground, which is busy anyway: restarting a
 * timer for every streamed token would buy nothing.
 */
export function noteClaudeRuntimeFrame(runtime: ClaudeRuntime): void {
  runtime.lastFrameAt = Date.now();
  const { session } = runtime;
  if (!runtime.idleTimer || session.status === "running" || session.abortController) return;
  armClaudeRuntimeIdleDetach(runtime);
}

/**
 * The turn on `runtime` handed the foreground back with nothing owed. Keep the
 * CLI warm for the next prompt, within the window and the bridge-wide cap.
 */
export function idleClaudeRuntime(runtime: ClaudeRuntime): void {
  if (claudeRuntimeIdleMs() === 0 || maxIdleClaudeRuntimes() === 0) {
    drainClaudeRuntime(runtime);
    return;
  }
  armClaudeRuntimeIdleDetach(runtime);
  releaseIdleClaudeRuntimesOverCap();
}

/** Recheck capacity after foreground settlement or a failed admission restores it. */
export function reconcileIdleClaudeRuntime(session: SessionState): void {
  const runtime = openClaudeRuntime(session);
  if (runtime && claudeRuntimeIsIdle(runtime) && !runtime.latestTurn.isAwaitingContinuation()) {
    // Settlement is not a new SDK frame: preserve the silence deadline that
    // the result (or the failed join's previous turn) already armed.
    releaseIdleClaudeRuntimesOverCap();
  }
}

/**
 * Release the CLIs idle longest until at most the cap stay warm. Only count
 * settled foregrounds; settlement rechecks this after clearing ownership.
 */
function releaseIdleClaudeRuntimesOverCap(): void {
  const idle: ClaudeRuntime[] = [];
  for (const session of sessions.values()) {
    const runtime = openClaudeRuntime(session);
    if (runtime && claudeRuntimeIsIdle(runtime) && !runtime.latestTurn.isAwaitingContinuation()) {
      idle.push(runtime);
    }
  }
  const excess = idle.length - maxIdleClaudeRuntimes();
  if (excess <= 0) return;
  idle.sort((left, right) => left.lastFrameAt - right.lastFrameAt);
  for (const runtime of idle.slice(0, excess)) detachClaudeRuntime(runtime, "capacity");
}
