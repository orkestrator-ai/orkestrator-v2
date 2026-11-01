/**
 * How environments are ordered "by activity", and which activity a row shows.
 *
 * The local sidebar, the federated (cross-machine) activity list and the CLI's
 * environment list all order the same records, so they share this one
 * comparator rather than each keeping a copy with its own timestamps.
 *
 * Timestamps come from different machines' clocks across federation, so the
 * order is a presentation sort only; nothing may depend on it for correctness.
 */
import { parseUsableAgentActivityTime, type AgentActivityState } from "./agent-activity.js";

export type ActivitySortOrder = "priority" | "newest" | "oldest";

export const ACTIVITY_SORT_ORDERS: readonly ActivitySortOrder[] = ["priority", "newest", "oldest"];

/** Priority-order rank: unread work first, then waiting, working and idle. */
export const ACTIVITY_ATTENTION_RANK: Readonly<Record<AgentActivityState, number>> = {
  waiting: 0,
  working: 1,
  idle: 2,
};

/** The fields the activity order reads. Callers map their own record onto it. */
export interface ActivityOrderFields {
  /** The activity the row displays (see `displayedEnvironmentActivity`). */
  activity?: AgentActivityState | null;
  hasUnreadWork?: boolean | null;
  /** Last prompt dispatch or agent completion/waiting transition. */
  lastActivityAt?: string | null;
  /**
   * The backend's activity snapshot time. Every activity report and observer
   * lease renewal advances it, so it is only a fallback for a record (an older
   * remote backend's summary) that carries no `lastActivityAt`.
   */
  activityUpdatedAt?: string | null;
}

/**
 * Selects the freshest activity observation. Runtime events keep the current
 * frontend responsive, while the persisted environment snapshot hydrates a
 * frontend that never saw those events (or was suspended while they fired).
 */
export function resolveEnvironmentAgentActivity(
  environment: {
    id: string;
    containerId?: string | null;
    agentActivityState?: AgentActivityState;
    agentActivityUpdatedAt?: string;
  },
  runtimeStates: Record<string, AgentActivityState>,
  runtimeUpdatedAt: Record<string, string>,
): AgentActivityState {
  const runtimeKeys = [
    environment.id,
    ...(environment.containerId ? [environment.containerId] : []),
  ];
  let runtimeState: AgentActivityState | undefined;
  let runtimeTime = Number.NEGATIVE_INFINITY;
  for (const key of runtimeKeys) {
    const candidate = runtimeStates[key];
    if (!candidate) continue;
    const candidateTime = parseUsableAgentActivityTime(runtimeUpdatedAt[key]);
    if (!Number.isFinite(candidateTime)) continue;
    if (!runtimeState || candidateTime > runtimeTime) {
      runtimeState = candidate;
      runtimeTime = candidateTime;
    }
  }

  const persistedState = environment.agentActivityState;
  const persistedTime = parseUsableAgentActivityTime(environment.agentActivityUpdatedAt);
  if (
    persistedState &&
    Number.isFinite(persistedTime) &&
    (!runtimeState || persistedTime >= runtimeTime)
  ) {
    return persistedState;
  }
  return runtimeState ?? "idle";
}

/**
 * The activity a row shows. An active build pipeline counts as working even
 * when no agent session has projected activity onto its environment yet.
 */
export function displayedEnvironmentActivity(
  activity: AgentActivityState | null | undefined,
  hasActiveBuild: boolean,
): AgentActivityState {
  if (hasActiveBuild) return "working";
  return activity ?? "idle";
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

/**
 * Newest first. A missing or unparseable time sorts after every dated one, and
 * two undated rows tie, so the comparator stays consistent for `Array.sort`.
 */
export function compareActivityTimestampsDesc(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftTime = parseTimestamp(left);
  const rightTime = parseTimestamp(right);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid && rightValid) return rightTime - leftTime;
  if (leftValid) return -1;
  if (rightValid) return 1;
  return 0;
}

/**
 * Orders two environments by activity; 0 means tied, so the caller appends its
 * own stable fallback (project and environment order locally, backend and
 * environment ids across machines).
 *
 * - "priority": unread work first, then waiting, working and idle; newest first
 *   within each group by `lastActivityAt`, falling back to the snapshot time
 *   only when a record has none.
 * - "newest" / "oldest": by `lastActivityAt` alone, the time of actual user or
 *   agent activity, so snapshot writes and lease refreshes never reorder rows.
 *   Undated rows follow dated ones when newest first and precede them when
 *   oldest first.
 */
export function compareEnvironmentsByActivity(
  left: ActivityOrderFields,
  right: ActivityOrderFields,
  order: ActivitySortOrder = "priority",
): number {
  if (order === "priority") {
    const unread = Number(right.hasUnreadWork === true) - Number(left.hasUnreadWork === true);
    if (unread !== 0) return unread;
    const attention =
      ACTIVITY_ATTENTION_RANK[left.activity ?? "idle"] -
      ACTIVITY_ATTENTION_RANK[right.activity ?? "idle"];
    if (attention !== 0) return attention;
    return compareActivityTimestampsDesc(
      left.lastActivityAt || left.activityUpdatedAt,
      right.lastActivityAt || right.activityUpdatedAt,
    );
  }
  const newestFirst = compareActivityTimestampsDesc(left.lastActivityAt, right.lastActivityAt);
  return order === "oldest" ? -newestFirst : newestFirst;
}
