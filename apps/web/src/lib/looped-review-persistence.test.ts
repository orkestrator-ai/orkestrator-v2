import { beforeEach, describe, expect, test } from "bun:test";
import {
  hydrateLoopedReviewWorkflow,
  hydrateLoopedReviewWorkflowsForEnvironment,
  persistLoopedReviewWorkflowNow,
  startLoopedReviewPersistence,
} from "./looped-review-persistence";
import { useLoopedReviewStore } from "@/stores/loopedReviewStore";
import { loopedReviewFixture } from "@/test/looped-review-fixture";

function persisted(
  workflow = loopedReviewFixture(),
  revision = workflow.backendRevision,
) {
  return {
    version: workflow.version,
    id: workflow.id,
    environmentId: workflow.environmentId,
    snapshot: workflow,
    updatedAt: workflow.updatedAt,
    revision,
  };
}

describe("looped-review authoritative hydration", () => {
  beforeEach(() => {
    useLoopedReviewStore.setState({ workflows: new Map() });
  });

  test("hydrates one workflow and projects the envelope revision", async () => {
    const workflow = loopedReviewFixture({ backendRevision: 0 });
    const restored = await hydrateLoopedReviewWorkflow(
      workflow.id,
      async () => persisted(workflow, 9),
    );
    expect(restored?.backendRevision).toBe(9);
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)?.backendRevision).toBe(9);
  });

  test("rejects a mismatched or malformed envelope", async () => {
    const workflow = loopedReviewFixture();
    await expect(hydrateLoopedReviewWorkflow(
      workflow.id,
      async () => ({ ...persisted(workflow), id: "other" }),
    )).resolves.toBeNull();
    await expect(hydrateLoopedReviewWorkflow(
      workflow.id,
      async () => ({ ...persisted(workflow), snapshot: { ...workflow, version: 1 } as never }),
    )).resolves.toBeNull();
  });

  test("lists one environment and ignores cross-environment records", async () => {
    const workflow = loopedReviewFixture({ environmentId: "env-a" });
    const other = loopedReviewFixture({ environmentId: "env-b" });
    const restored = await hydrateLoopedReviewWorkflowsForEnvironment(
      "env-a",
      async () => [persisted(workflow, 3), persisted(other, 4)],
    );
    expect(restored.map((entry) => entry.id)).toEqual([workflow.id]);
    expect(useLoopedReviewStore.getState().workflows.has(other.id)).toBe(false);
  });

  test("rehydration replaces equal revisions and preserves only a strictly newer snapshot", async () => {
    const server = loopedReviewFixture({ backendRevision: 5, phase: "paused", pausedFromPhase: "fixing" });
    useLoopedReviewStore.getState().replaceWorkflow({ ...server, phase: "fixing" });
    await hydrateLoopedReviewWorkflow(server.id, async () => persisted(server, 5));
    expect(useLoopedReviewStore.getState().workflows.get(server.id)?.phase).toBe("paused");

    useLoopedReviewStore.getState().replaceWorkflow({ ...server, backendRevision: 7, phase: "completed" });
    const kept = await hydrateLoopedReviewWorkflow(server.id, async () => persisted(server, 6));
    expect(kept?.phase).toBe("completed");
  });

  test("renderer persistence compatibility APIs cannot write version-2 state", async () => {
    const stop = startLoopedReviewPersistence();
    stop();
    await expect(persistLoopedReviewWorkflowNow("workflow")).rejects.toThrow(
      "cannot be persisted by the renderer",
    );
  });
});
