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
import { SETUP_TERMINAL_STILL_RUNNING_MESSAGE } from "./commands-error-text.js";
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
 * PTYs a setup retry has taken over. Their exit, however late, belongs to a
 * finished run: `spawnTerminalProcess` must not complete the session's history
 * or unregister it, because by then they may describe the replacement run,
 * even one still in its preflight with nothing registered yet.
 */
const retiredSetupTerminals = new WeakSet<PtyProcess>();

export function isRetiredSetupTerminal(process: PtyProcess): boolean {
  return retiredSetupTerminals.has(process);
}

/** The previous run's process tree survived termination; nothing was replaced. */
export class SetupTerminalStillRunningError extends Error {
  constructor() {
    super(SETUP_TERMINAL_STILL_RUNNING_MESSAGE);
    this.name = "SetupTerminalStillRunningError";
  }
}

export type SetupTerminalRetirementRuntime = Pick<
  TerminalRuntime,
  | "process"
  | "cleanupSession"
  | "history"
  | "takeContainerShell"
  | "recordContainerShell"
  | "closeContainerShellAndWait"
>;

/**
 * Ends the terminal a previous setup run left open, so a new run gets its own.
 *
 * Only called once no setup run is in flight, so a terminal still registered
 * here belongs to a finished run: its commands are done and it is sitting at
 * the prompt `exec <shell> -l` left. Reusing it would run nothing, attach no
 * completion tracker and leave the new run waiting forever.
 *
 * The retirement owns the old run's teardown: it completes its history and
 * unregisters it, and the old PTY's own exit handler leaves the session alone
 * (`isRetiredSetupTerminal`). A container setup terminal's in-container shell,
 * which outlives its host `docker exec` client, is ended and waited for too.
 *
 * Throws `SetupTerminalStillRunningError`, keeping the old terminal and its
 * shell record registered, when its process tree did not exit: starting a new
 * run then would let two setups write to the same workspace and lose the
 * handle that can still end the first. Returns whether a terminal was ended.
 */
export async function retireFinishedSetupTerminal(
  sessionId: string,
  terminals: SetupTerminalRetirementRuntime,
): Promise<boolean> {
  const stale = terminals.process(sessionId);
  if (!stale) return false;
  const shell = terminals.takeContainerShell(sessionId);
  retiredSetupTerminals.add(stale);
  const exited = await Promise.resolve()
    .then(() => stale.terminate())
    .then(
      (result) => result === true,
      () => false,
    );
  if (!exited) {
    retiredSetupTerminals.delete(stale);
    if (shell) terminals.recordContainerShell(sessionId, shell);
    throw new SetupTerminalStillRunningError();
  }
  await terminals.history.complete(sessionId).catch(() => undefined);
  if (terminals.process(sessionId) === stale) terminals.cleanupSession(sessionId);
  if (shell) await terminals.closeContainerShellAndWait(shell);
  return true;
}
