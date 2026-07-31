/**
 * Shared vocabulary for the backend-owned agent activity snapshot.
 *
 * The renderer and the backend both order activity reports by timestamp, and
 * both have to agree on what counts as a usable one. Keeping the tolerance and
 * the parser here means a change to either applies to both halves at once —
 * a drift between them shows up as one side silently discarding the other's
 * observations.
 */

/** Sidebar activity for one environment. */
export type AgentActivityState = "idle" | "working" | "waiting";

/** Who observed an activity state. Renderers may only ever report `frontend`. */
export type AgentActivitySource =
  | "frontend"
  | "claude-terminal"
  | "native-agent";

export interface AgentActivitySourceSnapshot {
  state: AgentActivityState;
  updatedAt: string;
}

/**
 * One renderer's independently leased observation. The backend stores only a
 * hash of the renderer's opaque token, so another renderer cannot overwrite it.
 */
export interface FrontendAgentActivityObserverSnapshot
  extends AgentActivitySourceSnapshot {
  leaseExpiresAt: string;
}

/** Renderers renew at one third of this interval while their monitor is alive. */
export const FRONTEND_AGENT_ACTIVITY_LEASE_MS = 30_000;

export const AGENT_ACTIVITY_STATES: readonly AgentActivityState[] = [
  "idle",
  "working",
  "waiting",
];

export const AGENT_ACTIVITY_SOURCES: readonly AgentActivitySource[] = [
  "frontend",
  "claude-terminal",
  "native-agent",
];

/**
 * Renderer observations originate on the same machine as the backend, so a
 * small allowance covers ordinary clock adjustments without allowing a broken
 * or malicious client clock to permanently outrank backend-owned observations.
 */
export const AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * ECMAScript's Date Time String Format, including the extended ±YYYYYY year.
 * `Date.parse` also accepts implementation-defined forms like "Jul 27 2026",
 * which would make the "must be a valid ISO timestamp" contract a lie and let
 * two clients disagree about what a token means.
 */
const ISO_TIMESTAMP =
  /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** True when `value` is an ISO-8601 timestamp this codebase will round-trip. */
export function isAgentActivityTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && ISO_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value));
}

/**
 * Parse an activity token into a comparable number, or `-Infinity` when it is
 * unusable. Callers gate on `Number.isFinite`, so an unparseable or
 * implausibly-future token loses every ordering comparison rather than
 * winning one.
 */
export function parseUsableAgentActivityTime(
  value: unknown,
  referenceTime: number = Date.now(),
): number {
  if (!isAgentActivityTimestamp(value)) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return parsed <= referenceTime + AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS
    ? parsed
    : Number.NEGATIVE_INFINITY;
}

/**
 * Aggregate per-source observations into the single state the sidebar shows.
 * Blocked-on-the-user (`waiting`) outranks idle, and still-running (`working`)
 * outranks both.
 */
export function aggregateAgentActivityState(
  sources: Partial<Record<string, AgentActivitySourceSnapshot>>,
): AgentActivityState {
  let aggregate: AgentActivityState = "idle";
  for (const snapshot of Object.values(sources)) {
    if (!snapshot) continue;
    if (snapshot.state === "working") return "working";
    if (snapshot.state === "waiting") aggregate = "waiting";
  }
  return aggregate;
}
