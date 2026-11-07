import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import * as realBackend from "@/lib/backend";
import { projectStore } from "@/stores/projectStore";
import { mockToastError } from "../../../../tests/mocks/sonner";
import { appCommandStore } from "@/test/app-command-store";

const originalBackend = { ...realBackend };
const addProject = mock(realBackend.addProject);
const createProjectFromScratch = mock(realBackend.createProjectFromScratch);
mock.module("@/lib/backend", () => ({
  ...originalBackend,
  getProjects: async () => [],
  addProject,
  createProjectFromScratch,
}));
const { useProjects } = await import("./useProjects");

beforeEach(() => {
  addProject.mockReset();
  createProjectFromScratch.mockReset();
  mockToastError.mockClear();
  appCommandStore(projectStore).setState({ projects: [], error: null, isLoading: false });
});
afterEach(cleanup);
afterAll(() => mock.module("@/lib/backend", () => originalBackend));

test.each(["add", "create"] as const)(
  "%s project strips Electron's prefix from the store, toast and rejection",
  async (operation) => {
    const reason = "SSH authentication failed on build-host. Load an authorized key.";
    const failure = new Error(
      `Error invoking remote method 'orkestrator:invoke': Error: ${reason}`,
    );
    addProject.mockRejectedValueOnce(failure);
    createProjectFromScratch.mockRejectedValueOnce(failure);
    const { result } = renderHookInAppCommandScope(() => useProjects());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      const request =
        operation === "add"
          ? result.current.addProject("git@example.invalid:org/repo.git", "/checkout")
          : result.current.createProjectFromScratch("/checkout");
      await expect(request).rejects.toThrow(reason);
      const error = await request.catch((error: Error) => error);
      expect((error as Error).message).toBe(reason);
    });
    expect(appCommandStore(projectStore).getState().error).toBe(reason);
    expect(appCommandStore(projectStore).getState().isLoading).toBe(false);
    expect(appCommandStore(projectStore).getState().projects).toEqual([]);
    expect(mockToastError).toHaveBeenCalledWith(
      operation === "add" ? "Failed to add project" : "Failed to create project",
      { description: reason },
    );
  },
);
