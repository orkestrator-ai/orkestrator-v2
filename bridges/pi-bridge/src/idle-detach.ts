/**
 * Idle detaching: release the Pi session behind a bridge session nobody has
 * touched recently.
 *
 * The transcript, its journal and its session-file pointer all survive, so the
 * next request re-attaches to the same conversation transparently. A session
 * with a turn running, a compaction in flight, a turn being dispatched or an
 * approval parked is never detached — the first three are work, and the last
 * is a person.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { detachSession } from "./agent-session.js";
import { type SessionState, sessionIsBlocked, sessionIsWorking, sessions } from "./state.js";

/** How long a session may sit untouched before its Pi session is released. */
export const IDLE_DETACH_MS = 10 * 60 * 1000;

interface PendingDetach {
  /** The Pi session this detach released: the generation it owns. */
  generation: AgentSession;
  settled: Promise<void>;
}

/**
 * Detaches still disposing, by bridge session. One at a time per session: a
 * sweep that fires while the previous disposal is still running must not
 * queue another behind it.
 */
const pendingDetaches = new Map<SessionState, PendingDetach>();

export function idleDetachDue(state: SessionState, now: number): boolean {
  if (!state.session || state.attaching) return false;
  if (sessionIsWorking(state) || sessionIsBlocked(state) || state.dispatching) return false;
  return now - state.lastAccessed >= IDLE_DETACH_MS;
}

/**
 * Release every idle session once. Returns how many detaches it started.
 *
 * The decision and the release happen in the same synchronous step:
 * `detachSession` clears `state.session` before its first await and only ever
 * disposes the handles it captured there. A prompt that arrives while that
 * disposal is still running therefore attaches a *new* generation the pending
 * disposal cannot reach, so it never tears down live work.
 */
export function sweepIdleSessions(
  now: number = Date.now(),
  detach: (state: SessionState) => Promise<void> = detachSession,
): number {
  let started = 0;
  for (const state of Array.from(sessions.values())) {
    if (pendingDetaches.has(state) || !idleDetachDue(state, now)) continue;
    const generation = state.session as AgentSession;
    const settled = detach(state)
      .catch(() => undefined)
      .finally(() => {
        if (pendingDetaches.get(state)?.generation === generation) pendingDetaches.delete(state);
      });
    pendingDetaches.set(state, { generation, settled });
    started += 1;
  }
  return started;
}

/** Wait for every idle detach already in flight; shutdown owns their tail. */
export async function settleIdleDetaches(): Promise<void> {
  await Promise.all(Array.from(pendingDetaches.values(), (pending) => pending.settled));
}
