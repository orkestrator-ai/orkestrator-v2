/**
 * Idle detaching: release the SDK agent behind a session nobody has touched
 * recently.
 *
 * The session, its transcript and its agent id all survive, so the next
 * request re-attaches to the same conversation transparently. A session with a
 * turn running, a background child still running or a turn being dispatched is
 * never detached.
 */
import type { SDKAgent } from "@cursor/sdk";
import { detachAgent } from "./agent-session.js";
import { type SessionState, sessionIsWorking, sessions } from "./state.js";

/** How long a session may sit untouched before its SDK agent is released. */
export const IDLE_DETACH_MS = 10 * 60 * 1000;

interface PendingDetach {
  /** The SDK agent this detach released: the generation it owns. */
  generation: SDKAgent;
  settled: Promise<void>;
}

/**
 * Detaches still disposing, by session. One at a time per session: a sweep
 * that fires while the previous disposal is still running must not queue
 * another behind it.
 */
const pendingDetaches = new Map<SessionState, PendingDetach>();

export function idleDetachDue(state: SessionState, now: number): boolean {
  if (!state.agent || state.attaching) return false;
  // `sessionIsWorking` includes a running background child: a sub-agent still
  // writing files is work even after its launching turn has ended.
  if (sessionIsWorking(state) || state.dispatching) return false;
  return now - state.lastAccessed >= IDLE_DETACH_MS;
}

/**
 * Release every idle session once. Returns how many detaches it started.
 *
 * The decision and the release happen in the same synchronous step:
 * `detachAgent` clears `state.agent` before its first await and only ever
 * disposes the handles it captured there. A prompt that arrives while that
 * disposal is still running therefore attaches a *new* generation the pending
 * disposal cannot reach, so it never tears down live work.
 */
export function sweepIdleSessions(
  now: number = Date.now(),
  detach: (state: SessionState) => Promise<void> = detachAgent,
): number {
  let started = 0;
  for (const state of Array.from(sessions.values())) {
    if (pendingDetaches.has(state) || !idleDetachDue(state, now)) continue;
    const generation = state.agent as SDKAgent;
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
