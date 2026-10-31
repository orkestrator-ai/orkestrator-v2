import { Hono } from "hono";
import {
  answerSessionActivityBatch,
  SESSION_ACTIVITY_BATCH_PATH,
} from "@orkestrator/protocol/session-activity-batch";
import {
  backgroundTaskRevision,
  getSessionActivity,
  sessionCompletionPending,
  peekSession,
  type SessionActivity,
} from "../services/session-manager.js";
import { eventEmitter } from "../services/event-emitter.js";
import { readTranscriptVersion } from "../services/transcript-revision.js";

/**
 * The one activity read both `GET /session/:id/activity` and
 * `POST /sessions/activity` answer with, so the two cannot drift.
 *
 * `getSessionActivity` reads only what is already resident and materializes
 * nothing; `peekSession` does not touch the idle clock. Neither route may route
 * through `resolveSession` / `ensurePersistedSession` / `getSession`: the
 * backend polls every persisted session every couple of seconds, and a touch or
 * hydration here would pin every transcript in memory forever.
 *
 * `missing` is only the in-band proof that a session is gone. A failed
 * existence probe answers `idle` (see `persistedSessionExistsOnDisk`), because
 * an error is not evidence of deletion.
 */
export async function readSessionActivityObservation(sessionId: string): Promise<{
  activity: SessionActivity;
  readyForInput?: true;
  completionPending?: boolean;
  contentRevision?: string;
  turnFailed?: true;
}> {
  const activity = await getSessionActivity(sessionId);
  const resident = peekSession(sessionId);
  const completionPending = resident ? sessionCompletionPending(resident) : undefined;
  return {
    activity: activity === "idle" && completionPending ? "working" : activity,
    // Readiness and activity deliberately diverge while background work is
    // alive: the composer may accept a new prompt while the environment icon
    // must remain blue and pulsing. Only an explicitly settled root turn can
    // announce completion while a detached shell keeps the session working.
    ...(resident?.status === "idle" ? { readyForInput: true as const, completionPending } : {}),
    // The backend reads this on the turn-end edge so the bell says the turn
    // failed rather than that the agent finished. A stop the user asked for
    // settles to idle, so it never sets this.
    ...(resident?.status === "error" ? { turnFailed: true as const } : {}),
    ...(activity === "missing" ? {} : contentRevisionField(resident)),
  };
}

/** Never fails the activity read: an unreadable revision is simply absent. */
function contentRevisionField(resident: ReturnType<typeof peekSession>): {
  contentRevision?: string;
} {
  try {
    return { contentRevision: sessionContentRevision(resident) };
  } catch {
    return {};
  }
}

/**
 * Opaque, content-free revision of what a session view shows beyond its
 * activity: the transcript (subagent rows, tool progress, a task's report) and
 * the background-task snapshot (progress, output tail, end). The backend
 * compares it across its activity sweeps and announces a change on an idle
 * session, which is what lets an idle Claude view read less often while a
 * background task can still change it. O(1); it reads only what is resident
 * and never touches the idle clock. A session that is not resident cannot
 * change, so it answers the process generation alone.
 */
function sessionContentRevision(resident: ReturnType<typeof peekSession>): string {
  if (!resident) return eventEmitter.generation;
  const transcript = readTranscriptVersion(resident);
  return `${eventEmitter.generation}:${transcript.epoch}.${transcript.revision}:${backgroundTaskRevision(resident)}`;
}

/**
 * `POST /sessions/activity` — the bounded batch form of the single route.
 *
 * Mounted at the application root rather than under `/session`, so no
 * `/session/:id` route can ever read `activity` as a session id. Mounted after
 * the authentication middleware like every data route.
 */
export const sessionActivityBatch = new Hono();

sessionActivityBatch.post(SESSION_ACTIVITY_BATCH_PATH, async (c) => {
  const answer = await answerSessionActivityBatch(c.req.raw.body, readSessionActivityObservation, {
    contentLength: c.req.header("content-length"),
  });
  return c.json(answer.body, answer.status as 200);
});
