import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  useProjectStore,
} from "../../../apps/web/src/stores/projectStore";
import type { Project } from "../../../apps/web/src/types";
import { createMockProject } from "../utils/testFactories";

// Mock backend module BEFORE importing the hook
const mockGetProjects = mock<() => Promise<Project[]>>(() => Promise.resolve([]));
const mockAddProject = mock<(gitUrl: string, localPath?: string) => Promise<Project>>((gitUrl) =>
  Promise.resolve(createMockProject({ id: "new-project-id", name: "test-repo", gitUrl }))
);
const mockRemoveProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
const mockValidateGitUrl = mock<(url: string) => Promise<boolean>>(() => Promise.resolve(true));
const mockReorderProjects = mock<(projectIds: string[]) => Promise<Project[]>>(() =>
  Promise.resolve([])
);
const mockUpdateProject = mock<
  (projectId: string, updates: Partial<Pick<Project, "name" | "localPath">>) => Promise<Project>
>((projectId, updates) =>
  Promise.resolve(createMockProject({ id: projectId, ...updates }))
);

mock.module("@/lib/backend", () => ({
  getProjects: mockGetProjects,
  addProject: mockAddProject,
  removeProject: mockRemoveProject,
  validateGitUrl: mockValidateGitUrl,
  reorderProjects: mockReorderProjects,
  updateProject: mockUpdateProject,
}));

// Import hook AFTER mocking
import { useProjects } from "../../../apps/web/src/hooks/useProjects";

