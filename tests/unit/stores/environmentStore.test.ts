import { describe, test, expect, beforeEach } from "bun:test";
import { useEnvironmentStore } from "../../../src/stores/environmentStore";
import type { Environment } from "../../../src/types";

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
      workspaceReadyEnvironments: new Set<string>(),
      deletingEnvironments: new Set<string>(),
      pendingSetupCommands: new Map<string, string[]>(),
      setupCommandsResolved: new Set<string>(),
      setupScriptsRunning: new Set<string>(),
      sessionActivated: new Set<string>(),
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

  test("setSetupCommandsResolved is idempotent when already resolved", () => {
    const store = useEnvironmentStore.getState();

    store.setSetupCommandsResolved("env-1", true);
    const firstSetRef = useEnvironmentStore.getState().setupCommandsResolved;

    store.setSetupCommandsResolved("env-1", true);
    const secondSetRef = useEnvironmentStore.getState().setupCommandsResolved;

    expect(firstSetRef).toBe(secondSetRef);
    expect(secondSetRef.has("env-1")).toBe(true);
  });

  test("setSetupCommandsResolved is idempotent when already unresolved", () => {
    const store = useEnvironmentStore.getState();
    const firstSetRef = useEnvironmentStore.getState().setupCommandsResolved;

    store.setSetupCommandsResolved("env-1", false);
    const secondSetRef = useEnvironmentStore.getState().setupCommandsResolved;

    expect(firstSetRef).toBe(secondSetRef);
    expect(secondSetRef.has("env-1")).toBe(false);
  });

  test("setEnvironments hydrates readiness sets from setupScriptsComplete", () => {
    const completeLocal = createEnvironment({
      id: "env-complete-local",
      environmentType: "local",
      setupScriptsComplete: true,
    });
    const completeContainer = createEnvironment({
      id: "env-complete-container",
      environmentType: "containerized",
      setupScriptsComplete: true,
    });
    const incomplete = createEnvironment({
      id: "env-incomplete",
      environmentType: "local",
      setupScriptsComplete: false,
    });

    useEnvironmentStore
      .getState()
      .setEnvironments([completeLocal, completeContainer, incomplete]);

    const state = useEnvironmentStore.getState();
    expect(state.setupCommandsResolved.has("env-complete-local")).toBe(true);
    expect(state.workspaceReadyEnvironments.has("env-complete-container")).toBe(
      true
    );
    expect(state.setupCommandsResolved.has("env-incomplete")).toBe(false);
    expect(state.workspaceReadyEnvironments.has("env-incomplete")).toBe(false);
  });

  test("addEnvironment hydrates readiness sets when setupScriptsComplete is true", () => {
    const env = createEnvironment({
      id: "env-complete",
      environmentType: "local",
      setupScriptsComplete: true,
    });

    useEnvironmentStore.getState().addEnvironment(env);

    const state = useEnvironmentStore.getState();
    expect(state.setupCommandsResolved.has("env-complete")).toBe(true);
    expect(state.workspaceReadyEnvironments.has("env-complete")).toBe(true);
  });

  test("mergeEnvironmentsForProject hydrates readiness from newly merged envs", () => {
    const env = createEnvironment({
      id: "env-complete",
      projectId: "project-1",
      environmentType: "local",
      setupScriptsComplete: true,
    });

    useEnvironmentStore
      .getState()
      .mergeEnvironmentsForProject("project-1", [env]);

    const state = useEnvironmentStore.getState();
    expect(state.setupCommandsResolved.has("env-complete")).toBe(true);
  });

  test("setEnvironments clears stale hydrated readiness when setupScriptsComplete becomes false", () => {
    const complete = createEnvironment({ id: "env-1", setupScriptsComplete: true });
    const incomplete = createEnvironment({ id: "env-1", setupScriptsComplete: false });

    const store = useEnvironmentStore.getState();
    store.setEnvironments([complete]);
    store.setEnvironments([incomplete]);

    const state = useEnvironmentStore.getState();
    expect(state.setupCommandsResolved.has("env-1")).toBe(false);
    expect(state.workspaceReadyEnvironments.has("env-1")).toBe(false);
  });

  test("updateEnvironment treats setupScriptsComplete as authoritative when false", () => {
    const store = useEnvironmentStore.getState();
    store.addEnvironment(createEnvironment({ id: "env-1", setupScriptsComplete: true }));

    store.updateEnvironment("env-1", { setupScriptsComplete: false });

    const state = useEnvironmentStore.getState();
    expect(state.setupCommandsResolved.has("env-1")).toBe(false);
    expect(state.workspaceReadyEnvironments.has("env-1")).toBe(false);
  });

  test("updateEnvironment does not clobber runtime workspaceReady when setupScriptsComplete is unchanged", () => {
    // Reproduces the bug where callers pass full env objects from the backend
    // (e.g. updateEnvironmentAgentSettings, getEnvironment refresh) that carry
    // setupScriptsComplete: false as an unchanged passenger. Without the fix,
    // these calls clear the workspaceReady flag that was just flipped true by
    // in-memory setup-complete detection, re-showing the "waiting" overlay.
    const store = useEnvironmentStore.getState();
    store.addEnvironment(createEnvironment({ id: "env-1", setupScriptsComplete: false }));
    store.setWorkspaceReady("env-1", true);

    store.updateEnvironment("env-1", {
      name: "renamed",
      setupScriptsComplete: false,
    });

    const state = useEnvironmentStore.getState();
    expect(state.workspaceReadyEnvironments.has("env-1")).toBe(true);
  });

  test("updateEnvironment populates readiness sets when setupScriptsComplete transitions false→true", () => {
    // Guards the positive side of the passenger-value fix: a genuine
    // false→true transition (e.g. backend persisted setup complete) must
    // still hydrate the runtime readiness sets.
    const store = useEnvironmentStore.getState();
    store.addEnvironment(createEnvironment({ id: "env-1", setupScriptsComplete: false }));

    store.updateEnvironment("env-1", { setupScriptsComplete: true });

    const state = useEnvironmentStore.getState();
    expect(state.setupCommandsResolved.has("env-1")).toBe(true);
    expect(state.workspaceReadyEnvironments.has("env-1")).toBe(true);
  });

  test("consumePendingSetupCommands returns and clears pending commands", () => {
    const store = useEnvironmentStore.getState();

    store.setPendingSetupCommands("env-1", ["bun install", "bun test"]);

    expect(store.consumePendingSetupCommands("env-1")).toEqual([
      "bun install",
      "bun test",
    ]);
    expect(useEnvironmentStore.getState().pendingSetupCommands.has("env-1")).toBe(
      false
    );
  });

  test("setSetupScriptsRunning updates the running selector", () => {
    const store = useEnvironmentStore.getState();

    store.setSetupScriptsRunning("env-1", true);
    expect(store.isSetupScriptsRunning("env-1")).toBe(true);

    store.setSetupScriptsRunning("env-1", false);
    expect(useEnvironmentStore.getState().isSetupScriptsRunning("env-1")).toBe(
      false
    );
  });

  test("markSessionActivated returns true only on first call per environment", () => {
    const store = useEnvironmentStore.getState();

    expect(store.markSessionActivated("env-1")).toBe(true);
    expect(store.markSessionActivated("env-1")).toBe(false);
    expect(store.markSessionActivated("env-2")).toBe(true);

    const state = useEnvironmentStore.getState();
    expect(state.sessionActivated.has("env-1")).toBe(true);
    expect(state.sessionActivated.has("env-2")).toBe(true);
  });

  test("removeEnvironment clears sessionActivated for the environment", () => {
    const store = useEnvironmentStore.getState();
    store.addEnvironment(createEnvironment({ id: "env-1" }));
    store.markSessionActivated("env-1");
    expect(useEnvironmentStore.getState().sessionActivated.has("env-1")).toBe(
      true
    );

    store.removeEnvironment("env-1");
    expect(useEnvironmentStore.getState().sessionActivated.has("env-1")).toBe(
      false
    );
  });
});
