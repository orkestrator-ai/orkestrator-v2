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
 *
 * Every session invalidation also names why it was sent: `cause` on this
 * announcement and on a `native-agent-session` resource change, one entry of
 * {@link NATIVE_SESSION_INVALIDATION_CAUSES}. It is diagnostic only (todo 0049
 * task 4): clients invalidate the same way whatever it says.
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

/**
 * Why the backend told native session views to read again. A fixed,
 * content-free vocabulary: it names the code path that announced, never a
 * value, identifier, prompt or transcript text, so it can be a metrics label.
 * Adding an entry is how a new announcement site is allowed to exist; the
 * backend's announce APIs take this type, not a string.
 */
export const NATIVE_SESSION_INVALIDATION_CAUSES = [
  // `native-agent-session` resource changes from the projection layer.
  /** A provider read produced a projection that differs from the cached one. */
  "projection-read",
  /** A provider read failed and the projection changed to its unreachable form. */
  "projection-unreachable",
  /** A title the backend chose was written into cached projections. */
  "projection-title",
  /** A runtime stop withdrew the environment's outstanding requests. */
  "projection-withdrawn",
  /** Progressive hydration recovered a cold transcript. */
  "hydration",
  /** A discovery section (models, commands, MCP, runtime) missed its 2 s deadline. */
  "discovery-deadline",
  /** A discovery section's read finished with a value a view would show differently. */
  "discovery-renewal",
  /** An MCP server action (reconnect, enable, disable, sign-in) re-read the session's MCP list. */
  "mcp-action",
  /** An expired environment model catalogue refreshed to a different catalogue. */
  "model-catalog-refresh",
  /** An environment's first model catalogue finished loading in the background. */
  "model-catalog-load",
  /** A session's slash-command catalogue changed. */
  "command-catalog",
  /** An Orkestrator permission rule answered one of the session's requests. */
  "permission-rule",
  /** A transcript-artifact publication changed the environment's projected transcripts. */
  "transcript-artifact",
  // `native-agent-session` resource changes from persisted session records.
  "record-created",
  "record-policy",
  "record-goal",
  "record-controls",
  "record-title",
  "record-notice",
  "record-invalidated",
  "record-removed",
  "record-dispatch",
  // `native-agent-session-activity` announcements from the activity observer.
  /** The session's activity state changed. */
  "transition",
  /** An idle (or released) session's provider content revision moved. */
  "content-revision",
  /** The session's backend-owned view changed, such as its goal. */
  "session-content",
  /** A runtime stop settled a running session to idle. */
  "runtime-stopped",
] as const;
export type NativeSessionInvalidationCause = (typeof NATIVE_SESSION_INVALIDATION_CAUSES)[number];

const INVALIDATION_CAUSE_SET: ReadonlySet<string> = new Set(NATIVE_SESSION_INVALIDATION_CAUSES);

export function isNativeSessionInvalidationCause(
  value: unknown,
): value is NativeSessionInvalidationCause {
  return typeof value === "string" && INVALIDATION_CAUSE_SET.has(value);
}

/**
 * Causes that say a session's discovery view (models, commands, MCP, runtime)
 * may have moved.
 */
const DISCOVERY_INVALIDATION_CAUSES: ReadonlySet<NativeSessionInvalidationCause> = new Set([
  "discovery-deadline",
  "discovery-renewal",
  "mcp-action",
  "model-catalog-refresh",
  "model-catalog-load",
  "command-catalog",
]);

/**
 * Whether a `native-agent-session` change should cost a discovery read. A
 * change with no cause (a backend before causes) or with one this client does
 * not know (a newer backend) could be about anything, so it counts.
 */
export function nativeSessionInvalidationNamesDiscovery(cause: unknown): boolean {
  return !isNativeSessionInvalidationCause(cause) || DISCOVERY_INVALIDATION_CAUSES.has(cause);
}

/** Where a counted invalidation went: one platform's sessions, or a whole environment. */
export type NativeSessionInvalidationScope = AgentPlatform | "environment";

/**
 * Content-free counts of the session invalidations one backend emitted since
 * it started (or its counters were reset), by cause and by scope. Bounded by
 * the vocabulary: at most seven scopes times the causes above.
 */
export interface NativeSessionInvalidationSnapshot {
  enabled: boolean;
  /** Milliseconds since the counter was created or last reset. */
  windowMs: number;
  total: number;
  byCause: Partial<Record<NativeSessionInvalidationCause, number>>;
  byScope: Partial<
    Record<NativeSessionInvalidationScope, Partial<Record<NativeSessionInvalidationCause, number>>>
  >;
  /** Invalidations whose cause or agent was outside the vocabulary; counted, never kept. */
  droppedLabels: number;
}

export interface NativeAgentActivityAnnouncement {
  environmentId: string;
  agent?: string;
  logicalSessionKey?: string;
  previousState?: string;
  state: string;
  /** `content`: the view changed without a transition. Absent for a transition. */
  reason?: "content";
  /** Why it was sent. Absent for an older backend or a cause this client does not know. */
  cause?: NativeSessionInvalidationCause;
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
  // Likewise an unknown cause: diagnostic only, so it never drops the announcement.
  if (record.cause !== undefined && typeof record.cause !== "string") return null;
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
    ...(isNativeSessionInvalidationCause(record.cause) ? { cause: record.cause } : {}),
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
