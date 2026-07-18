import { describe, test, expect, beforeEach } from "bun:test";
import {
  applyProjectSnapshot,
  getProjectMutationVersion,
  invalidateProjectSnapshots,
  useProjectStore,
} from "../../../apps/web/src/stores/projectStore";
import type { Project } from "../../../apps/web/src/types";

describe("projectStore", () => {
  beforeEach(() => {
    // Reset store between tests
    useProjectStore.setState({
      projects: [],
      isLoading: false,
      error: null,
    });
  });

  test("initial state is empty", () => {
    const state = useProjectStore.getState();
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
    };

    useProjectStore.getState().addProject(project);

    const state = useProjectStore.getState();
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
    };

    useProjectStore.getState().addProject(project);
    expect(useProjectStore.getState().projects).toHaveLength(1);

    useProjectStore.getState().removeProject("test-1");
    expect(useProjectStore.getState().projects).toHaveLength(0);
  });

  test("updateProject updates a project in the store", () => {
    const project: Project = {
      id: "test-1",
      name: "test-repo",
      gitUrl: "git@github.com:test/repo.git",
      localPath: null,
      addedAt: new Date().toISOString(),
    };

    useProjectStore.getState().addProject(project);
    useProjectStore.getState().updateProject("test-1", { name: "updated-name" });

    const state = useProjectStore.getState();
    expect(state.projects[0]?.name).toBe("updated-name");
  });

  test("getProjectById returns the correct project", () => {
    const project1: Project = {
      id: "test-1",
      name: "test-repo-1",
      gitUrl: "git@github.com:test/repo1.git",
      localPath: null,
      addedAt: new Date().toISOString(),
    };
    const project2: Project = {
      id: "test-2",
      name: "test-repo-2",
      gitUrl: "git@github.com:test/repo2.git",
      localPath: null,
      addedAt: new Date().toISOString(),
    };

    useProjectStore.getState().addProject(project1);
    useProjectStore.getState().addProject(project2);

    const found = useProjectStore.getState().getProjectById("test-2");
    expect(found).toEqual(project2);
  });

  test("getProjectById returns undefined for non-existent project", () => {
    const found = useProjectStore.getState().getProjectById("non-existent");
    expect(found).toBeUndefined();
  });

  test("setLoading updates loading state", () => {
    useProjectStore.getState().setLoading(true);
    expect(useProjectStore.getState().isLoading).toBe(true);

    useProjectStore.getState().setLoading(false);
    expect(useProjectStore.getState().isLoading).toBe(false);
  });

  test("setError updates error state", () => {
    useProjectStore.getState().setError("Test error");
    expect(useProjectStore.getState().error).toBe("Test error");

    useProjectStore.getState().setError(null);
    expect(useProjectStore.getState().error).toBeNull();
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

    useProjectStore.getState().setProjects([later, earlier]);

    expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual([
      "earlier",
      "later",
    ]);
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
    useProjectStore.getState().setProjects([first, second]);

    useProjectStore.getState().reorderProjects(["second", "missing", "first"]);

    expect(useProjectStore.getState().projects).toEqual([
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
      useProjectStore.getState().setProjects([original]);
      const snapshotVersion = getProjectMutationVersion();
      mutate();

      expect(applyProjectSnapshot([replacement], snapshotVersion)).toBe(false);
      expect(useProjectStore.getState().projects.some((project) => project.id === "stale")).toBe(
        false
      );
    };

    assertMutationRejectsSnapshot(() =>
      useProjectStore.getState().addProject({ ...original, id: "added", name: "added", order: 1 })
    );
    assertMutationRejectsSnapshot(() => useProjectStore.getState().removeProject("original"));
    assertMutationRejectsSnapshot(() =>
      useProjectStore.getState().updateProject("original", { name: "updated" })
    );
    assertMutationRejectsSnapshot(() => useProjectStore.getState().reorderProjects(["original"]));
    assertMutationRejectsSnapshot(() => useProjectStore.getState().setProjects([]));
    assertMutationRejectsSnapshot(() => invalidateProjectSnapshots());
  });

  test("applies and sorts a snapshot when its mutation version is current", () => {
    const currentVersion = getProjectMutationVersion();
    const later = {
      id: "later",
      name: "later",
      gitUrl: "git@github.com:test/later.git",
      localPath: null,
      addedAt: new Date().toISOString(),
      order: 3,
    } satisfies Project;
    const earlier = { ...later, id: "earlier", name: "earlier", order: 1 };

    expect(applyProjectSnapshot([later, earlier], currentVersion)).toBe(true);
    expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual([
      "earlier",
      "later",
    ]);
  });
});
