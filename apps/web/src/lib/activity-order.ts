/**
 * The "By activity" order, for this window's environments and every other
 * machine's alike, so a row keeps its place when another machine comes into
 * view or is filtered out.
 *
 * - "priority": unread work first, then waiting, working and idle; newest
 *   first within each by the activity snapshot time, falling back to the
 *   last activity time.
 * - "newest"/"oldest": by the last activity time alone, which snapshot and
 *   lease writes do not move.
 *
 * Missing or invalid times follow dated rows when newest come first and
 * precede them when oldest do. Ties keep the sidebar's own order: machine,
 * then project order, then environment order, then ID.
 */
import type { ActivitySortOrder } from "@/stores/uiStore";

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

const ATTENTION_PRIORITY: Record<ActivitySortKey["activity"], number> = {
  waiting: 0,
  working: 1,
  idle: 2,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTimestampsDesc(a: string | undefined, b: string | undefined): number {
  const left = a ? Date.parse(a) : Number.NaN;
  const right = b ? Date.parse(b) : Number.NaN;
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (leftValid && rightValid) return right - left;
  if (leftValid) return -1;
  if (rightValid) return 1;
  return 0;
}

export function compareActivity(
  a: ActivitySortKey,
  b: ActivitySortKey,
  order: ActivitySortOrder = "priority",
): number {
  if (order === "priority") {
    const attention =
      Number(b.hasUnreadWork) - Number(a.hasUnreadWork) ||
      ATTENTION_PRIORITY[a.activity] - ATTENTION_PRIORITY[b.activity];
    if (attention !== 0) return attention;
  }
  // Snapshot writes (including lease refreshes) are not user activity, so the
  // chronological orders use only the last activity time.
  const timestamp = (key: ActivitySortKey) =>
    order === "priority" ? (key.activityUpdatedAt ?? key.lastActivityAt) : key.lastActivityAt;
  const newestFirst = compareTimestampsDesc(timestamp(a), timestamp(b));
  if (newestFirst !== 0) return order === "oldest" ? -newestFirst : newestFirst;
  return (
    compareText(a.machineId, b.machineId) ||
    (a.projectOrder ?? Number.MAX_SAFE_INTEGER) - (b.projectOrder ?? Number.MAX_SAFE_INTEGER) ||
    a.order - b.order ||
    compareText(a.id, b.id)
  );
}
