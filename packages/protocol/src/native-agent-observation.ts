/**
 * Wire contract for backend native-agent observation invalidations
 * (recurring-processes step 07).
 *
 * The backend's activity observer announces every session activity transition
 * on `native-agent-session-activity`. Since step 07 each announcement also
 * names the session (`agent`, `logical_session_key`) and carries the
 * observer's {@link ViewRevisionStamp}: `generation` is one lifetime of the
 * observer, and `revision` increases by exactly one per announcement, so a
 * client that sees a gap knows it missed one and must re-read every native
 * view it holds. All fields are additive; an announcement without them comes
 * from an older backend.
 *
 * A `reason: "content"` announcement is not a transition: `state` equals
 * `previous_state`, and it says that an idle session's view changed anyway
 * (its provider's content revision moved). Clients treat it like any other
 * session-scoped invalidation; it shares the same stamp sequence.
 */
import type { AgentPlatform } from "./agent-platforms.js";
import { readViewRevisionStamp, type ViewRevisionStamp } from "./view-sync.js";

export const NATIVE_AGENT_ACTIVITY_EVENT = "native-agent-session-activity";

/**
 * Advertised in `get_native_agent_sync_capabilities.observationEventVersions`
 * by a backend that stamps and scopes activity announcements.
 */
export const NATIVE_AGENT_OBSERVATION_EVENT_VERSION = 1;

/**
 * Providers whose *idle* native views may use the renderer's quiet read
 * backoff. Qualification (step 07 completion notes): the backend observes the
 * provider at least every sweep or through a live event stream, an idle view
 * of the provider cannot change without an announcement, and missed
 * announcements are recovered by the stamp gap check and the read
 * coordinator's reconnect reconcile.
 *
 * Claude (background task output behind a released composer) and Codex (async
 * questions and late command changes on an idle thread) change an idle view
 * without an activity transition. They qualify only through content
 * announcements, so they are also in
 * {@link NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PLATFORMS}.
 */
export const NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS: readonly AgentPlatform[] = Object.freeze([
  "cursor",
  "pi",
  "grok",
  "opencode",
  "claude",
  "codex",
]);

/**
 * Qualified providers whose idle view may back off only while the backend
 * marks the session `turn.quietObservation`: its bridge reports a content
 * revision on the no-touch activity read, and the backend announces each
 * change of it (`reason: "content"`). A session on an older bridge, or before
 * its first observation, keeps the baseline cadence.
 */
export const NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PLATFORMS: readonly AgentPlatform[] =
  Object.freeze(["claude", "codex"]);

export interface NativeAgentActivityAnnouncement {
  environmentId: string;
  agent?: string;
  logicalSessionKey?: string;
  previousState?: string;
  state: string;
  /** `content`: the view changed without a transition. Absent for a transition. */
  reason?: "content";
  /** Absent for an older backend. */
  stamp?: ViewRevisionStamp;
}

const MAX_IDENTIFIER_LENGTH = 1_024;

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

/** Validate one announcement. Malformed payloads, including partial stamps, are null. */
export function parseNativeAgentActivityAnnouncement(
  payload: unknown,
): NativeAgentActivityAnnouncement | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (!boundedString(record.environment_id) || !boundedString(record.state)) return null;
  if (record.agent !== undefined && !boundedString(record.agent)) return null;
  if (record.logical_session_key !== undefined && !boundedString(record.logical_session_key)) {
    return null;
  }
  if (record.previous_state !== undefined && !boundedString(record.previous_state)) return null;
  // An unknown reason is a newer backend's; the announcement still invalidates.
  if (record.reason !== undefined && typeof record.reason !== "string") return null;
  const stamp = readViewRevisionStamp(record, "event");
  if (stamp === "invalid") return null;
  return {
    environmentId: record.environment_id,
    state: record.state,
    ...(record.agent !== undefined ? { agent: record.agent as string } : {}),
    ...(record.logical_session_key !== undefined
      ? { logicalSessionKey: record.logical_session_key as string }
      : {}),
    ...(record.previous_state !== undefined
      ? { previousState: record.previous_state as string }
      : {}),
    ...(record.reason === "content" ? { reason: "content" as const } : {}),
    ...(stamp ? { stamp } : {}),
  };
}

/**
 * Order one stamped announcement against the last one a client accepted.
 *
 * - `first`: nothing accepted yet from this observer lifetime.
 * - `next`: exactly the following revision.
 * - `gap`: a later revision with at least one missing in between.
 * - `reset`: a different observer lifetime (backend restart).
 * - `duplicate`: at or below the last accepted revision.
 */
export type NativeObservationStampOrder = "first" | "next" | "gap" | "reset" | "duplicate";

export function orderNativeObservationStamp(
  last: ViewRevisionStamp | null,
  next: ViewRevisionStamp,
): NativeObservationStampOrder {
  if (!last) return "first";
  if (last.generation !== next.generation) return "reset";
  if (next.revision <= last.revision) return "duplicate";
  return next.revision === last.revision + 1 ? "next" : "gap";
}
