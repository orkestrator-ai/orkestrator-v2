import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { paneLayoutRevisionConflictMessage } from "@orkestrator/protocol/pane-layout";
import {
  createEnvironment,
  createProject,
  defaultConfig,
  defaultEnvironmentName,
  extractRepoName,
  parseUpdateObject,
  sanitizeBranchName,
  sanitizeEnvironmentName,
  StorageService,
} from "../src/core/storage";
import { hasStore, readStoredValue } from "../src/core/storage-test-support";
import {
  abandonLease,
  createTempDir,
  leaseHeld,
  removeTempDirs,
  withFixedDate,
} from "./storage-test-helpers";

afterEach(removeTempDirs);

describe("Electron StorageService", () => {
  test("sanitizes names, extracts repository names, and rejects non-record updates", () => {
    expect(sanitizeEnvironmentName("  My Feature/🚀  ")).toBe("my-feature");
    expect(sanitizeEnvironmentName("🚀")).toBe("env");
    expect(sanitizeEnvironmentName("a".repeat(120))).toHaveLength(100);
    expect(sanitizeBranchName("Feature.One/Two")).toBe("feature-one-two");
    expect(extractRepoName("git@github.com:openai/example.git")).toBe("example");
    expect(parseUpdateObject({ status: "running" })).toEqual({ status: "running" });
    expect(parseUpdateObject(null)).toEqual({});
    expect(parseUpdateObject([])).toEqual({});
  });

  test("creates project records with normalized names and nullable local paths", () => {
    const project = createProject("https://github.com/openai/example.git");
    expect(project).toMatchObject({
      name: "example",
      gitUrl: "https://github.com/openai/example.git",
      localPath: null,
      order: 0,
    });
    expect(project.id).toBeTruthy();
  });

  test("formats default environment names from UTC timestamps", () => {
    expect(withFixedDate("2026-04-15T12:34:56.789Z", () => defaultEnvironmentName())).toBe(
      "20260415-123456",
    );
  });

  test("creates unnamed environments with legacy-compatible timestamp names", () => {
    const environment = createEnvironment("project-1");

    expect(environment.name).toMatch(/^\d{8}-\d{6}$/);
    expect(environment.branch).toBe(environment.name);
    expect(environment.lastActivityAt).toBe(environment.createdAt);
    expect(environment.agentActivityState).toBe("idle");
    expect(environment.agentActivityUpdatedAt).toBe(environment.createdAt);
    // A freshly minted environment carries no launch intent; the renderer
    // records one right after creation via update_environment_agent_settings.
    expect(environment.pendingAgentLaunch).toBe(false);
    expect(environment.initialAgentModel).toBeUndefined();
    expect(environment.initialReasoningEffort).toBeUndefined();
  });

  test("persists one-shot agent launch options added at insert time", async () => {
    // There is no load-time whitelist to re-add a field the writer dropped, so
    // pin the insert + JSON read-back path directly rather than only the update
    // path that the CRUD test covers.
    const storage = new StorageService(await createTempDir("ork-storage-launch-options-"));
    await storage.init();
    const project = await storage.addProject(createProject("https://github.com/acme/seed.git"));
    const seeded = await storage.addEnvironment({
      ...createEnvironment(project.id, { name: "seeded" }),
      pendingAgentLaunch: true,
      initialAgentModel: "claude-fable-5[1m]",
      initialReasoningEffort: "max",
    });

    expect(await storage.getEnvironment(seeded.id)).toMatchObject({
      pendingAgentLaunch: true,
      initialAgentModel: "claude-fable-5[1m]",
      initialReasoningEffort: "max",
    });
  });

  test("recovers JSON from a rotated backup when the primary file is malformed", async () => {
    const dataDir = await createTempDir("ork-storage-json-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const first = defaultConfig();
    first.global.agentSettings = { ...first.global.agentSettings, defaultAgent: "claude" };
    await storage.saveConfig(first);

    const second = defaultConfig();
    second.global.agentSettings = { ...second.global.agentSettings, defaultAgent: "codex" };
    await storage.saveConfig(second);
    await fs.writeFile(path.join(dataDir, "config.json"), "{not-json");

    await expect(storage.loadConfig()).resolves.toMatchObject({
      global: expect.objectContaining({
        agentSettings: expect.objectContaining({ defaultAgent: "claude" }),
      }),
    });
  });

  test("covers project, environment, and configuration CRUD boundaries", async () => {
    const dataDir = await createTempDir("ork-storage-crud-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const firstProject = await storage.addProject(
      createProject("https://github.com/acme/first.git"),
    );
    const secondProject = await storage.addProject(
      createProject("https://github.com/acme/second.git", "/tmp/second"),
    );
    await expect(storage.addProject(createProject(firstProject.gitUrl))).rejects.toThrow(
      "Duplicate project URL",
    );
    await expect(storage.updateProject("missing", { name: "x" })).rejects.toThrow(
      "Project not found",
    );
    await storage.updateProject(firstProject.id, {
      name: "First renamed",
      localPath: "/tmp/first",
    });
    expect(await storage.getProject(firstProject.id)).toMatchObject({
      name: "First renamed",
      localPath: "/tmp/first",
    });
    await storage.updateProject(firstProject.id, {
      gitUrl: "  git@github.com:acme/first-moved.git  ",
    });
    expect(await storage.getProject(firstProject.id)).toMatchObject({
      name: "First renamed",
      gitUrl: "git@github.com:acme/first-moved.git",
      localPath: "/tmp/first",
    });
    await expect(
      storage.updateProject(firstProject.id, { gitUrl: secondProject.gitUrl }),
    ).rejects.toThrow("Duplicate project URL");
    await expect(storage.updateProject(firstProject.id, { gitUrl: "   " })).rejects.toThrow(
      "Git URL cannot be empty",
    );
    // Re-saving a project's own URL is not a duplicate of itself.
    await storage.updateProject(firstProject.id, {
      gitUrl: "git@github.com:acme/first-moved.git",
    });
    expect((await storage.getProject(firstProject.id))?.gitUrl).toBe(
      "git@github.com:acme/first-moved.git",
    );
    await storage.updateProject(firstProject.id, {
      gitUrl: "https://user:token@github.com/acme/credentialed.git",
    });
    expect((await storage.getProject(firstProject.id))?.gitUrl).toBe(
      "https://github.com/acme/credentialed.git",
    );
    await expect(
      storage.updateProject(firstProject.id, {
        gitUrl: "https://user:token@github.com/acme/second.git",
      }),
    ).rejects.toThrow("Duplicate project URL: https://github.com/acme/second.git");
    expect((await storage.getProject(firstProject.id))?.gitUrl).toBe(
      "https://github.com/acme/credentialed.git",
    );
    expect(
      (await storage.reorderProjects([secondProject.id])).map((project) => project.id),
    ).toEqual([secondProject.id, firstProject.id]);

    const firstEnvironment = await storage.addEnvironment(
      createEnvironment(firstProject.id, { name: "first" }),
    );
    const secondEnvironment = await storage.addEnvironment(
      createEnvironment(firstProject.id, { name: "second" }),
    );
    const otherEnvironment = await storage.addEnvironment(
      createEnvironment(secondProject.id, { name: "other" }),
    );
    const updated = await storage.updateEnvironment(firstEnvironment.id, {
      containerId: "container-1",
      allowedDomains: ["example.com", 42],
      setupScriptsComplete: true,
      networkAccessMode: "full",
      pendingRenamePrompt: "Name this after startup",
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
      entryPort: Number.NaN,
    });
    expect(updated).toMatchObject({
      containerId: "container-1",
      allowedDomains: ["example.com"],
      setupScriptsComplete: true,
      networkAccessMode: "full",
      pendingRenamePrompt: "Name this after startup",
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
    });
    expect(updated.entryPort).toBeUndefined();
    await storage.updateEnvironment(firstEnvironment.id, {
      initialAgentModel: 42,
      initialReasoningEffort: { invalid: true },
    });
    expect(await storage.getEnvironment(firstEnvironment.id)).toMatchObject({
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
    });
    await storage.updateEnvironment(firstEnvironment.id, {
      initialAgentModel: null,
      initialReasoningEffort: null,
    });
    expect((await storage.getEnvironment(firstEnvironment.id))?.initialAgentModel).toBeUndefined();
    expect(
      (await storage.getEnvironment(firstEnvironment.id))?.initialReasoningEffort,
    ).toBeUndefined();
    await storage.updateEnvironment(firstEnvironment.id, {
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
      cleanupAfterMergeRequestedAt: "2026-07-28T12:00:00.000Z",
      cleanupAfterMergeError: "cleanup failed",
      lifecycleError: "Environment start failed.",
    });
    expect(await storage.getEnvironment(firstEnvironment.id)).toMatchObject({
      cleanupAfterMergeRequestedAt: "2026-07-28T12:00:00.000Z",
      cleanupAfterMergeError: "cleanup failed",
      lifecycleError: "Environment start failed.",
    });
    await storage.updateEnvironment(firstEnvironment.id, {
      cleanupAfterMergeRequestedAt: 42,
      cleanupAfterMergeError: { invalid: true },
      lifecycleError: { invalid: true },
    });
    expect(await storage.getEnvironment(firstEnvironment.id)).toMatchObject({
      cleanupAfterMergeRequestedAt: "2026-07-28T12:00:00.000Z",
      cleanupAfterMergeError: "cleanup failed",
      lifecycleError: "Environment start failed.",
    });
    await storage.updateEnvironment(firstEnvironment.id, {
      pendingRenamePrompt: undefined,
      initialAgentModel: undefined,
      initialReasoningEffort: undefined,
      cleanupAfterMergeRequestedAt: null,
      cleanupAfterMergeError: undefined,
      lifecycleError: null,
    });
    expect(
      (await storage.getEnvironment(firstEnvironment.id))?.pendingRenamePrompt,
    ).toBeUndefined();
    expect((await storage.getEnvironment(firstEnvironment.id))?.initialAgentModel).toBeUndefined();
    expect(
      (await storage.getEnvironment(firstEnvironment.id))?.initialReasoningEffort,
    ).toBeUndefined();
    expect(
      (await storage.getEnvironment(firstEnvironment.id))?.cleanupAfterMergeRequestedAt,
    ).toBeUndefined();
    expect(
      (await storage.getEnvironment(firstEnvironment.id))?.cleanupAfterMergeError,
    ).toBeUndefined();
    // Explicitly null rather than undefined: JSON.stringify drops undefined
    // keys, so a cleared failure would reach the renderer as an absent key and
    // leave the stale message on screen through a field-by-field merge.
    expect((await storage.getEnvironment(firstEnvironment.id))?.lifecycleError).toBeNull();
    await storage.updateEnvironment(firstEnvironment.id, { lifecycleError: undefined });
    expect((await storage.getEnvironment(firstEnvironment.id))?.lifecycleError).toBeNull();
    expect(JSON.stringify(await storage.getEnvironment(firstEnvironment.id))).toContain(
      '"lifecycleError":null',
    );
    await expect(storage.updateEnvironment("missing", {})).rejects.toThrow("Environment not found");

    // A merge state belongs to one PR: kept for the same URL, cleared for a
    // replacement, and anything unrecognised is stored as unknown (null).
    const prOne = "https://github.com/acme/repo/pull/1";
    await storage.updateEnvironment(firstEnvironment.id, {
      prUrl: prOne,
      prState: "open",
      prMergeability: "clean",
    });
    expect((await storage.getEnvironment(firstEnvironment.id))?.prMergeability).toBe("clean");
    await storage.updateEnvironment(firstEnvironment.id, { prUrl: prOne, prState: "open" });
    expect((await storage.getEnvironment(firstEnvironment.id))?.prMergeability).toBe("clean");
    await storage.updateEnvironment(firstEnvironment.id, {
      prUrl: "https://github.com/acme/repo/pull/2",
    });
    expect((await storage.getEnvironment(firstEnvironment.id))?.prMergeability).toBeNull();
    await storage.updateEnvironment(firstEnvironment.id, { prMergeability: "CLEAN" });
    expect((await storage.getEnvironment(firstEnvironment.id))?.prMergeability).toBeNull();
    await storage.updateEnvironment(firstEnvironment.id, { prMergeability: "blocked" });
    await storage.updateEnvironment(firstEnvironment.id, { prUrl: null, prState: null });
    expect((await storage.getEnvironment(firstEnvironment.id))?.prMergeability).toBeNull();

    expect(
      (await storage.reorderEnvironments(firstProject.id, [secondEnvironment.id])).map(
        (environment) => environment.id,
      ),
    ).toEqual([secondEnvironment.id, firstEnvironment.id]);
    expect(
      (await storage.getEnvironmentsByProject(secondProject.id)).map(
        (environment) => environment.id,
      ),
    ).toEqual([otherEnvironment.id]);

    expect(await storage.getRepositoryConfig("missing")).toEqual({
      defaultBranch: "main",
      prBaseBranch: "main",
    });
    await storage.updateRepositoryConfig(firstProject.id, {
      defaultBranch: "develop",
      prBaseBranch: "release",
    });
    expect(await storage.getRepositoryConfig(firstProject.id)).toEqual({
      defaultBranch: "develop",
      prBaseBranch: "release",
    });
    const global = defaultConfig().global;
    global.webClientEnabled = false;
    global.reviewInstruction = "Review origin/{{targetBranch}}...HEAD.";
    await storage.updateGlobalConfig(global);
    expect((await storage.loadConfig()).global).toMatchObject({
      webClientEnabled: false,
      reviewInstruction: "Review origin/{{targetBranch}}...HEAD.",
    });

    await storage.removeEnvironment(otherEnvironment.id);
    await expect(storage.removeEnvironment(otherEnvironment.id)).rejects.toThrow(
      "Environment not found",
    );
    await storage.removeProject(secondProject.id);
    await expect(storage.removeProject(secondProject.id)).rejects.toThrow("Project not found");
  });

  test("preserves concurrent environment mutations across storage instances", async () => {
    const dataDir = await createTempDir("ork-storage-concurrent-environments-");
    const firstStorage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([firstStorage.init(), secondStorage.init()]);

    const environments = Array.from({ length: 12 }, (_, index) =>
      createEnvironment("project-1", { name: `environment-${index}` }),
    );
    await Promise.all(
      environments.map((environment, index) =>
        (index % 2 === 0 ? firstStorage : secondStorage).addEnvironment(environment),
      ),
    );

    const persisted = await firstStorage.getEnvironmentsByProject("project-1");
    expect(persisted).toHaveLength(environments.length);
    expect(new Set(persisted.map((environment) => environment.id)).size).toBe(environments.length);
    expect(new Set(persisted.map((environment) => environment.order)).size).toBe(
      environments.length,
    );

    await Promise.all(
      persisted.map((environment, index) =>
        (index % 2 === 0 ? firstStorage : secondStorage).updateEnvironment(environment.id, {
          status: index % 2 === 0 ? "running" : "stopped",
          name: `updated-${index}`,
        }),
      ),
    );

    const updated = await secondStorage.getEnvironmentsByProject("project-1");
    expect(updated.map((environment) => environment.name).sort()).toEqual(
      Array.from({ length: environments.length }, (_, index) => `updated-${index}`).sort(),
    );
  });

  test("recovers an abandoned environment mutation lock", async () => {
    const dataDir = await createTempDir("ork-storage-stale-environment-lock-");
    const storage = new StorageService(dataDir);
    await storage.init();
    await abandonLease(dataDir, "environments.json");
    expect(leaseHeld(dataDir, "environments.json")).toBe(true);

    const environment = await storage.addEnvironment(createEnvironment("project-1"));

    expect((await storage.getEnvironment(environment.id))?.id).toBe(environment.id);
    expect(leaseHeld(dataDir, "environments.json")).toBe(false);
  });

  test("serializes concurrent waiters reclaiming the same stale environment lock", async () => {
    const dataDir = await createTempDir("ork-storage-concurrent-stale-lock-");
    const first = new StorageService(dataDir);
    const second = new StorageService(dataDir);
    await Promise.all([first.init(), second.init()]);
    await abandonLease(dataDir, "environments.json");

    const [one, two] = await Promise.all([
      first.addEnvironment(createEnvironment("project-1", { name: "first" })),
      second.addEnvironment(createEnvironment("project-1", { name: "second" })),
    ]);

    expect((await first.loadEnvironments()).map((environment) => environment.id).sort()).toEqual(
      [one.id, two.id].sort(),
    );
  });

  test("persists session buffers, deletes removed session buffers, and cleans orphan buffers", async () => {
    const dataDir = await createTempDir("ork-storage-sessions-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const session = await storage.createSession("env-1", "container-1", "tab-1", "claude");
    await storage.saveSessionBuffer(session.id, "terminal output");
    await expect(storage.loadSessionBuffer(session.id)).resolves.toBe("terminal output");

    await storage.removeSession(session.id);
    await expect(storage.loadSessionBuffer(session.id)).resolves.toBeNull();

    await fs.mkdir(path.join(dataDir, "buffers"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "buffers", "orphan.txt"), "stale");
    await expect(storage.cleanupOrphanedBuffers()).resolves.toEqual(["orphan"]);
    await expect(fs.stat(path.join(dataDir, "buffers", "orphan.txt"))).rejects.toThrow();
  });

  test("updates, reorders, disconnects, and bulk-removes sessions", async () => {
    const dataDir = await createTempDir("ork-storage-session-crud-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const first = await storage.createSession("env-1", "container-1", "tab-1", "plain");
    const second = await storage.createSession("env-1", "container-1", "tab-2", "claude");
    await expect(storage.updateSession("missing", { name: "x" })).rejects.toThrow(
      "Session not found",
    );
    await storage.updateSession(first.id, { name: "Shell" });
    expect(await storage.getSession(first.id)).toMatchObject({
      status: "connected",
      name: "Shell",
    });
    expect(
      (await storage.reorderSessions("env-1", [second.id])).map((session) => session.id),
    ).toEqual([second.id, first.id]);
    expect(await storage.disconnectEnvironmentSessions("env-1")).toHaveLength(2);
    expect(await storage.removeSessionsByEnvironment("env-1")).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(await storage.getSessionsByEnvironment("env-1")).toEqual([]);
  });

  test("persists versioned pane layouts with revisions, isolation, limits, and deletion", async () => {
    const dataDir = await createTempDir("ork-storage-pane-layouts-");
    const storage = new StorageService(dataDir);
    await storage.init();
    // The layouts below name container-1, and a pane layout write is refused
    // unless it targets the environment's current container generation.
    const firstEnvironment = await storage.addEnvironment({
      ...createEnvironment("project-1", { name: "first" }),
      containerId: "container-1",
    });
    const secondEnvironment = await storage.addEnvironment(
      createEnvironment("project-1", { name: "second" }),
    );
    const root = {
      kind: "leaf",
      id: "default",
      tabs: [{ id: "tab-1", type: "plain" }],
      activeTabId: "tab-1",
    };

    const first = await storage.savePaneLayout(
      firstEnvironment.id,
      {
        version: 1,
        containerId: "container-1",
        activePaneId: "default",
        root,
      },
      0,
    );
    expect(first).toMatchObject({
      environmentId: firstEnvironment.id,
      revision: 1,
      root,
    });
    await expect(storage.getPaneLayout(firstEnvironment.id)).resolves.toEqual(first);
    await expect(
      storage.savePaneLayout(
        firstEnvironment.id,
        {
          version: 1,
          containerId: "container-1",
          activePaneId: "default",
          root,
        },
        -1,
      ),
    ).rejects.toThrow("non-negative integer");

    const competingStorage = new StorageService(dataDir);
    await competingStorage.init();
    const competingWrites = await Promise.allSettled([
      storage.savePaneLayout(
        firstEnvironment.id,
        {
          version: 1,
          containerId: "container-1",
          activePaneId: "default",
          root: { ...root, activeTabId: "tab-2" },
        },
        1,
      ),
      competingStorage.savePaneLayout(
        firstEnvironment.id,
        {
          version: 1,
          containerId: "container-1",
          activePaneId: "default",
          root: { ...root, activeTabId: "tab-3" },
        },
        1,
      ),
    ]);
    expect(competingWrites.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = competingWrites.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toEqual(new Error(paneLayoutRevisionConflictMessage(1, 2)));
    expect((await storage.getPaneLayout(firstEnvironment.id))?.revision).toBe(2);

    const third = await storage.savePaneLayout(
      firstEnvironment.id,
      {
        version: 1,
        containerId: "container-1",
        activePaneId: "default",
        root: { ...root, activeTabId: "tab-3" },
      },
      2,
    );
    expect(third.revision).toBe(3);

    const isolated = await storage.savePaneLayout(
      secondEnvironment.id,
      {
        version: 1,
        containerId: null,
        activePaneId: "local-pane",
        root: { kind: "leaf", id: "local-pane", tabs: [], activeTabId: null },
      },
      0,
    );
    expect(isolated.revision).toBe(1);
    expect((await storage.getPaneLayout(firstEnvironment.id))?.revision).toBe(3);

    await expect(
      storage.savePaneLayout(
        firstEnvironment.id,
        {
          version: 1,
          containerId: "container-1",
          activePaneId: "default",
          root: { value: "x".repeat(256 * 1024) },
        },
        3,
      ),
    ).rejects.toThrow("256 KB");
    await expect(
      storage.savePaneLayout(
        "missing",
        {
          version: 1,
          containerId: null,
          activePaneId: "default",
          root,
        },
        0,
      ),
    ).rejects.toThrow("Environment not found");

    await storage.deletePaneLayout(firstEnvironment.id);
    await expect(storage.getPaneLayout(firstEnvironment.id)).resolves.toBeNull();
    await expect(storage.getPaneLayout(secondEnvironment.id)).resolves.toEqual(isolated);
  });

  test("rejects cyclic pane roots and recovers the pane mutation queue after a failed save", async () => {
    const dataDir = await createTempDir("ork-storage-pane-layout-errors-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const cyclicRoot: Record<string, unknown> = { kind: "leaf" };
    cyclicRoot.self = cyclicRoot;

    await expect(
      storage.savePaneLayout(
        environment.id,
        {
          version: 1,
          containerId: null,
          activePaneId: "default",
          root: cyclicRoot,
        },
        0,
      ),
    ).rejects.toThrow("JSON serializable");
    await expect(
      storage.savePaneLayout(
        "missing",
        {
          version: 1,
          containerId: null,
          activePaneId: "default",
          root: {},
        },
        0,
      ),
    ).rejects.toThrow("Environment not found");

    await expect(
      storage.savePaneLayout(
        environment.id,
        {
          version: 1,
          containerId: null,
          activePaneId: "default",
          root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
        },
        0,
      ),
    ).resolves.toMatchObject({ environmentId: environment.id, revision: 1 });
  });

  test("deleting an absent pane layout is a no-op", async () => {
    const dataDir = await createTempDir("ork-storage-pane-layout-absent-delete-");
    const storage = new StorageService(dataDir);
    await storage.init();

    await expect(storage.deletePaneLayout("missing")).resolves.toBeUndefined();
    expect(hasStore(dataDir, "pane-layouts.json")).toBe(false);
  });

  test("serializes concurrent same-instance pane layout saves in issue order", async () => {
    const dataDir = await createTempDir("ork-storage-pane-layout-serialize-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment({
      ...createEnvironment("project-1"),
      containerId: "container-1",
    });
    const rootFor = (index: number) => ({
      kind: "leaf",
      id: "default",
      tabs: [{ id: `tab-${index}`, type: "plain" }],
      activeTabId: `tab-${index}`,
    });
    const expectedRevisions = [0, 1, 2, 3, 4];

    // Each call passes the revision it would see if the queue ran them in issue
    // order, so any reordering or interleaving turns into a revision conflict.
    const writes = await Promise.allSettled(
      expectedRevisions.map((expectedRevision) =>
        storage.savePaneLayout(
          environment.id,
          {
            version: 1,
            containerId: "container-1",
            activePaneId: "default",
            root: rootFor(expectedRevision),
          },
          expectedRevision,
        ),
      ),
    );

    expect(
      writes.map((result) =>
        result.status === "fulfilled" ? result.value.revision : result.reason,
      ),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(
      writes.map((result) => (result.status === "fulfilled" ? result.value.root : result.reason)),
    ).toEqual(expectedRevisions.map(rootFor));

    const stored = await storage.getPaneLayout(environment.id);
    expect(stored).toMatchObject({ revision: 5, root: rootFor(4) });
    const onDisk = readStoredValue<Record<string, unknown>>(dataDir, "pane-layouts.json")!;
    expect(Object.keys(onDisk)).toEqual([environment.id]);
    expect(onDisk[environment.id]).toEqual(stored);
  });

  test("keeps a pane layout delete racing a save on one instance non-corrupt", async () => {
    const dataDir = await createTempDir("ork-storage-pane-layout-delete-race-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment({
      ...createEnvironment("project-1"),
      containerId: "container-1",
    });
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };
    await storage.savePaneLayout(
      environment.id,
      {
        version: 1,
        containerId: "container-1",
        activePaneId: "default",
        root,
      },
      0,
    );

    const [deleted, saved] = await Promise.allSettled([
      storage.deletePaneLayout(environment.id),
      storage.savePaneLayout(
        environment.id,
        {
          version: 1,
          containerId: "container-1",
          activePaneId: "default",
          root: { ...root, activeTabId: "tab-2" },
        },
        1,
      ),
    ]);

    expect(deleted).toEqual({ status: "fulfilled", value: undefined });
    // Either the save ran first and the delete removed its result, or the delete
    // ran first and the save lost the compare-and-swap. Nothing else is legal.
    if (saved.status === "fulfilled") {
      expect(saved.value.revision).toBe(2);
    } else {
      expect(saved.reason).toEqual(new Error(paneLayoutRevisionConflictMessage(1, 0)));
    }
    await expect(storage.getPaneLayout(environment.id)).resolves.toBeNull();
    const onDisk = readStoredValue<Record<string, unknown>>(dataDir, "pane-layouts.json")!;
    expect(onDisk).toEqual({});

    await expect(
      storage.savePaneLayout(
        environment.id,
        {
          version: 1,
          containerId: "container-1",
          activePaneId: "default",
          root,
        },
        0,
      ),
    ).resolves.toMatchObject({ revision: 1 });
  });

  test("keeps a cross-instance pane layout delete racing a save non-corrupt", async () => {
    const dataDir = await createTempDir("ork-storage-pane-layout-delete-race-cross-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment({
      ...createEnvironment("project-1"),
      containerId: "container-1",
    });
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };
    await storage.savePaneLayout(
      environment.id,
      {
        version: 1,
        containerId: "container-1",
        activePaneId: "default",
        root,
      },
      0,
    );

    const competingStorage = new StorageService(dataDir);
    await competingStorage.init();
    const [deleted, saved] = await Promise.allSettled([
      storage.deletePaneLayout(environment.id),
      competingStorage.savePaneLayout(
        environment.id,
        {
          version: 1,
          containerId: "container-1",
          activePaneId: "default",
          root: { ...root, activeTabId: "tab-2" },
        },
        1,
      ),
    ]);

    expect(deleted).toEqual({ status: "fulfilled", value: undefined });
    if (saved.status === "fulfilled") {
      expect(saved.value.revision).toBe(2);
    } else {
      expect(saved.reason).toEqual(new Error(paneLayoutRevisionConflictMessage(1, 0)));
    }
    await expect(storage.getPaneLayout(environment.id)).resolves.toBeNull();
    expect(readStoredValue(dataDir, "pane-layouts.json")).toEqual({});

    await expect(
      competingStorage.savePaneLayout(
        environment.id,
        {
          version: 1,
          containerId: "container-1",
          activePaneId: "default",
          root,
        },
        0,
      ),
    ).resolves.toMatchObject({ revision: 1 });
  });

  test("rejects non-integer and non-finite pane layout expected revisions", async () => {
    const dataDir = await createTempDir("ork-storage-pane-layout-revision-types-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    for (const expectedRevision of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        storage.savePaneLayout(
          environment.id,
          {
            version: 1,
            containerId: null,
            activePaneId: "default",
            root,
          },
          expectedRevision,
        ),
      ).rejects.toThrow("Pane layout expected revision must be a non-negative integer");
    }
    await expect(storage.getPaneLayout(environment.id)).resolves.toBeNull();

    await expect(
      storage.savePaneLayout(
        environment.id,
        {
          version: 1,
          containerId: null,
          activePaneId: "default",
          root,
        },
        0,
      ),
    ).resolves.toMatchObject({ revision: 1 });
  });

  test("an oversize pane layout root rejects without consuming the revision", async () => {
    const dataDir = await createTempDir("ork-storage-pane-layout-oversize-cas-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    const first = await storage.savePaneLayout(
      environment.id,
      {
        version: 1,
        containerId: null,
        activePaneId: "default",
        root,
      },
      0,
    );
    expect(first.revision).toBe(1);

    await expect(
      storage.savePaneLayout(
        environment.id,
        {
          version: 1,
          containerId: null,
          activePaneId: "default",
          root: { value: "x".repeat(256 * 1024) },
        },
        1,
      ),
    ).rejects.toThrow("Pane layout root exceeds the 256 KB limit");
    await expect(storage.getPaneLayout(environment.id)).resolves.toEqual(first);

    // The rejected oversize write must not have burned revision 1.
    const second = await storage.savePaneLayout(
      environment.id,
      {
        version: 1,
        containerId: null,
        activePaneId: "default",
        root: { ...root, activeTabId: "tab-2" },
      },
      1,
    );
    expect(second).toMatchObject({ revision: 2, root: { ...root, activeTabId: "tab-2" } });
  });

  test("reports pane layout conflicts with the shared protocol message", async () => {
    const dataDir = await createTempDir("ork-storage-pane-layout-conflict-message-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };
    const layout = { version: 1, containerId: null, activePaneId: "default", root };

    await storage.savePaneLayout(environment.id, layout, 0);
    await expect(storage.savePaneLayout(environment.id, layout, 0)).rejects.toThrow(
      paneLayoutRevisionConflictMessage(0, 1),
    );
    await expect(storage.savePaneLayout(environment.id, layout, 7)).rejects.toThrow(
      paneLayoutRevisionConflictMessage(7, 1),
    );
    // A save against an environment that has never stored a layout compares to 0.
    const other = await storage.addEnvironment(createEnvironment("project-1", { name: "other" }));
    await expect(storage.savePaneLayout(other.id, layout, 3)).rejects.toThrow(
      paneLayoutRevisionConflictMessage(3, 0),
    );
  });
});
