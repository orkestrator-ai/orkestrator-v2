import { beforeEach, describe, expect, test } from "bun:test";
import {
  hydrateLoopedReviewWorkflow,
  hydrateLoopedReviewWorkflowsForEnvironment,
  persistLoopedReviewWorkflowNow,
  registerLoopedReviewControllerFence,
  resolveLoopedReviewWorkflow,
  startLoopedReviewPersistence,
} from "./looped-review-persistence";
import { useLoopedReviewStore } from "@/stores/loopedReviewStore";
import { loopedReviewFixture } from "@/test/looped-review-fixture";

function persisted(workflow = loopedReviewFixture(), revision = workflow.backendRevision) {
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
    const restored = await hydrateLoopedReviewWorkflow(workflow.id, async () =>
      persisted(workflow, 9),
    );
    expect(restored?.backendRevision).toBe(9);
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)?.backendRevision).toBe(9);
  });

  test("rejects a mismatched or malformed envelope", async () => {
    const workflow = loopedReviewFixture();
    await expect(
      hydrateLoopedReviewWorkflow(workflow.id, async () => ({
        ...persisted(workflow),
        id: "other",
      })),
    ).resolves.toBeNull();
    await expect(
      hydrateLoopedReviewWorkflow(workflow.id, async () => ({
        ...persisted(workflow),
        snapshot: { ...workflow, version: 1 } as never,
      })),
    ).resolves.toBeNull();
  });

  test("returns null for a missing record without changing a local projection", async () => {
    const workflow = loopedReviewFixture();
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    await expect(hydrateLoopedReviewWorkflow(workflow.id, async () => null)).resolves.toBeNull();
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)).toBe(workflow);
  });

  test("lists one environment and ignores cross-environment records", async () => {
    const workflow = loopedReviewFixture({ environmentId: "env-a" });
    const other = loopedReviewFixture({ environmentId: "env-b" });
    const restored = await hydrateLoopedReviewWorkflowsForEnvironment("env-a", async () => [
      persisted(workflow, 3),
      persisted(other, 4),
    ]);
    expect(restored.map((entry) => entry.id)).toEqual([workflow.id]);
    expect(useLoopedReviewStore.getState().workflows.has(other.id)).toBe(false);
  });

  test("skips malformed list entries and propagates list failures", async () => {
    const workflow = loopedReviewFixture({ environmentId: "env-a" });
    const restored = await hydrateLoopedReviewWorkflowsForEnvironment("env-a", async () => [
      { ...persisted(workflow), snapshot: { ...workflow, sessions: null } as never },
      persisted(workflow, 4),
    ]);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.backendRevision).toBe(4);

    await expect(
      hydrateLoopedReviewWorkflowsForEnvironment("env-a", async () => {
        throw new Error("list unavailable");
      }),
    ).rejects.toThrow("list unavailable");
  });

  test("list hydration keeps strictly newer local state and replaces equal revisions", async () => {
    const server = loopedReviewFixture({
      environmentId: "env-a",
      backendRevision: 5,
      phase: "paused",
      pausedFromPhase: "fixing",
    });
    useLoopedReviewStore.getState().replaceWorkflow({
      ...server,
      backendRevision: 7,
      phase: "completed",
      pausedFromPhase: undefined,
    });
    let restored = await hydrateLoopedReviewWorkflowsForEnvironment("env-a", async () => [
      persisted(server, 6),
    ]);
    expect(restored[0]?.phase).toBe("completed");

    useLoopedReviewStore.setState({ workflows: new Map() });
    useLoopedReviewStore.getState().replaceWorkflow({ ...server, phase: "fixing" });
    restored = await hydrateLoopedReviewWorkflowsForEnvironment("env-a", async () => [
      persisted(server, 5),
    ]);
    expect(restored[0]?.phase).toBe("paused");
  });

  test("rehydration replaces equal revisions and preserves only a strictly newer snapshot", async () => {
    const server = loopedReviewFixture({
      backendRevision: 5,
      phase: "paused",
      pausedFromPhase: "fixing",
    });
    useLoopedReviewStore.getState().replaceWorkflow({ ...server, phase: "fixing" });
    await hydrateLoopedReviewWorkflow(server.id, async () => persisted(server, 5));
    expect(useLoopedReviewStore.getState().workflows.get(server.id)?.phase).toBe("paused");

    useLoopedReviewStore
      .getState()
      .replaceWorkflow({ ...server, backendRevision: 7, phase: "completed" });
    const kept = await hydrateLoopedReviewWorkflow(server.id, async () => persisted(server, 6));
    expect(kept?.phase).toBe("completed");
  });

  test("renderer persistence compatibility APIs cannot write version-2 state", async () => {
    const unregister = registerLoopedReviewControllerFence("workflow", {
      ownerId: "legacy-renderer",
      token: "legacy-token",
    });
    expect(unregister()).toBeUndefined();
    const stop = startLoopedReviewPersistence();
    stop();
    await expect(persistLoopedReviewWorkflowNow("workflow")).rejects.toThrow(
      "cannot be persisted by the renderer",
    );
  });
});

