import { useKanbanStore } from "@/stores/kanbanStore";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import type { KanbanStatus } from "@/stores/kanbanStore";
import type { PrState } from "@/types";

export function isLinearPipeline(pipeline: Pick<BuildPipeline, "source">): boolean {
  return pipeline.source?.type === "linear";
}

export function isKanbanPipeline(pipeline: Pick<BuildPipeline, "source">): boolean {
  return pipeline.source?.type !== "linear";
}

export function movePipelineKanbanTask(
  pipeline: Pick<BuildPipeline, "taskId" | "source">,
  status: KanbanStatus,
): void {
  if (!isKanbanPipeline(pipeline)) return;
  void useKanbanStore.getState().moveTask(pipeline.taskId, status);
}

export function addPipelineKanbanComment(
  pipeline: Pick<BuildPipeline, "taskId" | "source">,
  text: string,
): void {
  if (!isKanbanPipeline(pipeline)) return;
  void useKanbanStore.getState().addComment(pipeline.taskId, text);
}

export function updatePipelineKanbanPrMetadata(
  pipeline: Pick<BuildPipeline, "taskId" | "source">,
  updates: { prUrl?: string; prState?: PrState },
): void {
  if (!isKanbanPipeline(pipeline)) return;
  void useKanbanStore.getState().updateTask(pipeline.taskId, updates);
}
