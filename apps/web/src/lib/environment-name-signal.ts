/**
 * The one state an environment's name shimmers for. A user scanning the
 * sidebar sees which environments are waiting on them, and why, by colour:
 *
 * - `needs-answer` (yellow): the agent stopped to wait for the user, the same
 *   state that pulses the row's status marker yellow.
 * - `merge-conflicts` (red): the pull request cannot merge until its conflicts
 *   are resolved.
 * - `merge-ready` (green): the pull request waits only for the user to merge.
 *
 * A blocked agent outranks the pull request: it is idle until answered, while
 * a pull request keeps. The two pull request states are exclusive.
 */
import type { PrMergeState } from "@/lib/pr-merge-readiness";

export type EnvironmentNameSignal = "needs-answer" | "merge-conflicts" | "merge-ready";

export function environmentNameSignal({
  waitingOnUser,
  prMergeState,
}: {
  waitingOnUser: boolean;
  prMergeState: PrMergeState | null;
}): EnvironmentNameSignal | null {
  if (waitingOnUser) return "needs-answer";
  if (prMergeState === "conflicts") return "merge-conflicts";
  if (prMergeState === "ready") return "merge-ready";
  return null;
}