describe("hydration distinguishes a missing record from an unreadable one", () => {
  beforeEach(() => {
    useLoopedReviewStore.setState({ workflows: new Map() });
  });

  test("reports a genuinely absent record as missing", async () => {
    await expect(resolveLoopedReviewWorkflow("workflow-1", async () => null)).resolves.toEqual({
      status: "missing",
    });
  });

  test("reports a record this build cannot validate as unreadable, not missing", async () => {
    // Only "missing" justifies deleting the projection. A snapshot a newer
    // backend wrote — an added field, a version skew — still exists and is
    // very likely still being advanced.
    const workflow = loopedReviewFixture();
    const entry = persisted(workflow);
    await expect(
      resolveLoopedReviewWorkflow(workflow.id, async () => ({
        ...entry,
        snapshot: { ...workflow, phase: "teleporting" } as never,
      })),
    ).resolves.toEqual({ status: "unreadable" });
  });

  test("treats an id or environment mismatch as unreadable", async () => {
    const workflow = loopedReviewFixture();
    await expect(
      resolveLoopedReviewWorkflow(workflow.id, async () => ({
        ...persisted(workflow),
        id: "a-different-workflow",
      })),
    ).resolves.toEqual({ status: "unreadable" });

    // A snapshot claiming a different environment than the record it is filed
    // under cannot be trusted to belong to either.
    await expect(
      resolveLoopedReviewWorkflow(workflow.id, async () => ({
        ...persisted(workflow),
        snapshot: { ...workflow, environmentId: "another-environment" },
      })),
    ).resolves.toEqual({ status: "unreadable" });
  });

  test("hydrates and stamps the record's revision onto the snapshot", async () => {
    const workflow = loopedReviewFixture({ backendRevision: 1 });
    const result = await resolveLoopedReviewWorkflow(workflow.id, async () =>
      persisted(workflow, 9),
    );
    expect(result).toMatchObject({ status: "hydrated" });
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)?.backendRevision).toBe(9);
  });

  test("keeps a newer local projection when the backend read is behind", async () => {
    const workflow = loopedReviewFixture({ backendRevision: 12, phase: "fixing" });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    const result = await resolveLoopedReviewWorkflow(workflow.id, async () =>
      persisted({ ...workflow, phase: "preparing" }, 3),
    );
    expect(result).toEqual({ status: "hydrated", workflow });
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)?.phase).toBe("fixing");
  });

  test("out-of-order concurrent hydrations converge on the newest revision", async () => {
    const workflow = loopedReviewFixture({ backendRevision: 1 });
    let resolveSlow!: (value: ReturnType<typeof persisted>) => void;
    const slow = new Promise<ReturnType<typeof persisted>>((resolve) => {
      resolveSlow = resolve;
    });

    const stale = resolveLoopedReviewWorkflow(workflow.id, () => slow);
    await resolveLoopedReviewWorkflow(workflow.id, async () => persisted(workflow, 7));
    resolveSlow(persisted(workflow, 2));
    await stale;

    // The store's own revision fence is what makes a late, older response safe.
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)?.backendRevision).toBe(7);
  });

  test("hydrateLoopedReviewWorkflow keeps returning null for both failure shapes", async () => {
    const workflow = loopedReviewFixture();
    await expect(hydrateLoopedReviewWorkflow(workflow.id, async () => null)).resolves.toBeNull();
    await expect(
      hydrateLoopedReviewWorkflow(workflow.id, async () => ({
        ...persisted(workflow),
        snapshot: { ...workflow, version: 1 } as never,
      })),
    ).resolves.toBeNull();
  });
});
