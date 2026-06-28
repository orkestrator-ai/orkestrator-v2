import { beforeEach, describe, expect, mock, test } from "bun:test";
import { useKanbanStore } from "@/stores/kanbanStore";
import {
  addPipelineKanbanComment,
  movePipelineKanbanTask,
  updatePipelineKanbanPrMetadata,
} from "./build-pipeline-source";

const moveTaskMock = mock(async () => undefined);
const addCommentMock = mock(async () => undefined);
const updateTaskMock = mock(async () => undefined);

describe("build-pipeline-source helpers", () => {
  beforeEach(() => {
    moveTaskMock.mockClear();
    addCommentMock.mockClear();
    updateTaskMock.mockClear();
    useKanbanStore.setState({
      moveTask: moveTaskMock as unknown as ReturnType<typeof useKanbanStore.getState>["moveTask"],
      addComment: addCommentMock as unknown as ReturnType<typeof useKanbanStore.getState>["addComment"],
      updateTask: updateTaskMock as unknown as ReturnType<typeof useKanbanStore.getState>["updateTask"],
    });
  });

  test("forwards kanban-backed pipeline updates to the kanban store", () => {
    const pipeline = { taskId: "task-1", source: { type: "kanban" as const, taskId: "task-1" } };

    movePipelineKanbanTask(pipeline, "review");
    addPipelineKanbanComment(pipeline, "Done");
    updatePipelineKanbanPrMetadata(pipeline, { prUrl: "https://github.com/acme/repo/pull/1", prState: "open" });

    expect(moveTaskMock).toHaveBeenCalledWith("task-1", "review");
    expect(addCommentMock).toHaveBeenCalledWith("task-1", "Done");
    expect(updateTaskMock).toHaveBeenCalledWith("task-1", {
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
    });
  });

  test("does not mutate kanban tasks for Linear-backed pipelines", () => {
    const pipeline = {
      taskId: "issue-1",
      source: { type: "linear" as const, issueId: "issue-1", issueIdentifier: "ENG-123" },
    };

    movePipelineKanbanTask(pipeline, "review");
    addPipelineKanbanComment(pipeline, "Done");
    updatePipelineKanbanPrMetadata(pipeline, { prUrl: "https://github.com/acme/repo/pull/1", prState: "open" });

    expect(moveTaskMock).not.toHaveBeenCalled();
    expect(addCommentMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });
});
