/**
 * The Kanban side of deleting an environment that holds build pipelines.
 *
 * Environment deletion removes its pipeline records outright
 * (`environment-delete.ts`, `deleteBuildPipelinesByEnvironment`): the
 * container or worktree is already gone, so no pipeline can run its own
 * terminal step. Before this, the ticket of a build that had not finished was
 * left where the build put it (In progress) for good, and one whose pull
 * request had merged was never closed, because the PR monitor stops watching
 * a deleted environment. This applies the lifecycle's ending first
 * (`build-pipeline-kanban-lifecycle.ts`):
 *
 * - the environment's pull request merged: the ticket is done
 *   (`kanban-merge-closure.ts`);
 * - the build had not finished: the ticket goes back to the backlog, with a
 *   comment saying why (a done ticket is never reopened);
 * - the build had finished: the ticket stays where it is (Review, or wherever
 *   the user moved it).
 *
 * It runs where the environment is, so a ticket copied from a command node
 * reaches that node's board through the leaf's ticket outbox, like every other
 * lifecycle change. Best effort: a failure is logged and never blocks the
 * deletion.
 */
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import type { Environment, KanbanTask, PersistedBuildPipeline } from "./storage-shared.js";

const log = createLogger("build-pipeline");

export const BUILD_ENVIRONMENT_DELETED_COMMENT =
  "⚠️ Build stopped: its environment was deleted before it finished";

export interface DeletedEnvironmentKanbanStorage {
  listBuildPipelines(projectId: string): Promise<PersistedBuildPipeline[]>;
  kanban: {
    getKanbanTask(taskId: string): Promise<KanbanTask | null>;
    updateKanbanTask(
      taskId: string,
      updates: { status: "backlog" },
      expectedProjectId: undefined,
      options: { lifecycle: true },
    ): Promise<KanbanTask>;
    addKanbanComment(taskId: string, text: string): Promise<unknown>;
    closeKanbanTasksForMergedPullRequests(
      closures: ReadonlyArray<{ taskId: string; prUrl: string }>,
    ): Promise<string[]>;
  };
}

/** The fields this reads; a record of any snapshot version has them. */
type DeletedPipeline = Pick<BuildPipeline, "id" | "environmentId" | "phase" | "source" | "taskId">;

function deletedPipeline(value: unknown): DeletedPipeline | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.phase === "string"
    ? (record as unknown as DeletedPipeline)
    : null;
}

/** The ticket a pipeline follows; mirrors `pipelineTicketId` in the recovery. */
function ticketOf(pipeline: DeletedPipeline): string | undefined {
  if (pipeline.source?.type === "kanban") return pipeline.source.taskId;
  return pipeline.source ? undefined : pipeline.taskId || undefined;
}

/** The pipelines `deleteBuildPipelinesByEnvironment` is about to remove. */
function pipelinesOf(
  records: readonly PersistedBuildPipeline[],
  environmentId: string,
  linkedPipelineId: string | undefined,
): DeletedPipeline[] {
  return records.flatMap((record) => {
    const snapshot = deletedPipeline(record.snapshot);
    if (!snapshot) return [];
    const owned =
      snapshot.environmentId === environmentId ||
      (!snapshot.environmentId && record.id === linkedPipelineId);
    return owned ? [snapshot] : [];
  });
}

export async function settleTicketsOfDeletedEnvironment(
  storage: DeletedEnvironmentKanbanStorage,
  environment: Pick<Environment, "id" | "projectId" | "prUrl" | "prState" | "buildPipelineId">,
): Promise<void> {
  let pipelines: DeletedPipeline[];
  try {
    pipelines = pipelinesOf(
      await storage.listBuildPipelines(environment.projectId),
      environment.id,
      environment.buildPipelineId ?? undefined,
    );
  } catch (error) {
    log.warn("kanban.environment-deleted-read-failed", { error: formatLogError(error) });
    return;
  }
  const merged = environment.prState === "merged" && environment.prUrl ? environment.prUrl : null;
  for (const pipeline of pipelines) {
    const taskId = ticketOf(pipeline);
    if (!taskId) continue;
    try {
      if (merged) {
        await storage.kanban.closeKanbanTasksForMergedPullRequests([{ taskId, prUrl: merged }]);
        continue;
      }
      if (pipeline.phase === "complete" || pipeline.phase === "failed") continue;
      const task = await storage.kanban.getKanbanTask(taskId);
      if (!task || task.status === "done") continue;
      // Only the ticket this build still holds: a newer build of it moved on.
      if (task.buildPipelineId && task.buildPipelineId !== pipeline.id) continue;
      if (task.status !== "backlog") {
        await storage.kanban.updateKanbanTask(taskId, { status: "backlog" }, undefined, {
          lifecycle: true,
        });
      }
      if (!task.comments.some((comment) => comment.text === BUILD_ENVIRONMENT_DELETED_COMMENT)) {
        await storage.kanban.addKanbanComment(taskId, BUILD_ENVIRONMENT_DELETED_COMMENT);
      }
    } catch (error) {
      log.warn("kanban.environment-deleted-update-failed", {
        pipelineId: pipeline.id,
        error: formatLogError(error),
      });
    }
  }
}
