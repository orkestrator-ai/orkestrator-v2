import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("native-agent");

/** Sessions whose last logged phase is remembered; the oldest is dropped past it. */
export const QUEUED_TURN_LOG_SESSION_LIMIT = 256;

export interface QueuedTurnObservation {
  agent: string;
  environmentId: string;
  /** The per-session storage key; kept in memory only, never logged. */
  sessionKey: string;
  phase: string | undefined;
  queued: number;
}

/**
 * Records, content-free, when a projection holds queued prompts while its turn
 * is not `running` (6640 (retired)).
 *
 * A queued row with no note and no Steer means the renderer did not see the
 * turn as running. This line shows the backend's side of that: a backend phase
 * of `running` while the row is bare points at the renderer, anything else at
 * the backend or bridge. It writes once per change of phase, so a tab polling
 * a recovering session does not repeat it, and only at `native-agent=debug`.
 * A queue draining at the end of a normal turn also writes it once.
 *
 * The fields are identifiers, the phase and a count: never a prompt, a queued
 * item, a provider session id or the logical session key.
 */
export class QueuedTurnPhaseLog {
  private readonly lastLogged = new Map<string, string>();

  observe(observation: QueuedTurnObservation): void {
    const phase = observation.phase ?? "unknown";
    if (observation.queued <= 0 || phase === "running") {
      // Clearing here makes the next non-running phase with a queue a change.
      this.lastLogged.delete(observation.sessionKey);
      return;
    }
    // Remembering a phase that was never written would hide the first line
    // after **Log Detail** is raised.
    if (!log.isEnabled("debug")) return;
    if (this.lastLogged.get(observation.sessionKey) === phase) return;
    this.lastLogged.delete(observation.sessionKey);
    this.lastLogged.set(observation.sessionKey, phase);
    while (this.lastLogged.size > QUEUED_TURN_LOG_SESSION_LIMIT) {
      const oldest = this.lastLogged.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.lastLogged.delete(oldest);
    }
    log.debug("queue.turn-not-running", {
      agent: observation.agent,
      environmentId: observation.environmentId,
      phase,
      queued: observation.queued,
    });
  }

  size(): number {
    return this.lastLogged.size;
  }

  clear(): void {
    this.lastLogged.clear();
  }
}
