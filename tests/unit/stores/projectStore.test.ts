import { describe, test, expect, beforeEach } from "bun:test";
import { projectStore } from "../../../apps/web/src/stores/projectStore";
import type { Project } from "../../../apps/web/src/types";
import { appCommandStore } from "../../../apps/web/src/test/app-command-store";

describe("projectStore", () => {
  beforeEach(() => {
    // Reset store between tests
    appCommandStore(projectStore).setState({
      projects: [],
      isLoading: false,
      error: null,
    });
  });

  test("initial state is empty", () => {
    const state = appCommandStore(projectStore).getState();
    expect(state.projects).toEqual([]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  test("addProject adds a project to the store", () => {
    const project: Project = {
      id: "test-1",
      name: "test-repo",
      gitUrl: "git@github.com:test/repo.git",
      localPath: null,
      addedAt: new Date().toISOString(),
      order: 0,
    };

    appCommandStore(projectStore).getState().addProject(project);

    const state = appCommandStore(projectStore).getState();
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]).toEqual(project);
  });

  test("removeProject removes a project from the store", () => {
    const project: Project = {
      id: "test-1",
      name: "test-repo",
      gitUrl: "git@github.com:test/repo.git",
      localPath: null,
      addedAt: new Date().toISOString(),
      order: 0,
    };

    appCommandStore(projectStore).getState().addProject(project);
    expect(appCommandStore(projectStore).getState().projects).toHaveLength(1);

    appCommandStore(projectStore).getState().removeProject("test-1");
    expect(appCommandStore(projectStore).getState().projects).toHaveLength(0);
  });

  test("updateProject updates a project in the store", () => {
    const project: Project = {
      id: "test-1",
      name: "test-repo",
      gitUrl: "git@github.com:test/repo.git",
      localPath: null,
      addedAt: new Date().toISOString(),
      order: 0,
    };

    appCommandStore(projectStore).getState().addProject(project);
    appCommandStore(projectStore).getState().updateProject("test-1", { name: "updated-name" });

    const state = appCommandStore(projectStore).getState();
    expect(state.projects[0]?.name).toBe("updated-name");
  });

  test("getProjectById returns the correct project", () => {
    const project1: Project = {
      id: "test-1",
      name: "test-repo-1",
      gitUrl: "git@github.com:test/repo1.git",
      localPath: null,
      addedAt: new Date().toISOString(),
      order: 0,
    };
    const project2: Project = {
      id: "test-2",
      name: "test-repo-2",
      gitUrl: "git@github.com:test/repo2.git",
      localPath: null,
      addedAt: new Date().toISOString(),
      order: 1,
    };

    appCommandStore(projectStore).getState().addProject(project1);
    appCommandStore(projectStore).getState().addProject(project2);

    const found = appCommandStore(projectStore).getState().getProjectById("test-2");
    expect(found).toEqual(project2);
  });

  test("getProjectById returns undefined for non-existent project", () => {
    const found = appCommandStore(projectStore).getState().getProjectById("non-existent");
    expect(found).toBeUndefined();
  });

  test("setLoading updates loading state", () => {
    appCommandStore(projectStore).getState().setLoading(true);
    expect(appCommandStore(projectStore).getState().isLoading).toBe(true);

    appCommandStore(projectStore).getState().setLoading(false);
    expect(appCommandStore(projectStore).getState().isLoading).toBe(false);
  });

  test("setError updates error state", () => {
    appCommandStore(projectStore).getState().setError("Test error");
    expect(appCommandStore(projectStore).getState().error).toBe("Test error");

    appCommandStore(projectStore).getState().setError(null);
    expect(appCommandStore(projectStore).getState().error).toBeNull();
  });

  test("setProjects sorts the backend result by order", () => {
    const later = {
      id: "later",
      name: "later",
      gitUrl: "git@github.com:test/later.git",
      localPath: null,
      addedAt: new Date().toISOString(),
      order: 2,
    } satisfies Project;
    const earlier = { ...later, id: "earlier", name: "earlier", order: 1 };

    appCommandStore(projectStore).getState().setProjects([later, earlier]);

    expect(
      appCommandStore(projectStore)
        .getState()
        .projects.map((project) => project.id),
    ).toEqual(["earlier", "later"]);
  });

  test("reorderProjects updates order and drops IDs that are not in the store", () => {
    const first = {
      id: "first",
      name: "first",
      gitUrl: "git@github.com:test/first.git",
      localPath: null,
      addedAt: new Date().toISOString(),
      order: 0,
    } satisfies Project;
    const second = { ...first, id: "second", name: "second", order: 1 };
    appCommandStore(projectStore).getState().setProjects([first, second]);

    appCommandStore(projectStore).getState().reorderProjects(["second", "missing", "first"]);

    expect(appCommandStore(projectStore).getState().projects).toEqual([
      { ...second, order: 0 },
      { ...first, order: 2 },
    ]);
  });

  test("rejects snapshots captured before every project mutation", () => {
    const original = {
      id: "original",
      name: "original",
      gitUrl: "git@github.com:test/original.git",
      localPath: null,
      addedAt: new Date().toISOString(),
      order: 0,
    } satisfies Project;
    const replacement = { ...original, id: "stale", name: "stale" };

    const assertMutationRejectsSnapshot = (mutate: () => void) => {
      appCommandStore(projectStore).getState().setProjects([original]);
      const snapshotVersion = appCommandStore(projectStore).getState().getMutationVersion();
      mutate();

      expect(
        appCommandStore(projectStore).getState().applySnapshot([replacement], snapshotVersion),
      ).toBe(false);
      expect(
        appCommandStore(projectStore)
          .getState()
          .projects.some((project) => project.id === "stale"),
      ).toBe(false);
    };

    assertMutationRejectsSnapshot(() =>
      appCommandStore(projectStore)
        .getState()
        .addProject({ ...original, id: "added", name: "added", order: 1 }),
    );
    assertMutationRejectsSnapshot(() =>
      appCommandStore(projectStore).getState().removeProject("original"),
    );
    assertMutationRejectsSnapshot(() =>
      appCommandStore(projectStore).getState().updateProject("original", { name: "updated" }),
    );
    assertMutationRejectsSnapshot(() =>
      appCommandStore(projectStore).getState().reorderProjects(["original"]),
    );
    assertMutationRejectsSnapshot(() => appCommandStore(projectStore).getState().setProjects([]));
    assertMutationRejectsSnapshot(() =>
      appCommandStore(projectStore).getState().invalidateSnapshots(),
    );
  });

  test("applies and sorts a snapshot when its mutation version is current", () => {
    const currentVersion = appCommandStore(projectStore).getState().getMutationVersion();
    const later = {
      id: "later",
      name: "later",
      gitUrl: "git@github.com:test/later.git",
      localPath: null,
      addedAt: new Date().toISOString(),
      order: 3,
    } satisfies Project;
    const earlier = { ...later, id: "earlier", name: "earlier", order: 1 };

    expect(
      appCommandStore(projectStore).getState().applySnapshot([later, earlier], currentVersion),
    ).toBe(true);
    expect(
      appCommandStore(projectStore)
        .getState()
        .projects.map((project) => project.id),
    ).toEqual(["earlier", "later"]);
  });

  test("arrangeProjects applies order and folder membership together", () => {
    const base = {
      name: "p",
      gitUrl: "git@github.com:test/p.git",
      localPath: null,
      addedAt: new Date().toISOString(),
    };
    appCommandStore(projectStore)
      .getState()
      .setProjects([
        { ...base, id: "alpha", order: 0 },
        { ...base, id: "beta", order: 1, folder: "Work" },
        { ...base, id: "gamma", order: 2 },
      ]);

    appCommandStore(projectStore)
      .getState()
      .arrangeProjects(["gamma", "alpha", "beta"], { gamma: "Work" });

    expect(
      appCommandStore(projectStore)
        .getState()
        .projects.map(({ id, order, folder }) => ({ id, order, folder })),
    ).toEqual([
      { id: "gamma", order: 0, folder: "Work" },
      { id: "alpha", order: 1, folder: undefined },
      // Membership this arrangement did not mention is carried through.
      { id: "beta", order: 2, folder: "Work" },
    ]);
    // Clearing membership removes the key rather than storing an explicit null.
    appCommandStore(projectStore)
      .getState()
      .arrangeProjects(["gamma", "alpha", "beta"], { gamma: null });
    expect("folder" in appCommandStore(projectStore).getState().projects[0]!).toBe(false);
  });

  test("arrangeProjects drops ids the store no longer knows about", () => {
    const base = {
      name: "p",
      gitUrl: "git@github.com:test/p.git",
      localPath: null,
      addedAt: new Date().toISOString(),
    };
    appCommandStore(projectStore)
      .getState()
      .setProjects([{ ...base, id: "alpha", order: 0 }]);
    appCommandStore(projectStore)
      .getState()
      .arrangeProjects(["alpha", "missing"], { missing: "Work" });
    expect(
      appCommandStore(projectStore)
        .getState()
        .projects.map(({ id }) => id),
    ).toEqual(["alpha"]);
  });
});
