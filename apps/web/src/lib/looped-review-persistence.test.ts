import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  hydrateLoopedReviewWorkflow,
  hydrateLoopedReviewWorkflowsForEnvironment,
  isLoopedReviewWorkflow,
  persistLoopedReviewWorkflowNow,
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

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for looped-review persistence");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function persisted(workflow: LoopedReviewWorkflow, revision = workflow.backendRevision) {
  return {
    id: workflow.id,
    environmentId: workflow.environmentId,
    version: LOOPED_REVIEW_WORKFLOW_VERSION,
    snapshot: workflow,
    updatedAt: workflow.updatedAt,
    revision,
  };
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

  test("hydrates one valid workflow and rejects mismatched persisted identity", async () => {
    const workflow = createWorkflow();
    const authoritative = {
      ...workflow,
      phase: "paused" as const,
      pausedFromPhase: "preparing" as const,
    };
    const load = mock(async () => persisted(authoritative, 3));

    await expect(hydrateLoopedReviewWorkflow(workflow.id, load)).resolves.toMatchObject({
      phase: "paused",
      backendRevision: 3,
    });
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)).toMatchObject({
      phase: "paused",
      backendRevision: 3,
    });

    const invalidLoad = mock(async () => ({
      ...persisted(authoritative, 4),
      id: "another-workflow",
    }));
    await expect(hydrateLoopedReviewWorkflow(workflow.id, invalidLoad)).resolves.toBeNull();
  });

  test("hydrates only valid workflows belonging to the requested environment", async () => {
    const workflow = createWorkflow();
    const other = { ...workflow, id: "other", environmentId: "env-2" };
    const list = mock(async () => [
      persisted(workflow, 2),
      persisted(other, 2),
      { ...persisted(workflow, 3), id: "mismatch" },
    ]);

    const restored = await hydrateLoopedReviewWorkflowsForEnvironment("env-1", list);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: workflow.id, backendRevision: 2 });
  });

  test("does not replace an unsaved equal-revision transition during hydration", async () => {
    const original = createWorkflow();
    const save = mock(async () => persisted(original, 1));
    const stop = startLoopedReviewPersistence({
      debounceMs: 1_000,
      save,
      load: mock(async () => persisted(original, 0)),
    });

    useLoopedReviewStore.getState().pauseWorkflow(original.id);
    const list = mock(async () => [persisted(original, 0)]);
    const [restored] = await hydrateLoopedReviewWorkflowsForEnvironment("env-1", list);

    expect(restored?.phase).toBe("paused");
    expect(useLoopedReviewStore.getState().workflows.get(original.id)?.phase).toBe("paused");
    stop();
    await settle();
  });

  test("persists immediately and recovers the authoritative winner on conflict", async () => {
    const workflow = createWorkflow();
    const save = mock(async () => persisted(workflow, 1));
    await expect(persistLoopedReviewWorkflowNow(workflow.id, {
      save,
      load: mock(async () => null),
    })).resolves.toMatchObject({ backendRevision: 1 });

    const local = useLoopedReviewStore.getState().workflows.get(workflow.id)!;
    const winner = {
      ...local,
      phase: "paused" as const,
      pausedFromPhase: "preparing" as const,
    };
    await expect(persistLoopedReviewWorkflowNow(workflow.id, {
      save: mock(async () => {
        throw new Error("Looped review workflow revision conflict");
      }),
      load: mock(async () => persisted(winner, 2)),
    })).resolves.toMatchObject({ phase: "paused", backendRevision: 2 });
  });

  test("reports a persistent save outage once without a self-triggering retry loop", async () => {
    createWorkflow();
    const save = mock(async () => {
      throw new Error("storage unavailable");
    });
    const stop = startLoopedReviewPersistence({
      debounceMs: 0,
      save,
      load: mock(async () => null),
    });

    await waitUntil(() => save.mock.calls.length === 2);
    const callsAfterFailure = save.mock.calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(callsAfterFailure).toBe(2);
    expect(save).toHaveBeenCalledTimes(callsAfterFailure);
    expect([...useLoopedReviewStore.getState().workflows.values()][0]).toMatchObject({
      phase: "failed",
      failure: { code: "persistence" },
    });
    stop();
  }, 15_000);

  test("cancels a deleted workflow's pending timer", async () => {
    const workflow = createWorkflow();
    const save = mock(async () => persisted(workflow, 1));
    const stop = startLoopedReviewPersistence({
      debounceMs: 25,
      save,
      load: mock(async () => null),
    });
    useLoopedReviewStore.getState().removeWorkflow(workflow.id);

    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(save).not.toHaveBeenCalled();
    stop();
  });

  test("flushes pending workflows on pagehide", async () => {
    const workflow = createWorkflow();
    const save = mock(async () => persisted(workflow, 1));
    const stop = startLoopedReviewPersistence({
      debounceMs: 10_000,
      save,
      load: mock(async () => null),
    });

    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    stop();
  });
});
