import { beforeEach, describe, expect, test } from "bun:test";
import type { Environment } from "@/types";
import { useEnvironmentStore } from "./environmentStore";
import { useNativeComposeStore } from "./nativeComposeStore";
import { createSessionKey } from "@/lib/utils";

function environment(id: string, overrides: Partial<Environment> = {}): Environment {
  return {
    id,
    projectId: "project-1",
    name: id,
    branch: id,
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    setupPhase: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  useEnvironmentStore.setState({
    environments: [],
    isLoading: false,
    error: null,
    deletingEnvironments: new Set(),
  });
});

describe("environmentStore", () => {
  test("deleting an environment releases retained image prompts for every tab", () => {
    useNativeComposeStore.setState({ sentPrompts: new Map() });
    for (const [envId, tabId] of [
      ["deleted", "a"],
      ["deleted", "b"],
      ["other", "c"],
    ]) {
      const key = createSessionKey(envId!, tabId!);
      useNativeComposeStore.getState().recordSentPrompt(key, {
        prompt: "Image prompt",
        providerSessionId: tabId,
        draft: { text: "Image prompt", mentions: [], annotations: [] },
        attachments: [
          {
            id: "image",
            type: "image",
            path: "/image.png",
            name: "image.png",
            previewUrl: "data:image/png;base64,cG5n",
          },
        ],
        priorMessageIds: new Set(),
      });
    }
    useEnvironmentStore.getState().removeEnvironment("deleted");
    expect([...useNativeComposeStore.getState().sentPrompts.keys()]).toEqual([
      createSessionKey("other", "c"),
    ]);
    useNativeComposeStore.setState({ sentPrompts: new Map() });
  });
  test("sorts snapshots while preserving authoritative setup fields", () => {
    useEnvironmentStore
      .getState()
      .setEnvironments([
        environment("second", { order: 2, setupPhase: "failed" }),
        environment("first", { order: 1, setupPhase: "ready", setupOverride: true }),
      ]);

    expect(useEnvironmentStore.getState().environments.map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
    expect(useEnvironmentStore.getState().getEnvironmentById("first")).toMatchObject({
      setupPhase: "ready",
      setupOverride: true,
    });
  });

  test("merges one project without replacing other project snapshots", () => {
    const other = environment("other", { projectId: "project-2" });
    useEnvironmentStore.getState().setEnvironments([environment("old"), other]);

    useEnvironmentStore
      .getState()
      .mergeEnvironmentsForProject("project-1", [environment("new", { setupPhase: "running" })]);

    expect(useEnvironmentStore.getState().environments).toEqual([
      other,
      environment("new", { setupPhase: "running" }),
    ]);
  });

  test("adds environments in display order and selects one project's entries", () => {
    useEnvironmentStore
      .getState()
      .setEnvironments([
        environment("late", { order: 3 }),
        environment("other", { projectId: "project-2", order: 0 }),
      ]);

    useEnvironmentStore.getState().addEnvironment(environment("early", { order: 1 }));

    expect(useEnvironmentStore.getState().environments.map((item) => item.id)).toEqual([
      "other",
      "early",
      "late",
    ]);
    expect(
      useEnvironmentStore
        .getState()
        .getEnvironmentsByProjectId("project-1")
        .map((item) => item.id),
    ).toEqual(["early", "late"]);
  });

  test("applies setup transitions and skips byte-identical updates", () => {
    useEnvironmentStore
      .getState()
      .setEnvironments([environment("env-1", { setupPhase: "running" })]);
    const before = useEnvironmentStore.getState();

    useEnvironmentStore.getState().updateEnvironment("env-1", {
      setupPhase: "running",
    });
    expect(useEnvironmentStore.getState()).toBe(before);

    useEnvironmentStore.getState().updateEnvironment("env-1", {
      setupPhase: "failed",
      setupScriptsComplete: false,
    });
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")).toMatchObject({
      setupPhase: "failed",
      setupScriptsComplete: false,
    });

    useEnvironmentStore.getState().addEnvironment(environment("env-2", { order: 2 }));
    useEnvironmentStore.getState().updateEnvironment("env-2", { order: -1 });
    expect(useEnvironmentStore.getState().environments.map((item) => item.id)).toEqual([
      "env-2",
      "env-1",
    ]);
  });

  test("updates lifecycle, pull request, loading, and error projections", () => {
    useEnvironmentStore.getState().setEnvironments([environment("env-1")]);

    useEnvironmentStore.getState().updateEnvironmentStatus("env-1", "running");
    useEnvironmentStore
      .getState()
      .setEnvironmentPR("env-1", "https://example.test/pull/1", "open", true);
    useEnvironmentStore.getState().setLoading(true);
    useEnvironmentStore.getState().setError("snapshot unavailable");

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")).toMatchObject({
      status: "running",
      prUrl: "https://example.test/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    expect(useEnvironmentStore.getState()).toMatchObject({
      isLoading: true,
      error: "snapshot unavailable",
    });
  });

  test("PR updates retain mergeability only for the same PR", () => {
    const oldUrl = "https://example.test/pull/1";
    const newUrl = "https://example.test/pull/2";
    useEnvironmentStore
      .getState()
      .setEnvironments([
        environment("env-1", { prUrl: oldUrl, prState: "open", prMergeability: "clean" }),
      ]);
    useEnvironmentStore.getState().setEnvironmentPR("env-1", oldUrl, "open", false);
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.prMergeability).toBe(
      "clean",
    );
    useEnvironmentStore.getState().setEnvironmentPR("env-1", newUrl, "open", false);
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")).toMatchObject({
      prUrl: newUrl,
      prMergeability: null,
    });
    useEnvironmentStore.getState().updateEnvironment("env-1", { prMergeability: "clean" });
    useEnvironmentStore.getState().setEnvironmentPR("env-1", null, null);
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.prMergeability).toBeNull();
  });

  test("reorders only the selected project and ignores unknown ids", () => {
    const other = environment("other", { projectId: "project-2", order: 4 });
    useEnvironmentStore
      .getState()
      .setEnvironments([
        environment("first", { order: 0 }),
        environment("second", { order: 1 }),
        other,
      ]);

    useEnvironmentStore.getState().reorderEnvironments("project-1", ["second", "missing", "first"]);

    expect(useEnvironmentStore.getState().environments).toEqual([
      other,
      environment("second", { order: 0 }),
      environment("first", { order: 2 }),
    ]);
  });

  test("treats persisted deletion state as authoritative", () => {
    useEnvironmentStore
      .getState()
      .setEnvironments([
        environment("operation", { lifecycleOperation: "deleting" }),
        environment("requested", { deletionRequestedAt: "2026-08-04T01:00:00.000Z" }),
        environment("live"),
      ]);

    expect(useEnvironmentStore.getState().isDeleting("operation")).toBe(true);
    expect(useEnvironmentStore.getState().isDeleting("requested")).toBe(true);
    expect(useEnvironmentStore.getState().isDeleting("live")).toBe(false);

    useEnvironmentStore.getState().setDeleting("live", true);
    expect(useEnvironmentStore.getState().isDeleting("live")).toBe(true);
    useEnvironmentStore.getState().removeEnvironment("live");
    expect(useEnvironmentStore.getState().isDeleting("live")).toBe(false);
  });
});
