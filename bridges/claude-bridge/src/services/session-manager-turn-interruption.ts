// A turn that a bridge restart cut short.
//
// Session state lives in memory and the bridge dies with the backend, so a
// restarted bridge restores every session idle, and a turn that stopped
// partway looks finished. A workflow then reads a finished turn without its
// result: the reviewer was asked for a report it had never written. While a
// turn is in flight this module keeps a mark in the session's preferences
// file, and clears it when the turn settles. A later process that restores
// the session with the mark still there reports the turn failed, with
// `interruption: "restart"` beside the error, which is what the backend
// continues a turn on (`ReviewFanoutRunner`, the Multi Review step runner).

import { randomUUID } from "node:crypto";
import type { SessionState } from "../types/index.js";
import { debugLog } from "./logger.js";
import { sdkSessionIdFromBridgeId } from "./session-manager-core.js";
import {
  processIsAlive,
  type SessionPreferences,
  updateSessionPreferences,
} from "./session-preferences.js";

export const CLAUDE_RESTARTED_MID_TURN_MESSAGE =
  "Claude restarted before this turn finished, so its work stopped partway. Send a message to continue.";

/** Changes when this bridge process restarts. Only written into marks. */
const BRIDGE_INSTANCE_ID = randomUUID();

/**
 * The notice for a turn whose Claude Code process was killed by a signal
 * (the OOM killer, a user's `pkill`, a container under memory pressure) while
 * this bridge stayed up. The rollout holds the turn so far and the next prompt
 * resumes it in a new process, exactly as after a bridge restart.
 */
export function claudeProcessKilledMessage(signal: string): string {
  return `Claude Code was stopped (${signal}) before this turn finished, so its work stopped partway. Send a message to continue.`;
}

/**
 * The SDK's own classification of a turn error, when it says the CLI was
 * killed by a signal. Only that class counts: a non-zero exit is as likely a
 * launch or sign-in fault, where continuing would fail the same way. The
 * bridge's own stops never reach it, since they abort the turn first (an
 * aborted turn settles before this is read) or end through `Query.close()`,
 * which fails with its own "closed" error. `errorClass` and `signal` are
 * undocumented SDK fields; `sdk-compatibility.test.ts` pins them.
 */
export function killedClaudeProcessSignal(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { errorClass?: unknown; signal?: unknown };
  if (record.errorClass !== "process_killed_by_signal") return undefined;
  return typeof record.signal === "string" && /^SIG[A-Z0-9]{1,8}$/.test(record.signal)
    ? record.signal
    : "a signal";
}

/**
 * Whether the session owes its caller more of the current turn: the model is
 * running, the CLI owes the root continuation a background task's
 * notification starts, or a restart cut the turn short and nothing has
 * continued it yet. A turn released to live background work with nothing
 * owed is over; its caller has its answer.
 */
function turnInFlight(session: SessionState): boolean {
  return (
    session.status === "running" ||
    (session.retainedContinuationRequestIds?.size ?? 0) > 0 ||
    (session.status === "error" && session.interruption === "restart")
  );
}

/**
 * Bring the durable mark in line with the session. Called at the edges where
 * a turn starts or settles; between edges it costs nothing, and one write per
 * edge. Best effort: a mark that was never written leaves a restart reported
 * as before (idle), and one that was never cleared costs one continuation a
 * workflow would accept the earlier result on anyway.
 *
 * `stopped`: the user stopped the turn. A restart before it settles must not
 * be blamed for a stop someone asked for.
 *
 * `requestId`, with `started`: the dispatch request id of the turn the SDK
 * just took. The mark names it, so a later process can say which request a
 * restart cut short.
 */
export function syncTurnInFlightMark(
  session: SessionState,
  options: { stopped?: boolean; started?: boolean; requestId?: string } = {},
): void {
  if (session.deleting) return;
  if (options.started) session.turnInFlightRequestId = options.requestId;
  writeTurnInFlightMark(
    session,
    options.stopped !== true && turnInFlight(session),
    options.started,
  );
}

/**
 * Clear the mark of a session a tab close is releasing. Closing stops the
 * turn on purpose, so a later process must not report it cut short. Runs
 * while the close holds `deleting`, which {@link syncTurnInFlightMark}
 * refuses; a durable delete removes the whole file instead.
 */
export function clearTurnInFlightMarkForClose(session: SessionState): void {
  writeTurnInFlightMark(session, false);
}

function writeTurnInFlightMark(session: SessionState, wanted: boolean, claim = false): void {
  // A new turn rewrites a mark it already owns only to name its own request.
  const renamed =
    claim &&
    session.turnInFlightMarkOwned === true &&
    session.turnInFlightMarkRequestId !== session.turnInFlightRequestId;
  if (
    wanted === (session.turnInFlightMarked === true) &&
    !(wanted && claim && (!session.turnInFlightMarkOwned || renamed))
  )
    return;
  const sdkSessionId = session.sdkSessionId ?? sdkSessionIdFromBridgeId(session.id);
  if (!sdkSessionId) return;
  session.turnInFlightMarked = wanted;
  session.turnInFlightMarkOwned = wanted;
  const requestId = wanted ? session.turnInFlightRequestId : undefined;
  session.turnInFlightMarkRequestId = requestId;
  const update: SessionPreferences = {
    turnInFlight: wanted
      ? {
          bridgeInstanceId: BRIDGE_INSTANCE_ID,
          pid: process.pid,
          startedAt: Date.now(),
          ...(requestId ? { requestId } : {}),
        }
      : undefined,
  };
  void updateSessionPreferences(sdkSessionId, update).catch((error: unknown) => {
    debugLog(
      "[session-manager] Failed to record the turn-in-flight mark:",
      error instanceof Error ? error.message : String(error),
    );
  });
}

/**
 * The state a session restored from disk starts with, given its stored mark.
 *
 * Reported as interrupted only when the process that wrote the mark is gone.
 * Several environments' bridges can share one Claude home, so a mark from a
 * live process that is not this one belongs to that process. Pids repeat
 * across container restarts, so a mark carrying this process's own pid but
 * another instance id is from a dead predecessor.
 */
export function restoredTurnInterruption(
  preferences: SessionPreferences | undefined,
): Pick<
  SessionState,
  | "status"
  | "error"
  | "interruption"
  | "interruptedRequestId"
  | "turnInFlightMarked"
  | "turnInFlightMarkOwned"
> {
  const mark = preferences?.turnInFlight;
  if (!mark) return { status: "idle" };
  if (mark.bridgeInstanceId === BRIDGE_INSTANCE_ID) {
    // Restored by the process that wrote it, after the session left memory.
    // Nothing was cut short; the next settle clears it.
    return { status: "idle", turnInFlightMarked: true, turnInFlightMarkOwned: true };
  }
  if (mark.pid !== process.pid && processIsAlive(mark.pid)) return { status: "idle" };
  return {
    status: "error",
    error: CLAUDE_RESTARTED_MID_TURN_MESSAGE,
    interruption: "restart",
    ...(mark.requestId ? { interruptedRequestId: mark.requestId } : {}),
    // Stays on disk until a turn settles here, so a second restart before the
    // continuation still reports the turn as cut short.
    turnInFlightMarked: true,
  };
}

/** Test-only: the id this process writes into its marks. */
export function bridgeInstanceIdForTesting(): string {
  return BRIDGE_INSTANCE_ID;
}