describe("useProjects", () => {
  beforeEach(() => {
    // Reset store between tests
    useProjectStore.setState({
      projects: [],
      isLoading: false,
      error: null,
    });

    // Reset mocks
    mockGetProjects.mockClear();
    mockAddProject.mockClear();
    mockRemoveProject.mockClear();
    mockValidateGitUrl.mockClear();
    mockReorderProjects.mockClear();
    mockUpdateProject.mockClear();

    // Reset to default implementations
    mockGetProjects.mockImplementation(() => Promise.resolve([]));
    mockAddProject.mockImplementation((gitUrl: string) =>
      Promise.resolve(createMockProject({ id: "new-project-id", name: "test-repo", gitUrl }))
    );
    mockRemoveProject.mockImplementation(() => Promise.resolve());
    mockValidateGitUrl.mockImplementation(() => Promise.resolve(true));
    mockReorderProjects.mockImplementation(() => Promise.resolve([]));
    mockUpdateProject.mockImplementation((projectId, updates) =>
      Promise.resolve(createMockProject({ id: projectId, ...updates }))
    );
  });

  test("returns initial state", async () => {
    const { result } = renderHook(() => useProjects());

    // Wait for initial load to complete
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.projects).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  test("loads projects on mount", async () => {
    const mockProjects: Project[] = [
      createMockProject({ id: "project-1", name: "repo-1", gitUrl: "git@github.com:test/repo1.git" }),
    ];
    mockGetProjects.mockImplementation(() => Promise.resolve(mockProjects));

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.projects).toHaveLength(1);
    });

    expect(mockGetProjects).toHaveBeenCalled();
    expect(result.current.projects[0]?.id).toBe("project-1");
  });

  test("addProject adds a project successfully", async () => {
    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let addedProject: Project | undefined;
    await act(async () => {
      addedProject = await result.current.addProject("git@github.com:test/repo.git");
    });

    expect(mockAddProject).toHaveBeenCalledWith("git@github.com:test/repo.git", undefined);
    expect(addedProject?.id).toBe("new-project-id");
    expect(result.current.projects).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  test("addProject sets error on failure", async () => {
    const expectedError = new Error("Failed to add");
    mockAddProject.mockImplementation(() => Promise.reject(expectedError));

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.addProject("git@github.com:test/repo.git");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    // Verify the correct error was thrown
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe("Failed to add");

    // Verify error state is set
    expect(result.current.error).toBe("Failed to add");
    expect(result.current.projects).toHaveLength(0);
  });

  test("removeProject removes a project successfully", async () => {
    // Start with a project in the store
    const existingProject = createMockProject({
      id: "project-1",
      name: "repo-1",
      gitUrl: "git@github.com:test/repo1.git",
    });

    useProjectStore.setState({
      projects: [existingProject],
      isLoading: false,
      error: null,
    });

    // Don't auto-load projects on this test
    mockGetProjects.mockImplementation(() => Promise.resolve([existingProject]));

    const { result } = renderHook(() => useProjects());

    // Wait for mount load to complete
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.removeProject("project-1");
    });

    expect(mockRemoveProject).toHaveBeenCalledWith("project-1");
    expect(result.current.projects).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  test("removeProject sets error on failure", async () => {
    const expectedError = new Error("Failed to remove");
    mockRemoveProject.mockImplementation(() => Promise.reject(expectedError));

    const existingProject = createMockProject({
      id: "project-1",
      name: "repo-1",
      gitUrl: "git@github.com:test/repo1.git",
    });

    useProjectStore.setState({
      projects: [existingProject],
      isLoading: false,
      error: null,
    });

    mockGetProjects.mockImplementation(() => Promise.resolve([existingProject]));

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.removeProject("project-1");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    // Verify the correct error was thrown
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe("Failed to remove");

    expect(result.current.error).toBe("Failed to remove");
    // Project should still be in the store since removal failed
    expect(result.current.projects).toHaveLength(1);
  });

  test("updateProject persists and updates the matching store entry", async () => {
    const existingProject = createMockProject({
      id: "project-1",
      name: "before",
      localPath: null,
      order: 0,
    });
    const updatedProject = { ...existingProject, name: "after", localPath: "/repos/after" };
    useProjectStore.setState({ projects: [existingProject] });
    mockGetProjects.mockImplementation(() => Promise.resolve([existingProject]));
    mockUpdateProject.mockImplementation(() => Promise.resolve(updatedProject));

    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let updated: Project | undefined;
    await act(async () => {
      updated = await result.current.updateProject({
        id: "project-1",
        name: "after",
        localPath: "/repos/after",
      });
    });

    expect(mockUpdateProject).toHaveBeenCalledWith("project-1", {
      name: "after",
      localPath: "/repos/after",
    });
    expect(updated).toEqual(updatedProject);
    expect(result.current.projects[0]).toEqual(updatedProject);
  });

  test("updateProject preserves the store entry and reports backend failures", async () => {
    const existingProject = createMockProject({ id: "project-1", name: "before", order: 0 });
    useProjectStore.setState({ projects: [existingProject] });
    mockGetProjects.mockImplementation(() => Promise.resolve([existingProject]));
    mockUpdateProject.mockImplementation(() => Promise.reject(new Error("Update failed")));

    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.updateProject({
          id: "project-1",
          name: "after",
          localPath: null,
        });
      });
    } catch (error) {
      thrownError = error as Error;
    }

    expect(thrownError?.message).toBe("Update failed");
    expect(result.current.error).toBe("Update failed");
    expect(result.current.projects[0]).toEqual(existingProject);
  });

  test("reorderProjects applies the backend-confirmed order", async () => {
    const first = createMockProject({ id: "first", name: "first", order: 0 });
    const second = createMockProject({ id: "second", name: "second", order: 1 });
    const confirmed = [{ ...second, order: 0 }, { ...first, order: 1 }];
    useProjectStore.setState({ projects: [first, second] });
    mockGetProjects.mockImplementation(() => Promise.resolve([first, second]));
    mockReorderProjects.mockImplementation(() => Promise.resolve(confirmed));

    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.reorderProjects(["second", "first"]);
    });

    expect(mockReorderProjects).toHaveBeenCalledWith(["second", "first"]);
    expect(result.current.projects).toEqual(confirmed);
  });

  test("reorderProjects reloads the authoritative order after failure", async () => {
    const first = createMockProject({ id: "first", name: "first", order: 0 });
    const second = createMockProject({ id: "second", name: "second", order: 1 });
    useProjectStore.setState({ projects: [first, second] });
    mockGetProjects.mockImplementation(() => Promise.resolve([first, second]));
    mockReorderProjects.mockImplementation(() => Promise.reject(new Error("Reorder failed")));

    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    mockGetProjects.mockClear();

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.reorderProjects(["second", "first"]);
      });
    } catch (error) {
      thrownError = error as Error;
    }

    expect(thrownError?.message).toBe("Reorder failed");
    expect(mockGetProjects).toHaveBeenCalledTimes(1);
    expect(result.current.projects).toEqual([first, second]);
    expect(result.current.error).toBe("Reorder failed");
  });

  test("validateGitUrl returns true for valid URL", async () => {
    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let isValid: boolean | undefined;
    await act(async () => {
      isValid = await result.current.validateGitUrl("git@github.com:test/repo.git");
    });

    expect(isValid).toBe(true);
    expect(mockValidateGitUrl).toHaveBeenCalledWith("git@github.com:test/repo.git");
  });

  test("validateGitUrl returns false for invalid URL", async () => {
    mockValidateGitUrl.mockImplementation(() => Promise.resolve(false));

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let isValid: boolean | undefined;
    await act(async () => {
      isValid = await result.current.validateGitUrl("not-a-url");
    });

    expect(isValid).toBe(false);
  });

  test("validateGitUrl returns false on error", async () => {
    mockValidateGitUrl.mockImplementation(() => Promise.reject(new Error("Network error")));

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let isValid: boolean | undefined;
    await act(async () => {
      isValid = await result.current.validateGitUrl("git@github.com:test/repo.git");
    });

    expect(isValid).toBe(false);
  });

  test("getProjectById returns the correct project", async () => {
    const project = createMockProject({
      id: "project-1",
      name: "repo-1",
      gitUrl: "git@github.com:test/repo1.git",
    });

    useProjectStore.setState({
      projects: [project],
      isLoading: false,
      error: null,
    });

    mockGetProjects.mockImplementation(() => Promise.resolve([project]));

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const found = result.current.getProjectById("project-1");
    expect(found).toEqual(project);
  });

  test("getProjectById returns undefined for non-existent project", async () => {
    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const found = result.current.getProjectById("non-existent");
    expect(found).toBeUndefined();
  });

  test("loadProjects can be called manually", async () => {
    const mockProjects: Project[] = [
      createMockProject({ id: "project-1", name: "repo-1", gitUrl: "git@github.com:test/repo1.git" }),
    ];

    // Start with no projects
    mockGetProjects.mockImplementation(() => Promise.resolve([]));

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Clear previous calls from mount
    mockGetProjects.mockClear();

    // Update mock to return projects
    mockGetProjects.mockImplementation(() => Promise.resolve(mockProjects));

    await act(async () => {
      await result.current.loadProjects();
    });

    expect(mockGetProjects).toHaveBeenCalled();
    expect(result.current.projects).toHaveLength(1);
  });

  test("handles load error gracefully", async () => {
    mockGetProjects.mockImplementation(() => Promise.reject(new Error("Network error")));

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe("Network error");
    expect(result.current.projects).toEqual([]);
  });

  test("deduplicates concurrent mount loads and shares loading state", async () => {
    let resolveProjects!: (projects: Project[]) => void;
    mockGetProjects.mockImplementation(
      () => new Promise<Project[]>((resolve) => {
        resolveProjects = resolve;
      })
    );

    const first = renderHook(() => useProjects());
    const second = renderHook(() => useProjects());

    expect(mockGetProjects).toHaveBeenCalledTimes(1);
    expect(first.result.current.isLoading).toBe(true);
    expect(second.result.current.isLoading).toBe(true);

    await act(async () => {
      resolveProjects([
        createMockProject({ id: "shared-project", name: "shared", order: 0 }),
      ]);
    });

    expect(first.result.current.isLoading).toBe(false);
    expect(second.result.current.isLoading).toBe(false);
    expect(first.result.current.projects.map((project) => project.id)).toEqual([
      "shared-project",
    ]);
  });

  test("shares load errors across concurrent hook instances", async () => {
    let rejectProjects!: (error: Error) => void;
    mockGetProjects.mockImplementation(
      () => new Promise<Project[]>((_, reject) => {
        rejectProjects = reject;
      })
    );

    const first = renderHook(() => useProjects());
    const second = renderHook(() => useProjects());

    expect(mockGetProjects).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectProjects(new Error("Shared load failed"));
    });

    expect(first.result.current.isLoading).toBe(false);
    expect(second.result.current.isLoading).toBe(false);
    expect(first.result.current.error).toBe("Shared load failed");
    expect(second.result.current.error).toBe("Shared load failed");
  });

  test("does not let a mount snapshot overwrite a completed add", async () => {
    let resolveSnapshot!: (projects: Project[]) => void;
    mockGetProjects.mockImplementation(
      () => new Promise<Project[]>((resolve) => {
        resolveSnapshot = resolve;
      })
    );

    const { result } = renderHook(() => useProjects());

    await act(async () => {
      await result.current.addProject("git@github.com:test/new.git");
    });
    expect(result.current.projects.map((project) => project.id)).toEqual(["new-project-id"]);

    await act(async () => {
      resolveSnapshot([]);
    });

    expect(result.current.projects.map((project) => project.id)).toEqual(["new-project-id"]);
  });

  test("a post-mutation load supersedes an older in-flight snapshot", async () => {
    const resolvers: Array<(projects: Project[]) => void> = [];
    mockGetProjects.mockImplementation(
      () => new Promise<Project[]>((resolve) => resolvers.push(resolve))
    );

    const { result } = renderHook(() => useProjects());
    expect(mockGetProjects).toHaveBeenCalledTimes(1);

    act(() => {
      useProjectStore.getState().addProject(
        createMockProject({ id: "locally-added", name: "local", order: 0 })
      );
    });

    let replacementLoad!: Promise<void>;
    act(() => {
      replacementLoad = result.current.loadProjects();
    });
    expect(mockGetProjects).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvers[0]?.([]);
      await Promise.resolve();
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.projects.map((project) => project.id)).toEqual(["locally-added"]);

    await act(async () => {
      resolvers[1]?.([
        createMockProject({ id: "authoritative", name: "backend", order: 0 }),
      ]);
      await replacementLoad;
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.projects.map((project) => project.id)).toEqual(["authoritative"]);
  });
});
