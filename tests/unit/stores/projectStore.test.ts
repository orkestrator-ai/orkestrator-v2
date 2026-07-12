import { describe, test, expect, beforeEach } from "bun:test";
import { useProjectStore } from "../../../apps/web/src/stores/projectStore";
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
});
