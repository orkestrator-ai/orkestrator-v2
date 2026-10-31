import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import { ProjectWorkspace } from "@/components/projects/ProjectWorkspace";
import { activateProjectForEnvironmentCleanup } from "@/lib/environment-cleanup-selection";
import { mockToastError } from "../../../../tests/mocks/sonner";
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
  prState: "open",
  hasMergeConflicts: true,
} as Environment;
const ensureHome = mock(async (_projectId: string) => home);
const setUnread = mock(async (_id: string, _unread: boolean, _observed: string | null) => ({
  ...home,
  hasUnreadWork: false,
}));
mock.module("@/lib/backend", () => ({
  ...originalBackend,
  ensureProjectHomeEnvironment: ensureHome,
  setEnvironmentUnread: setUnread,
}));
const { useProjectHomeActivation } = await import("./useProjectHomeActivation");

beforeEach(() => {
  setUnread.mockClear();
  ensureHome.mockReset();
  ensureHome.mockResolvedValue(home);
  mockToastError.mockClear();
  useProjectStore.setState({
    deletingProjects: new Set(),
    projects: [
      { id: "project-1", localPath: "/checkout" } as Project,
      { id: "project-2", localPath: "/second" } as Project,
      { id: "project-remote", localPath: null } as unknown as Project,
    ],
  });
  useUIStore.setState({
    selectedEnvironmentId: null,
    selectedProjectId: null,
    projectBoardTab: "coordinator",
  });
  useEnvironmentStore.setState({ environments: [], deletingEnvironments: new Set() });
});
afterEach(cleanup);
afterAll(() => mock.module("@/lib/backend", () => originalBackend));

test("selecting a project creates and activates its home", async () => {
  renderHook(() => useProjectHomeActivation());
  act(() => useUIStore.getState().selectProject("project-1"));
  await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe("home-1"));
  expect(ensureHome).toHaveBeenCalledTimes(1);
  expect(useEnvironmentStore.getState().environments.map((entry) => entry.id)).toEqual(["home-1"]);
});

test("known homes activate immediately and retain PR metadata through reconciliation failure", async () => {
  useEnvironmentStore.setState({ environments: [home] });
  let reject!: (error: Error) => void;
  ensureHome.mockImplementationOnce(
    () =>
      new Promise<Environment>((_, fail) => {
        reject = fail;
      }),
  );
  const { result } = renderHook(() => useProjectHomeActivation());
  act(() => useUIStore.getState().selectProject("project-1"));
  expect(useUIStore.getState().selectedEnvironmentId).toBe("home-1");
  expect(useEnvironmentStore.getState().environments[0]).toMatchObject({
    prUrl: home.prUrl,
    prState: "open",
    hasMergeConflicts: true,
  });
  await act(async () => reject(new Error("offline")));
  await waitFor(() => expect(result.current.error).toBe("offline"));
  expect(mockToastError).toHaveBeenCalled();
  expect(useEnvironmentStore.getState().environments[0]?.prUrl).toBe(home.prUrl);
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.error).toBeNull());
  expect(ensureHome).toHaveBeenCalledTimes(2);
  expect(useEnvironmentStore.getState().environments[0]?.prUrl).toBe(home.prUrl);
});

test("a failure shows the backend's reason without Electron's invoke prefix", async () => {
  ensureHome.mockRejectedValueOnce(
    new Error("Error invoking remote method 'orkestrator:invoke': Error: checkout does not exist"),
  );
  const { result } = renderHook(() => useProjectHomeActivation());
  act(() => useUIStore.getState().selectProject("project-1"));
  await waitFor(() => expect(result.current.error).toBe("checkout does not exist"));
  expect(mockToastError).toHaveBeenCalledWith(
    "Could not open the project home",
    expect.objectContaining({ description: "checkout does not exist" }),
  );
});

test("failed Home creation replaces the spinner with a retryable error", async () => {
  ensureHome.mockRejectedValueOnce(new Error("checkout unavailable"));
  function Workspace() {
    const activation = useProjectHomeActivation();
    return (
      <ProjectWorkspace
        projectId="project-1"
        homeError={activation.error}
        onRetryHome={activation.retry}
      />
    );
  }
  useUIStore.setState({ selectedProjectId: "project-1", projectBoardTab: "home" });
  render(<Workspace />);
  await screen.findByRole("alert");
  expect(screen.queryByText("Opening project home…") === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry opening Home" }));
  await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe("home-1"));
  expect(ensureHome).toHaveBeenCalledTimes(2);
});

test("checkout changes reconcile the selected home, and removal leaves Home", async () => {
  useEnvironmentStore.setState({ environments: [home] });
  useUIStore.setState({
    selectedProjectId: "project-1",
    selectedEnvironmentId: home.id,
    projectBoardTab: "home",
  });
  renderHook(() => useProjectHomeActivation());
  await waitFor(() => expect(ensureHome).toHaveBeenCalledTimes(1));
  await act(async () => {
    await Promise.resolve();
  });
  ensureHome.mockResolvedValueOnce({
    ...home,
    worktreePath: "/second",
    branch: "next",
    prUrl: null,
  });
  act(() => useProjectStore.getState().updateProject("project-1", { localPath: "/second" }));
  await waitFor(() =>
    expect(useEnvironmentStore.getState().environments[0]?.worktreePath).toBe("/second"),
  );
  expect(useEnvironmentStore.getState().environments[0]?.branch).toBe("next");
  act(() => useProjectStore.getState().updateProject("project-1", { localPath: null }));
  expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  expect(useUIStore.getState().projectBoardTab).toBe("coordinator");
  expect(ensureHome).toHaveBeenCalledTimes(2);
});

