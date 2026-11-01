/**
 * The protocol activity comparator with stable sidebar tie-breakers.
 *
 * The "By activity" order, for this window's environments and every other
 * machine's alike, so a row keeps its place when another machine comes into
 * view or is filtered out.
 *
 * - "priority": unread work first, then waiting, working and idle; newest
 *   first within each by last activity time, falling back to the snapshot
 *   only when the record has no last activity time.
 * - "newest"/"oldest": by the last activity time alone, which snapshot and
 *   lease writes do not move.
 *
 * Missing or invalid times follow dated rows when newest come first and
 * precede them when oldest do. Ties keep the sidebar's own order: machine,
 * then project order, then environment order, then ID.
 */
import {
  compareEnvironmentsByActivity,
  type ActivitySortOrder,
} from "@orkestrator/protocol/environment-activity-order";

export interface ActivitySortKey {
  hasUnreadWork: boolean;
  activity: "idle" | "working" | "waiting";
  /** When the agent activity was last observed (the snapshot time). */
  activityUpdatedAt?: string;
  /** When a prompt or completion last happened. */
  lastActivityAt?: string;
  /** The owning machine's ID; equal for every row of one machine. */
  machineId: string;
  /** The project's sidebar order; unknown projects sort last. */
  projectOrder: number | undefined;
  order: number;
  id: string;
}

export function compareActivity(
  a: ActivitySortKey,
  b: ActivitySortKey,
  order: ActivitySortOrder = "priority",
): number {
  const activity = compareEnvironmentsByActivity(a, b, order);
  if (activity !== 0) return activity;
  return (
    a.machineId.localeCompare(b.machineId) ||
    (a.projectOrder ?? Number.MAX_SAFE_INTEGER) - (b.projectOrder ?? Number.MAX_SAFE_INTEGER) ||
    a.order - b.order ||
    a.id.localeCompare(b.id)
  );
}
