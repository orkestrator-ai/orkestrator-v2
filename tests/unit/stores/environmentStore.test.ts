import { describe, test, expect, beforeEach } from "bun:test";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
import type { Environment } from "../../../apps/web/src/types";

const createEnvironment = (overrides: Partial<Environment> = {}): Environment => ({
  id: "env-1",
  projectId: "project-1",
  name: "test-repo-20260106",
  branch: "main",
  containerId: null,
  status: "stopped",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: new Date().toISOString(),
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "containerized",
  ...overrides,
});

describe("environmentStore", () => {
  beforeEach(() => {
    // Reset store between tests
    useEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
      deletingEnvironments: new Set<string>(),
    });
  });

  test("initial state is empty", () => {
    const state = useEnvironmentStore.getState();
    expect(state.environments).toEqual([]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  test("addEnvironment adds an environment to the store", () => {
    const env = createEnvironment();

    useEnvironmentStore.getState().addEnvironment(env);

    const state = useEnvironmentStore.getState();
    expect(state.environments).toHaveLength(1);
    expect(state.environments[0]).toEqual(env);
  });

  test("updateEnvironmentStatus updates the status", () => {
    const env = createEnvironment();

    useEnvironmentStore.getState().addEnvironment(env);
    useEnvironmentStore.getState().updateEnvironmentStatus("env-1", "running");

    const state = useEnvironmentStore.getState();
    expect(state.environments[0]?.status).toBe("running");
  });

  test("setEnvironmentPR sets the PR URL", () => {
    const env = createEnvironment({ status: "running" });

    useEnvironmentStore.getState().addEnvironment(env);
    useEnvironmentStore
      .getState()
      .setEnvironmentPR("env-1", "https://github.com/test/repo/pull/123", "open");

    const state = useEnvironmentStore.getState();
    expect(state.environments[0]?.prUrl).toBe(
      "https://github.com/test/repo/pull/123"
    );
  });

  test("getEnvironmentsByProjectId returns only matching environments", () => {
    const env1 = createEnvironment({ id: "env-1", projectId: "project-1", name: "test-repo-1" });
    const env2 = createEnvironment({ id: "env-2", projectId: "project-2", name: "test-repo-2" });
    const env3 = createEnvironment({ id: "env-3", projectId: "project-1", name: "test-repo-3" });

    useEnvironmentStore.getState().addEnvironment(env1);
    useEnvironmentStore.getState().addEnvironment(env2);
    useEnvironmentStore.getState().addEnvironment(env3);

    const projectEnvs = useEnvironmentStore
      .getState()
      .getEnvironmentsByProjectId("project-1");
    expect(projectEnvs).toHaveLength(2);
    expect(projectEnvs.map((e) => e.id)).toEqual(["env-1", "env-3"]);
  });

  test("removeEnvironment removes the correct environment", () => {
    const env1 = createEnvironment({ id: "env-1", projectId: "project-1", name: "test-repo-1" });
    const env2 = createEnvironment({ id: "env-2", projectId: "project-1", name: "test-repo-2" });

    useEnvironmentStore.getState().addEnvironment(env1);
    useEnvironmentStore.getState().addEnvironment(env2);
    useEnvironmentStore.getState().removeEnvironment("env-1");

    const state = useEnvironmentStore.getState();
    expect(state.environments).toHaveLength(1);
    expect(state.environments[0]?.id).toBe("env-2");
  });

  test("isDeleting rehydrates from backend lifecycle and tombstone fields", () => {
    const store = useEnvironmentStore.getState();
    store.setEnvironments([
      createEnvironment({ id: "live" }),
      createEnvironment({ id: "operation", lifecycleOperation: "deleting" }),
      createEnvironment({
        id: "tombstone",
        deletionRequestedAt: "2026-07-28T12:00:00.000Z",
      }),
    ]);

    expect(store.isDeleting("live")).toBe(false);
    expect(store.isDeleting("operation")).toBe(true);
    expect(store.isDeleting("tombstone")).toBe(true);

    store.setDeleting("live", true);
    expect(store.isDeleting("live")).toBe(true);
  });

  test("setEnvironments preserves authoritative setup lifecycle fields", () => {
    const completeLocal = createEnvironment({
      id: "env-complete-local",
      environmentType: "local",
      setupScriptsComplete: true,
      setupPhase: "ready",
    });
    const completeContainer = createEnvironment({
      id: "env-complete-container",
      environmentType: "containerized",
      setupScriptsComplete: true,
      setupPhase: "ready",
    });
    const incomplete = createEnvironment({
      id: "env-incomplete",
      environmentType: "local",
      setupScriptsComplete: false,
      setupPhase: "running",
    });

    useEnvironmentStore
      .getState()
      .setEnvironments([completeLocal, completeContainer, incomplete]);

    const state = useEnvironmentStore.getState();
    expect(state.getEnvironmentById("env-complete-local")).toMatchObject({
      setupScriptsComplete: true,
      setupPhase: "ready",
    });
    expect(state.getEnvironmentById("env-complete-container")).toMatchObject({
      setupScriptsComplete: true,
      setupPhase: "ready",
    });
    expect(state.getEnvironmentById("env-incomplete")).toMatchObject({
      setupScriptsComplete: false,
      setupPhase: "running",
    });
  });

  test("addEnvironment keeps the backend-owned setup phase", () => {
    const env = createEnvironment({
      id: "env-complete",
      environmentType: "local",
      setupScriptsComplete: true,
      setupPhase: "ready",
    });

    useEnvironmentStore.getState().addEnvironment(env);

    expect(useEnvironmentStore.getState().getEnvironmentById("env-complete"))
      .toMatchObject({ setupScriptsComplete: true, setupPhase: "ready" });
  });

  test("mergeEnvironmentsForProject installs authoritative setup state from snapshots", () => {
    const env = createEnvironment({
      id: "env-complete",
      projectId: "project-1",
      environmentType: "local",
      setupScriptsComplete: true,
      setupPhase: "ready",
    });

    useEnvironmentStore
      .getState()
      .mergeEnvironmentsForProject("project-1", [env]);

    expect(useEnvironmentStore.getState().getEnvironmentById("env-complete"))
      .toMatchObject({ setupScriptsComplete: true, setupPhase: "ready" });
  });

  test("mergeEnvironmentsForProject preserves state and object identity for an unchanged snapshot", () => {
    const env = createEnvironment({ id: "env-1", projectId: "project-1" });
    const store = useEnvironmentStore.getState();
    store.setEnvironments([env]);
    const beforeState = useEnvironmentStore.getState();
    const beforeEnvironment = beforeState.environments[0];

    store.mergeEnvironmentsForProject("project-1", [{ ...env }]);

    const afterState = useEnvironmentStore.getState();
    expect(afterState).toBe(beforeState);
    expect(afterState.environments[0]).toBe(beforeEnvironment);
  });

  test("setEnvironments replaces stale ready setup state with a newer failed snapshot", () => {
    const complete = createEnvironment({
      id: "env-1",
      setupScriptsComplete: true,
      setupPhase: "ready",
    });
    const incomplete = createEnvironment({
      id: "env-1",
      setupScriptsComplete: false,
      setupPhase: "failed",
    });

    const store = useEnvironmentStore.getState();
    store.setEnvironments([complete]);
    store.setEnvironments([incomplete]);

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1"))
      .toMatchObject({ setupScriptsComplete: false, setupPhase: "failed" });
  });

  test("updateEnvironment applies setupScriptsComplete and setupPhase atomically", () => {
    const store = useEnvironmentStore.getState();
    store.addEnvironment(createEnvironment({
      id: "env-1",
      setupScriptsComplete: true,
      setupPhase: "ready",
    }));

    store.updateEnvironment("env-1", {
      setupScriptsComplete: false,
      setupPhase: "running",
    });

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1"))
      .toMatchObject({ setupScriptsComplete: false, setupPhase: "running" });
  });

  test("updateEnvironment preserves setup state when unrelated fields change", () => {
    const store = useEnvironmentStore.getState();
    store.addEnvironment(createEnvironment({
      id: "env-1",
      setupScriptsComplete: false,
      setupPhase: "failed",
    }));

    store.updateEnvironment("env-1", { name: "renamed" });

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1"))
      .toMatchObject({
        name: "renamed",
        setupScriptsComplete: false,
        setupPhase: "failed",
      });
  });

  test("updateEnvironment applies the authoritative running-to-ready transition", () => {
    const store = useEnvironmentStore.getState();
    store.addEnvironment(createEnvironment({
      id: "env-1",
      setupScriptsComplete: false,
      setupPhase: "running",
    }));

    store.updateEnvironment("env-1", {
      setupScriptsComplete: true,
      setupPhase: "ready",
    });

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1"))
      .toMatchObject({ setupScriptsComplete: true, setupPhase: "ready" });
  });

  test("updateEnvironment is a no-op for identical partial updates and missing environments", () => {
    const store = useEnvironmentStore.getState();
    store.addEnvironment(createEnvironment({ id: "env-1", name: "unchanged" }));
    const before = useEnvironmentStore.getState();

    store.updateEnvironment("env-1", { name: "unchanged" });
    expect(useEnvironmentStore.getState()).toBe(before);

    store.updateEnvironment("missing", { name: "ignored" });
    expect(useEnvironmentStore.getState()).toBe(before);
  });

  test("updateEnvironment preserves order for non-order changes and re-sorts order changes", () => {
    const store = useEnvironmentStore.getState();
    store.setEnvironments([
      createEnvironment({ id: "env-1", order: 0 }),
      createEnvironment({ id: "env-2", order: 1 }),
    ]);
    const secondBefore = useEnvironmentStore.getState().environments[1];

    store.updateEnvironment("env-1", { name: "renamed" });
    let state = useEnvironmentStore.getState();
    expect(state.environments.map((environment) => environment.id)).toEqual([
      "env-1",
      "env-2",
    ]);
    expect(state.environments[1]).toBe(secondBefore);

    store.updateEnvironment("env-1", { order: 2 });
    state = useEnvironmentStore.getState();
    expect(state.environments.map((environment) => environment.id)).toEqual([
      "env-2",
      "env-1",
    ]);
  });

  test("removeEnvironment clears renderer-local deletion state", () => {
    const store = useEnvironmentStore.getState();
    store.addEnvironment(createEnvironment({ id: "env-1" }));
    store.setDeleting("env-1", true);

    store.removeEnvironment("env-1");
    expect(useEnvironmentStore.getState().deletingEnvironments.has("env-1")).toBe(false);
  });
});
