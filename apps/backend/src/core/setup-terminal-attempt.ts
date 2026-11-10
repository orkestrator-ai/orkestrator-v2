/**
 * One run of an environment's setup commands in its setup terminal.
 *
 * The setup command ends in `exec <shell> -l`, so the terminal stays open at a
 * prompt after the commands finish, and the result is read from OSC markers in
 * its output rather than from the process exiting.
 */
import {
  SETUP_DONE_OSC_SEQUENCE,
  SETUP_FAILED_OSC_SEQUENCE,
  SETUP_FAILURE_REASONS,
  setupFailureReasonOscSequence,
  type SetupFailureReason,
} from "./container-scripts.js";
import type { PtyProcess } from "./pty.js";
import type { TerminalRuntime } from "./terminal-runtime.js";

const REASON_MARKERS = SETUP_FAILURE_REASONS.map((reason) => ({
  reason,
  sequence: setupFailureReasonOscSequence(reason),
}));

export interface SetupCompletionTracker {
  completion: Promise<boolean>;
  /** The reason the setup script printed before it failed, if it named one. */
  failureReason: () => SetupFailureReason | undefined;
  onData: (data: string) => void;
  onExit: () => void;
}

export function createSetupCompletionTracker(): SetupCompletionTracker {
  let settled = false;
  let reason: SetupFailureReason | undefined;
  let resolveCompletion!: (success: boolean) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<boolean>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const finish = (success: boolean) => {
    if (settled) return;
    settled = true;
    resolveCompletion(success);
  };

  // PTY reads are not guaranteed to align to write boundaries, so a marker can
  // arrive split across two `onData` chunks. Keep a small rolling tail of the
  // previous chunk (one byte short of the longest marker) and prepend it
  // before matching so a split marker is still detected.
  const markerTailLength =
    Math.max(
      SETUP_DONE_OSC_SEQUENCE.length,
      SETUP_FAILED_OSC_SEQUENCE.length,
      ...REASON_MARKERS.map((marker) => marker.sequence.length),
    ) - 1;
  let pending = "";

  return {
    completion,
    failureReason: () => reason,
    onData: (data) => {
      const combined = `${pending}${data}`;
      // The script prints its reason before it exits, so the reason is read
      // first: both markers can arrive in the same chunk.
      if (!settled) {
        reason =
          REASON_MARKERS.find((marker) => combined.includes(marker.sequence))?.reason ?? reason;
      }
      if (combined.includes(SETUP_DONE_OSC_SEQUENCE)) {
        finish(true);
      } else if (combined.includes(SETUP_FAILED_OSC_SEQUENCE)) {
        finish(false);
      }
      pending = markerTailLength > 0 ? combined.slice(-markerTailLength) : "";
    },
    onExit: () => {
      if (settled) return;
      settled = true;
      rejectCompletion(new Error("Setup terminal exited before reporting completion"));
    },
  };
}

/**
 * Ends the terminal a previous setup run left open, so a new run gets its own.
 *
 * Only called once no setup run is in flight, so a terminal still registered
 * here belongs to a finished run: its commands are done and it is sitting at
 * the prompt `exec <shell> -l` left. Reusing it would run nothing, attach no
 * completion tracker and leave the new run waiting forever. Returns whether a
 * terminal was ended.
 */
export async function retireFinishedSetupTerminal(
  sessionId: string,
  terminals: Pick<TerminalRuntime, "process" | "cleanupSession">,
  options: { exitWaitMs?: number } = {},
): Promise<boolean> {
  const stale: PtyProcess | undefined = terminals.process(sessionId);
  if (!stale) return false;
  // Wait for the exit event as well as the process: the exit handlers
  // `spawnTerminalProcess` registered first (unregistering the PTY, completing
  // its history) must run before the new run configures this session again.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscription: { dispose: () => void } | undefined;
  const exited = new Promise<void>((resolve) => {
    subscription = stale.onExit(() => resolve());
    timer = setTimeout(resolve, options.exitWaitMs ?? 2_000);
  });
  try {
    await stale.terminate().catch(() => false);
    await exited;
  } finally {
    if (timer) clearTimeout(timer);
    subscription?.dispose();
  }
  // If the exit was not delivered in time, unregister it here so the new run is
  // not handed the old process. Its late exit handler then finds another
  // process registered and leaves the session alone.
  if (terminals.process(sessionId) === stale) terminals.cleanupSession(sessionId);
  return true;
}
