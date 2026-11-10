/**
 * Which session routes keep a Pi session attached (#2062).
 *
 * The idle detach (`idle-detach.ts`) releases a session's Pi SDK handle and
 * its MCP processes once `lastAccessed` is ten minutes old. An open but idle
 * tab keeps reading through the backend: live updates (`/session/:id`,
 * `/status`, `/transcript`, `/config`, `/approvals`, `/interactions`,
 * `/queue`, …) and discovery renewals every 30 s (`/mcp`, `/commands`,
 * `/runtime-health`). When those reads counted, the session never detached
 * while any tab showed it.
 *
 * So only what a person's action causes keeps a session warm: a write to it
 * (a prompt, the pre-dispatch `/attach`, a config change, a cancel, a
 * compaction, an approval answer, …) and resuming it, which `resumeSession`
 * touches itself. Reads never do, whoever issues them: the bridge cannot tell
 * a read for a tab the user just opened from a background renewal, and none
 * of them needs the SDK session. The cost is one re-attach on the first
 * prompt after a long idle, which the backend's `/attach` before dispatch
 * already takes outside the at-most-once window.
 *
 * Two writes are background work rather than a person's action and stay
 * exempt: the title the backend chooses after a turn, and an approval hold
 * (a parked approval blocks the detach on its own).
 *
 * Every session request is also counted by route and by whether it touched,
 * on the session's runtime-health body (`liveness`). Labels come from the
 * route table only — method, action and a fixed sub-path, with any id as
 * `:id` — so the counters carry no content and are bounded by the route
 * vocabulary.
 */
import type { SessionState } from "./state.js";

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** Sub-paths that are route names rather than identifiers. */
const FIXED_SUBJECTS: ReadonlySet<string> = new Set(["refresh", "dispatch", "detail", "page"]);

export interface SessionRouteRequest {
  method: string | undefined;
  /** The session route's action (`messages`, `mcp`, …); undefined for `/session/:id`. */
  action: string | undefined;
  subject: string | undefined;
  detail: string | undefined;
}

export interface SessionRouteCount {
  requests: number;
  touches: number;
}

/** The content-free label of one session route, e.g. `GET mcp` or `POST approvals/:id/hold`. */
export function sessionRouteLabel(request: SessionRouteRequest): string {
  const method = request.method && METHODS.has(request.method) ? request.method : "OTHER";
  let path = request.action ?? "session";
  if (request.subject !== undefined) {
    path += `/${FIXED_SUBJECTS.has(request.subject) ? request.subject : ":id"}`;
  }
  if (request.detail !== undefined) path += "/hold";
  return `${method} ${path}`;
}

/** Whether this request is a person's action on the session, and so refreshes `lastAccessed`. */
export function touchesLiveness(request: SessionRouteRequest): boolean {
  // Reads are observation: the open tab's live updates, the backend's sweep,
  // discovery renewals. None needs the SDK session.
  if (request.method === "GET" || request.method === "HEAD") return false;
  // The backend names a session after its first turn; not a person's action.
  if (request.action === "title") return false;
  // A pause on a parked approval; the parked approval already blocks detach.
  if (request.action === "approvals" && request.detail !== undefined) return false;
  return true;
}

/**
 * Count one request against its session and refresh the idle clock when it
 * is a person's action. Returns whether it touched.
 */
export function observeSessionRequest(
  state: SessionState,
  request: SessionRouteRequest,
  now: number = Date.now(),
): boolean {
  const touched = touchesLiveness(request);
  if (touched) state.lastAccessed = now;
  const label = sessionRouteLabel(request);
  const routes = (state.routeCounts ??= new Map());
  const count = routes.get(label) ?? { requests: 0, touches: 0 };
  count.requests += 1;
  if (touched) count.touches += 1;
  routes.set(label, count);
  return touched;
}

/** The session's route counters, for its runtime-health body. */
export function publicLiveness(state: SessionState): {
  routes: Record<string, SessionRouteCount>;
} {
  return {
    routes: Object.fromEntries(
      Array.from(state.routeCounts ?? [], ([label, count]) => [label, { ...count }]),
    ),
  };
}
