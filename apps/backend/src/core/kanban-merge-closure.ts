/**
 * A Kanban ticket whose linked pull request merged is finished: it moves to
 * done. Three writers apply this rule, all through
 * `KanbanRepository.closeKanbanTasksForMergedPullRequests`:
 *
 * - the PR monitor, the moment it sees the environment's pull request merge
 *   (`pr-monitor.ts`, the `status` reconciliation step);
 * - a build pipeline that ends after its pull request merged, which would
 *   otherwise move the ticket back to review or backlog
 *   (`build-pipeline-service-recovery.ts`, `updateKanbanLifecycle`);
 * - a startup sweep for tickets whose merge was recorded but never applied,
 *   including every ticket an older build left behind (`pr-monitor-runtime.ts`).
 *
 * The closure happens once per pull request. The ticket remembers the merged
 * pull request that closed it (`prMergeDoneUrl`), so a ticket the user moves
 * back out of done afterwards is not closed again for the same merge.
 */
import type { KanbanTask } from "./storage-shared.js";

/** The PR monitor's comment on a ticket whose pull request merged; followed by `: <url>`. */
export const PR_MERGED_COMMENT = "🎉 PR merged";
export const PR_CLOSED_COMMENT = "❌ PR closed";
/** Mirrors `buildPipelinePrRaisedComment`. */
const PR_RAISED_COMMENT = "🔗 PR raised";

/** One ticket to close for one merged pull request. */
export interface KanbanMergeClosure {
  taskId: string;
  prUrl: string;
}

/** The URL a pull-request lifecycle comment names, with what happened to it. */
function pullRequestComment(text: string): { url: string; merged: boolean } | null {
  for (const [prefix, merged] of [
    [PR_MERGED_COMMENT, true],
    [PR_CLOSED_COMMENT, false],
    [PR_RAISED_COMMENT, false],
  ] as const) {
    if (!text.startsWith(`${prefix}: `)) continue;
    const url = text.slice(prefix.length + 2).trim();
    return url ? { url, merged } : null;
  }
  return null;
}

/**
 * The merged pull request a ticket records, or null. The linked pull request
 * decides when there is one; a ticket with no link falls back to the latest
 * pull-request comment, which counts only when it is the monitor's merged
 * comment (a later raised or closed comment means other work followed).
 */
export function mergedPullRequestOnTicket(
  task: Pick<KanbanTask, "prUrl" | "prState" | "comments">,
): string | null {
  if (task.prUrl) return task.prState === "merged" ? task.prUrl : null;
  for (let index = task.comments.length - 1; index >= 0; index -= 1) {
    const comment = pullRequestComment(task.comments[index]!.text);
    if (comment) return comment.merged ? comment.url : null;
  }
  return null;
}

/** Whether merging `prUrl` still has to move this ticket to done. */
export function kanbanTaskAwaitsMergeClosure(
  task: Pick<KanbanTask, "status" | "prMergeDoneUrl">,
  prUrl: string,
): boolean {
  return task.status !== "done" && task.prMergeDoneUrl !== prUrl;
}

/**
 * The tickets the startup sweep closes: a recorded merge not yet applied.
 * A ticket in progress is left alone, because an earlier build only ever
 * moved a merged ticket out of in-progress, so one there now is being built
 * again and its old merge is not the end of the new work.
 */
export function pendingMergeClosures(tasks: readonly KanbanTask[]): KanbanMergeClosure[] {
  return tasks.flatMap((task) => {
    if (task.status === "in-progress") return [];
    const prUrl = mergedPullRequestOnTicket(task);
    return prUrl && kanbanTaskAwaitsMergeClosure(task, prUrl) ? [{ taskId: task.id, prUrl }] : [];
  });
}