test("a regular environment selection is left alone", () => {
  renderHook(() => useProjectHomeActivation());
  act(() => useUIStore.getState().selectProjectAndEnvironment("project-1", "worker-1"));
  expect(useUIStore.getState().selectedEnvironmentId).toBe("worker-1");
  expect(ensureHome).not.toHaveBeenCalled();
});

test("a project without a checkout leaves the Home tab", () => {
  useUIStore.setState({ selectedProjectId: "project-remote", projectBoardTab: "home" });
  renderHook(() => useProjectHomeActivation());
  expect(useUIStore.getState().projectBoardTab).toBe("coordinator");
  expect(ensureHome).not.toHaveBeenCalled();
});

for (const deleting of ["local", "lifecycle", "requested", "project"]) {
  test(`selecting a project during ${deleting} deletion neither selects nor ensures Home`, () => {
    useEnvironmentStore.setState({
      environments: [
        {
          ...home,
          ...(deleting === "lifecycle" ? { lifecycleOperation: "deleting" } : {}),
          ...(deleting === "requested" ? { deletionRequestedAt: "2026-10-11" } : {}),
        },
      ],
      deletingEnvironments: new Set(deleting === "local" ? [home.id] : []),
    });
    if (deleting === "project") useProjectStore.getState().setDeleting("project-1", true);
    renderHook(() => useProjectHomeActivation());
    act(() => useUIStore.getState().selectProject("project-1"));
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    expect(ensureHome).not.toHaveBeenCalled();
  });
}

test("cleanup leaves the selected Home without recreating it when its record disappears", () => {
  useEnvironmentStore.setState({ environments: [home], deletingEnvironments: new Set([home.id]) });
  useUIStore.setState({ selectedProjectId: "project-1", selectedEnvironmentId: home.id });
  renderHook(() => useProjectHomeActivation());
  act(() => {
    activateProjectForEnvironmentCleanup(home.id);
    useEnvironmentStore.getState().removeEnvironment(home.id);
  });
  expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  expect(ensureHome).not.toHaveBeenCalled();
});

test("late activation cannot steal selection after switching projects or choosing a worker", async () => {
  let resolve!: (home: Environment) => void;
  ensureHome.mockImplementationOnce(
    () =>
      new Promise<Environment>((done) => {
        resolve = done;
      }),
  );
  useUIStore.setState({ selectedProjectId: "project-1" });
  renderHook(() => useProjectHomeActivation());
  act(() => useUIStore.getState().selectProjectAndEnvironment("project-2", "worker-2"));
  await act(async () => resolve(home));
  expect(useUIStore.getState().selectedEnvironmentId).toBe("worker-2");
  expect(useUIStore.getState().selectedProjectId).toBe("project-2");
});

test("a late checkout response does not replace the new checkout record", async () => {
  let resolve!: (home: Environment) => void;
  ensureHome.mockImplementationOnce(
    () =>
      new Promise<Environment>((done) => {
        resolve = done;
      }),
  );
  useUIStore.setState({ selectedProjectId: "project-1" });
  renderHook(() => useProjectHomeActivation());
  ensureHome.mockResolvedValueOnce({ ...home, worktreePath: "/second" });
  act(() => useProjectStore.getState().updateProject("project-1", { localPath: "/second" }));
  await waitFor(() =>
    expect(useEnvironmentStore.getState().environments[0]?.worktreePath).toBe("/second"),
  );
  await act(async () => resolve(home));
  expect(useEnvironmentStore.getState().environments[0]?.worktreePath).toBe("/second");
});

test("a project selected during cleanup does not recreate Home when the tombstone disappears", async () => {
  useEnvironmentStore.setState({ environments: [{ ...home, lifecycleOperation: "deleting" }] });
  renderHook(() => useProjectHomeActivation());
  act(() => useUIStore.getState().selectProject("project-1"));
  act(() => useEnvironmentStore.getState().removeEnvironment(home.id));
  expect(ensureHome).not.toHaveBeenCalled();
  expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  act(() => useUIStore.getState().selectProject("project-1"));
  await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe(home.id));
  expect(ensureHome).toHaveBeenCalledTimes(1);
});

test("automatic Home targeting leaves board unread work untouched until Home is shown", async () => {
  const { useUnreadEnvironmentSync } = await import("./useUnreadEnvironmentSync");
  ensureHome.mockResolvedValueOnce({ ...home, hasUnreadWork: true });
  renderHook(() => {
    useProjectHomeActivation();
    useUnreadEnvironmentSync();
  });
  act(() => useUIStore.getState().selectProject("project-1"));
  await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe(home.id));
  expect(useUIStore.getState().projectBoardTab).toBe("coordinator");
  expect(useEnvironmentStore.getState().environments[0]?.hasUnreadWork).toBe(true);
  expect(setUnread).not.toHaveBeenCalled();
  act(() => useUIStore.getState().setProjectBoardTab("home"));
  await waitFor(() => expect(setUnread).toHaveBeenCalledWith(home.id, false, null));
});

test("a late rejection after switching projects does not surface a stale Home error", async () => {
  let reject!: (error: Error) => void;
  ensureHome.mockImplementationOnce(
    () =>
      new Promise<Environment>((_, fail) => {
        reject = fail;
      }),
  );
  useUIStore.setState({ selectedProjectId: "project-1" });
  const { result } = renderHook(() => useProjectHomeActivation());
  act(() => useUIStore.getState().selectProjectAndEnvironment("project-2", "worker-2"));
  await act(async () => reject(new Error("old checkout failed")));
  expect(result.current.error).toBeNull();
  expect(mockToastError).not.toHaveBeenCalled();
});
