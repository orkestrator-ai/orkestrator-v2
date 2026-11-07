import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { StoreApi } from "zustand/vanilla";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import type { Environment } from "@/types";
import { environmentStore, type EnvironmentState } from "./environmentStore";

const NODE_A = "bk_environment-store-a" as BackendId;
const NODE_B = "bk_environment-store-b" as BackendId;

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

let windowScope: WindowScope;
/** NODE_A's instance; the tests name their scope, as converted code does. */
let environments: StoreApi<EnvironmentState>;

beforeEach(() => {
  windowScope = new WindowScope();
  environments = windowScope
    .open({ role: "command", client: new FakeNodeClient({ nodeId: NODE_A }) })
    .store(environmentStore);
});

afterEach(() => windowScope.dispose());

describe("environmentStore", () => {
  test("repeated status and PR updates retain the environment array and unchanged rows", () => {
    const store = environments.getState();
    store.setEnvironments([environment("one"), environment("two")]);
    const initial = environments.getState().environments;
    for (let i = 0; i < 3; i++) {
      store.updateEnvironmentStatus("one", "stopped");
      store.setEnvironmentPR("one", null, null);
      expect(environments.getState().environments).toBe(initial);
    }
    store.updateEnvironmentStatus("one", "running");
    const changed = environments.getState().environments;
    expect(changed).not.toBe(initial);
    expect(changed[1]).toBe(initial[1]);
    store.updateEnvironmentStatus("one", "running");
    expect(environments.getState().environments).toBe(changed);
    store.setEnvironmentPR("one", "https://example.test/pr/1", "open", false);
    const withPR = environments.getState().environments;
    expect(withPR).not.toBe(changed);
    expect(withPR[1]).toBe(initial[1]);
    for (let i = 0; i < 3; i++) {
      store.setEnvironmentPR("one", "https://example.test/pr/1", "open", false);
      expect(environments.getState().environments).toBe(withPR);
    }
  });

  test("sorts snapshots while preserving authoritative setup fields", () => {
    environments
      .getState()
      .setEnvironments([
        environment("second", { order: 2, setupPhase: "failed" }),
        environment("first", { order: 1, setupPhase: "ready", setupOverride: true }),
      ]);

    expect(environments.getState().environments.map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
    expect(environments.getState().getEnvironmentById("first")).toMatchObject({
      setupPhase: "ready",
      setupOverride: true,
    });
  });

  test("merges one project without replacing other project snapshots", () => {
    const other = environment("other", { projectId: "project-2" });
    environments.getState().setEnvironments([environment("old"), other]);

    environments
      .getState()
      .mergeEnvironmentsForProject("project-1", [environment("new", { setupPhase: "running" })]);

    expect(environments.getState().environments).toEqual([
      other,
      environment("new", { setupPhase: "running" }),
    ]);
  });

  test("adds environments in display order and selects one project's entries", () => {
    environments
      .getState()
      .setEnvironments([
        environment("late", { order: 3 }),
        environment("other", { projectId: "project-2", order: 0 }),
      ]);

    environments.getState().addEnvironment(environment("early", { order: 1 }));

    expect(environments.getState().environments.map((item) => item.id)).toEqual([
      "other",
      "early",
      "late",
    ]);
    expect(
      environments
        .getState()
        .getEnvironmentsByProjectId("project-1")
        .map((item) => item.id),
    ).toEqual(["early", "late"]);
  });

  test("applies setup transitions and skips byte-identical updates", () => {
    environments.getState().setEnvironments([environment("env-1", { setupPhase: "running" })]);
    const before = environments.getState();

    environments.getState().updateEnvironment("env-1", {
      setupPhase: "running",
    });
    expect(environments.getState()).toBe(before);

    environments.getState().updateEnvironment("env-1", {
      setupPhase: "failed",
      setupScriptsComplete: false,
    });
    expect(environments.getState().getEnvironmentById("env-1")).toMatchObject({
      setupPhase: "failed",
      setupScriptsComplete: false,
    });

    environments.getState().addEnvironment(environment("env-2", { order: 2 }));
    environments.getState().updateEnvironment("env-2", { order: -1 });
    expect(environments.getState().environments.map((item) => item.id)).toEqual(["env-2", "env-1"]);
  });

  test("updates lifecycle, pull request, loading, and error projections", () => {
    environments.getState().setEnvironments([environment("env-1")]);

    environments.getState().updateEnvironmentStatus("env-1", "running");
    environments.getState().setEnvironmentPR("env-1", "https://example.test/pull/1", "open", true);
    environments.getState().setLoading(true);
    environments.getState().setError("snapshot unavailable");

    expect(environments.getState().getEnvironmentById("env-1")).toMatchObject({
      status: "running",
      prUrl: "https://example.test/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    expect(environments.getState()).toMatchObject({
      isLoading: true,
      error: "snapshot unavailable",
    });
  });

  test("PR updates retain mergeability only for the same PR", () => {
    const oldUrl = "https://example.test/pull/1";
    const newUrl = "https://example.test/pull/2";
    environments
      .getState()
      .setEnvironments([
        environment("env-1", { prUrl: oldUrl, prState: "open", prMergeability: "clean" }),
      ]);
    environments.getState().setEnvironmentPR("env-1", oldUrl, "open", false);
    expect(environments.getState().getEnvironmentById("env-1")?.prMergeability).toBe("clean");
    environments.getState().setEnvironmentPR("env-1", newUrl, "open", false);
    expect(environments.getState().getEnvironmentById("env-1")).toMatchObject({
      prUrl: newUrl,
      prMergeability: null,
    });
    environments.getState().updateEnvironment("env-1", { prMergeability: "clean" });
    environments.getState().setEnvironmentPR("env-1", null, null);
    expect(environments.getState().getEnvironmentById("env-1")?.prMergeability).toBeNull();
  });

  test("reorders only the selected project and ignores unknown ids", () => {
    const other = environment("other", { projectId: "project-2", order: 4 });
    environments
      .getState()
      .setEnvironments([
        environment("first", { order: 0 }),
        environment("second", { order: 1 }),
        other,
      ]);

    environments.getState().reorderEnvironments("project-1", ["second", "missing", "first"]);

    expect(environments.getState().environments).toEqual([
      other,
      environment("second", { order: 0 }),
      environment("first", { order: 2 }),
    ]);
  });

  test("treats persisted deletion state as authoritative", () => {
    environments
      .getState()
      .setEnvironments([
        environment("operation", { lifecycleOperation: "deleting" }),
        environment("requested", { deletionRequestedAt: "2026-08-04T01:00:00.000Z" }),
        environment("live"),
      ]);

    expect(environments.getState().isDeleting("operation")).toBe(true);
    expect(environments.getState().isDeleting("requested")).toBe(true);
    expect(environments.getState().isDeleting("live")).toBe(false);

    environments.getState().setDeleting("live", true);
    expect(environments.getState().isDeleting("live")).toBe(true);
    environments.getState().removeEnvironment("live");
    expect(environments.getState().isDeleting("live")).toBe(false);
  });

  test("a failed tombstone stays unavailable and retry starts a fresh attempt", () => {
    environments.getState().setEnvironments([
      environment("failed", {
        lifecycleOperation: "deleting",
        deletionRequestedAt: "2026-11-05T12:00:00.000Z",
        deletionError: "Terminal process trees are still running",
      }),
    ]);
    expect(environments.getState().isDeleting("failed")).toBe(true);
    environments.getState().setDeleting("failed", true);
    expect(environments.getState().isDeleting("failed")).toBe(true);
    expect(environments.getState().deletingStartedAt.get("failed")).toBeDefined();
    environments.getState().setDeleting("failed", false);
    expect(environments.getState().deletingStartedAt.has("failed")).toBe(false);
    expect(environments.getState().isDeleting("failed")).toBe(true);
  });
});

describe("snapshots keep what did not change", () => {
  const nested = () => ({ defaultAgent: "codex" as const });

  test("one changed environment leaves the project's others untouched", () => {
    const store = environments.getState();
    store.setEnvironments([
      environment("a", { order: 0, agentSettings: nested() }),
      environment("b", { order: 1, agentSettings: nested() }),
    ]);
    const [a, b] = environments.getState().environments;

    store.mergeEnvironmentsForProject("project-1", [
      environment("a", { order: 0, agentSettings: nested(), status: "running" }),
      environment("b", { order: 1, agentSettings: nested() }),
    ]);

    const [nextA, nextB] = environments.getState().environments;
    expect(nextB).toBe(b!);
    expect(nextA).not.toBe(a!);
    expect(nextA!.status).toBe("running");
    // The changed environment's other fields keep their identity too.
    expect(nextA!.agentSettings).toBe(a!.agentSettings!);
  });

  test("a resync with nothing new publishes nothing", () => {
    const store = environments.getState();
    store.setEnvironments([environment("a", { agentSettings: nested() })]);
    const before = environments.getState();
    store.setEnvironments([environment("a", { agentSettings: nested() })]);
    expect(environments.getState()).toBe(before);
  });

  test("a removed field is removed, not carried over", () => {
    const store = environments.getState();
    store.setEnvironments([environment("a", { agentSettings: nested() })]);
    store.mergeEnvironmentsForProject("project-1", [environment("a")]);
    expect(environments.getState().environments[0]!.agentSettings).toBeUndefined();
  });

  test("an update with an equal nested value keeps its identity", () => {
    const store = environments.getState();
    store.setEnvironments([environment("a", { agentSettings: nested() })]);
    const before = environments.getState().environments[0]!;
    store.updateEnvironment("a", { agentSettings: nested(), status: "running" });
    expect(environments.getState().environments[0]!.agentSettings).toBe(before.agentSettings!);
  });
});

describe("environmentStore per node", () => {
  test("two scopes holding the same environment id do not collide", () => {
    const leaf = windowScope
      .open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) })
      .store(environmentStore);
    expect(leaf).not.toBe(environments);

    // Environment ids are node-local: both nodes have an `env-1`.
    environments.getState().setEnvironments([environment("env-1", { name: "on-a" })]);
    leaf.getState().setEnvironments([environment("env-1", { name: "on-b" })]);
    expect(environments.getState().getEnvironmentById("env-1")?.name).toBe("on-a");
    expect(leaf.getState().getEnvironmentById("env-1")?.name).toBe("on-b");

    leaf.getState().updateEnvironmentStatus("env-1", "running");
    leaf.getState().setDeleting("env-1", true);
    expect(environments.getState().getEnvironmentById("env-1")?.status).toBe("stopped");
    expect(environments.getState().isDeleting("env-1")).toBe(false);

    leaf.getState().removeEnvironment("env-1");
    expect(leaf.getState().environments).toEqual([]);
    expect(environments.getState().getEnvironmentById("env-1")?.name).toBe("on-a");
  });

  test("a disposed scope drops its environments; the other node keeps its own", () => {
    const leafScope = windowScope.open({
      role: "leaf",
      client: new FakeNodeClient({ nodeId: NODE_B }),
    });
    leafScope
      .store(environmentStore)
      .getState()
      .setEnvironments([environment("env-1")]);
    environments.getState().setEnvironments([environment("env-1")]);

    leafScope.dispose();

    expect(environments.getState().environments.map(({ id }) => id)).toEqual(["env-1"]);
    const reopened = windowScope.open({
      role: "leaf",
      client: new FakeNodeClient({ nodeId: NODE_B }),
    });
    expect(reopened.store(environmentStore).getState().environments).toEqual([]);
  });
});
