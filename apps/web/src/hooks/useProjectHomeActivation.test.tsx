import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import type { Environment, Project } from "@/types";

const originalBackend = { ...realBackend };
const home = {
  id: "home-1",
  projectId: "project-1",
  projectHome: true,
  worktreePath: "/checkout",
  environmentType: "local",
  status: "running",
  prUrl: "https://github.com/org/repo/pull/7",
} as Environment;
const ensureHome = mock(async (_projectId: string) => home);
mock.module("@/lib/backend", () => ({
  ...originalBackend,
  ensureProjectHomeEnvironment: ensureHome,
}));
const { useProjectHomeActivation } = await import("./useProjectHomeActivation");

beforeEach(() => {
  ensureHome.mockClear();
  useProjectStore.setState({
    projects: [
      { id: "project-1", localPath: "/checkout" } as Project,
      { id: "project-remote", localPath: null } as unknown as Project,
    ],
  });
  useUIStore.setState({
    selectedEnvironmentId: null,
    selectedProjectId: null,
    projectBoardTab: "coordinator",
  });
  useEnvironmentStore.setState({ environments: [] });
});
afterEach(cleanup);
afterAll(() => {
  mock.module("@/lib/backend", () => originalBackend);
});

test("selecting a project creates and activates its home", async () => {
  renderHook(() => useProjectHomeActivation());

  act(() => useUIStore.getState().selectProject("project-1"));

  await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe("home-1"));
  expect(ensureHome).toHaveBeenCalledWith("project-1");
  expect(useEnvironmentStore.getState().environments.map((entry) => entry.id)).toEqual(["home-1"]);
});

test("a known home is activated without waiting for the backend", () => {
  useEnvironmentStore.setState({ environments: [home] });
  ensureHome.mockImplementationOnce(() => new Promise<Environment>(() => {}));
  renderHook(() => useProjectHomeActivation());

  act(() => useUIStore.getState().selectProject("project-1"));

  expect(useUIStore.getState().selectedEnvironmentId).toBe("home-1");
  // PR controls wait for the reconciled record of the checkout's branch.
  expect(useEnvironmentStore.getState().environments[0]?.prUrl).toBeNull();
});

test("a regular environment selection is left alone", () => {
  useEnvironmentStore.setState({ environments: [home] });
  renderHook(() => useProjectHomeActivation());

  act(() => useUIStore.getState().selectProjectAndEnvironment("project-1", "worker-1"));

  expect(useUIStore.getState().selectedEnvironmentId).toBe("worker-1");
  expect(ensureHome).not.toHaveBeenCalled();
});

test("a project without a checkout keeps the board and leaves the Home tab", () => {
  useUIStore.setState({ projectBoardTab: "home" });
  renderHook(() => useProjectHomeActivation());

  act(() => useUIStore.getState().selectProject("project-remote"));

  expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  expect(useUIStore.getState().projectBoardTab).toBe("coordinator");
  expect(ensureHome).not.toHaveBeenCalled();
});
