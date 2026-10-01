import { afterEach, describe, expect, test } from "bun:test";
import type { Environment, Project } from "./models.js";
import {
  PROJECT_HOME_DETACHED_BRANCH,
  ensureProjectHomeEnvironment,
  isProjectHomeEnvironment,
  projectHomeTesting,
  refreshProjectHomeBranch,
  type ProjectHomeDependencies,
} from "./project-home-environment.js";
import { createEnvironment } from "./storage-shared-core.js";

afterEach(() => {
  projectHomeTesting.reset();
});

const project: Project = {
  id: "project-1",
  name: "Project",
  gitUrl: "git@example.com:org/project.git",
  localPath: "/checkout",
  addedAt: "2026-10-01T00:00:00.000Z",
  order: 0,
};

function fakeStorage(initial: Environment[] = [], projects: Project[] = [project]) {
  const environments = [...initial];
  const calls = { add: 0, update: 0 };
  const storage: ProjectHomeDependencies["storage"] = {
    getProject: async (id: string) => projects.find((candidate) => candidate.id === id) ?? null,
    getEnvironmentsByProject: async (id: string) =>
      environments.filter((environment) => environment.projectId === id),
    addEnvironment: async (environment: Environment) => {
      calls.add += 1;
      environments.push(environment);
      return environment;
    },
    updateEnvironment: async (id: string, updates: Record<string, unknown>) => {
      calls.update += 1;
      const index = environments.findIndex((environment) => environment.id === id);
      environments[index] = { ...environments[index]!, ...updates } as Environment;
      return environments[index]!;
    },
  } as unknown as ProjectHomeDependencies["storage"];
  return { storage, environments, calls };
}

function dependencies(
  storage: ProjectHomeDependencies["storage"],
  branch = "main",
): ProjectHomeDependencies & { cleared: string[] } {
  const cleared: string[] = [];
  return {
    storage,
    resolveRoot: async (target) => `${target.localPath}-canonical`,
    readBranch: async () => branch,
    createRecord: (projectId, name) => createEnvironment(projectId, { name }),
    clearTerminalSessions: async (environmentId) => {
      cleared.push(environmentId);
    },
    cleared,
  };
}

describe("ensureProjectHomeEnvironment", () => {
  test("creates a ready local environment rooted at the project checkout", async () => {
    const { storage, environments } = fakeStorage();

    const { environment, created } = await ensureProjectHomeEnvironment(
      project.id,
      dependencies(storage, "feature/x"),
    );

    expect(created).toBe(true);
    expect(environments).toHaveLength(1);
    expect(isProjectHomeEnvironment(environment)).toBe(true);
    expect(environment).toMatchObject({
      projectId: project.id,
      projectHome: true,
      environmentType: "local",
      worktreePath: "/checkout-canonical",
      branch: "feature/x",
      status: "running",
      setupScriptsComplete: true,
      setupPhase: "ready",
      pendingAgentLaunch: false,
    });
    // No creation commit: diffs compare against the repository base branch.
    expect(environment.createdFromCommit).toBeUndefined();
    expect(environment.pendingRenamePrompt).toBeUndefined();
  });

  test("reuses the existing home instead of creating a second one", async () => {
    const { storage, environments, calls } = fakeStorage();
    const first = await ensureProjectHomeEnvironment(project.id, dependencies(storage));
    const second = await ensureProjectHomeEnvironment(project.id, dependencies(storage));

    expect(second.created).toBe(false);
    expect(second.environment.id).toBe(first.environment.id);
    expect(environments).toHaveLength(1);
    expect(calls.update).toBe(0);
  });

  test("serializes concurrent calls for one project", async () => {
    const { storage, environments } = fakeStorage();
    const [a, b] = await Promise.all([
      ensureProjectHomeEnvironment(project.id, dependencies(storage)),
      ensureProjectHomeEnvironment(project.id, dependencies(storage)),
    ]);
    expect(a.environment.id).toBe(b.environment.id);
    expect(environments).toHaveLength(1);
  });

  test("follows a branch switched in the checkout and drops the old branch's PR", async () => {
    const { storage } = fakeStorage();
    const { environment } = await ensureProjectHomeEnvironment(project.id, dependencies(storage));
    await storage.updateEnvironment(environment.id, {
      prUrl: "https://github.com/org/project/pull/1",
      prState: "open",
    });

    const refreshed = await ensureProjectHomeEnvironment(
      project.id,
      dependencies(storage, "release"),
    );

    expect(refreshed.environment).toMatchObject({
      branch: "release",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    });
  });

  test("restarts a stopped home without touching the checkout", async () => {
    const { storage } = fakeStorage();
    const { environment } = await ensureProjectHomeEnvironment(project.id, dependencies(storage));
    await storage.updateEnvironment(environment.id, { status: "stopped" });
    const deps = dependencies(storage);

    const restarted = await ensureProjectHomeEnvironment(project.id, deps);

    expect(restarted.environment.status).toBe("running");
    expect(deps.cleared).toEqual([environment.id]);
  });

  test("records a detached checkout with a fixed branch label", async () => {
    const { storage } = fakeStorage();
    const { environment } = await ensureProjectHomeEnvironment(
      project.id,
      dependencies(storage, ""),
    );
    expect(environment.branch).toBe(PROJECT_HOME_DETACHED_BRANCH);
  });

  test("ignores a home that is being deleted", async () => {
    const deleting = {
      ...createEnvironment(project.id, { name: "project-home" }),
      projectHome: true,
      deletionRequestedAt: "2026-10-01T00:00:00.000Z",
    } as Environment;
    const { storage, environments } = fakeStorage([deleting]);

    const { created } = await ensureProjectHomeEnvironment(project.id, dependencies(storage));

    expect(created).toBe(true);
    expect(environments).toHaveLength(2);
  });

  test("refuses a project without a local checkout", async () => {
    const { storage } = fakeStorage([], [{ ...project, localPath: null }]);
    await expect(ensureProjectHomeEnvironment(project.id, dependencies(storage))).rejects.toThrow(
      "no local checkout",
    );
  });

  test("refuses an unknown project", async () => {
    const { storage } = fakeStorage();
    await expect(ensureProjectHomeEnvironment("missing", dependencies(storage))).rejects.toThrow(
      "Project not found",
    );
  });
});

describe("refreshProjectHomeBranch", () => {
  test("records the checkout's live branch for a project home", async () => {
    const { storage } = fakeStorage();
    const { environment } = await ensureProjectHomeEnvironment(project.id, dependencies(storage));

    const refreshed = await refreshProjectHomeBranch(
      environment,
      storage,
      async () => "feat/new-branch",
    );

    expect(refreshed.branch).toBe("feat/new-branch");
  });

  test("leaves ordinary environments and unreadable checkouts alone", async () => {
    const { storage, calls } = fakeStorage();
    const worker = {
      ...createEnvironment(project.id, { name: "worker", environmentType: "local" }),
      worktreePath: "/workspaces/worker",
    } as Environment;
    expect(await refreshProjectHomeBranch(worker, storage, async () => "other")).toBe(worker);

    const { environment } = await ensureProjectHomeEnvironment(project.id, dependencies(storage));
    const unchanged = await refreshProjectHomeBranch(environment, storage, async () => {
      throw new Error("git unavailable");
    });
    expect(unchanged).toBe(environment);
    expect(calls.update).toBe(0);
  });
});
