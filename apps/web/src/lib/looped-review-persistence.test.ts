import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  isLoopedReviewWorkflow,
  startLoopedReviewPersistence,
  type LoopedReviewPersistenceOptions,
} from "./looped-review-persistence";
import {
  LOOPED_REVIEW_WORKFLOW_VERSION,
  useLoopedReviewStore,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";

function createWorkflow(): LoopedReviewWorkflow {
  const id = useLoopedReviewStore.getState().createWorkflow({
    environmentId: "env-1",
    projectId: "project-1",
    agent: "claude",
    model: "claude-model",
    targetBranch: "main",
    allowance: 6,
  });
  return useLoopedReviewStore.getState().workflows.get(id)!;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
}

beforeEach(() => {
  useLoopedReviewStore.setState({ workflows: new Map() });
});

afterEach(() => {
  useLoopedReviewStore.setState({ workflows: new Map() });
});

describe("looped-review authoritative persistence", () => {
  test("serializes state transitions and advances backend revisions", async () => {
    const workflow = createWorkflow();
    let revision = 0;
    const save = mock(async (
      id: string,
      environmentId: string,
      version: number,
      snapshot: unknown,
      expectedRevision?: number,
    ) => {
      expect(expectedRevision).toBe(revision);
      revision += 1;
      return {
        id,
        environmentId,
        version,
        snapshot,
        updatedAt: "2026-07-25T00:00:00.000Z",
        revision,
      };
    });
    const stop = startLoopedReviewPersistence({
      debounceMs: 0,
      save: save as unknown as NonNullable<LoopedReviewPersistenceOptions["save"]>,
      load: mock(async () => null),
    });
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)?.backendRevision)
      .toBe(1);

    useLoopedReviewStore.getState().pauseWorkflow(workflow.id);
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)?.backendRevision)
      .toBe(2);
    stop();
  });

  test("rehydrates the authoritative winner on a compare-and-swap conflict", async () => {
    const workflow = createWorkflow();
    const winner: LoopedReviewWorkflow = {
      ...workflow,
      phase: "paused",
      pausedFromPhase: "preparing",
      backendRevision: 4,
    };
    const load = mock(async () => ({
      id: workflow.id,
      environmentId: workflow.environmentId,
      version: LOOPED_REVIEW_WORKFLOW_VERSION,
      snapshot: winner,
      updatedAt: winner.updatedAt,
      revision: 4,
    }));
    const stop = startLoopedReviewPersistence({
      debounceMs: 0,
      save: mock(async () => {
        throw new Error("Looped review workflow revision conflict");
      }),
      load: load as unknown as NonNullable<LoopedReviewPersistenceOptions["load"]>,
    });
    await settle();

    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)).toMatchObject({
      phase: "paused",
      backendRevision: 4,
    });
    stop();
  });

  test("rejects incomplete snapshots during recovery", () => {
    expect(isLoopedReviewWorkflow({ version: 1, id: "partial" })).toBe(false);
    expect(isLoopedReviewWorkflow(createWorkflow())).toBe(true);
  });
});
