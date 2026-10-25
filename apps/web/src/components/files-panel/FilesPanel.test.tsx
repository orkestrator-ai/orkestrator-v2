import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { useEnvironmentStore, useFilesPanelStore, useProjectStore, useUIStore } from "@/stores";
import { TerminalProvider } from "@/contexts/TerminalContext";
import type { Environment, Project } from "@/types";

const originalBackend = { ...realBackend };
let resolveHome: (home: Environment) => void;
const ensureHome = mock(
  () =>
    new Promise<Environment>((resolve) => {
      resolveHome = resolve;
    }),
);
mock.module("@/lib/backend", () => ({
  ...originalBackend,
  ensureProjectHomeEnvironment: ensureHome,
}));
const { FilesPanel } = await import("./FilesPanel");
const { resetReadCoordinatorForTests } = await import("@/lib/read-coordinator");

beforeEach(() => {
  ensureHome.mockClear();
  useProjectStore.setState({ projects: [{ id: "project-1", localPath: "/checkout" } as Project] });
  useUIStore.setState({ selectedEnvironmentId: null, selectedProjectId: "project-1" });
  useEnvironmentStore.setState({ environments: [] });
  useFilesPanelStore.setState({
    isOpen: false,
    activeTab: "all-files",
    pendingFileOpens: [],
    fileTree: [],
  });
});
afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
});
afterAll(() => {
  mock.module("@/lib/backend", () => originalBackend);
});

test("two board file opens wait for home creation and retain their order", async () => {
  render(
    <TerminalProvider>
      <FilesPanel />
    </TerminalProvider>,
  );
  act(() =>
    useFilesPanelStore.setState({
      fileTree: [
        { name: "first.txt", path: "first.txt", isDirectory: false },
        { name: "second.txt", path: "second.txt", isDirectory: false },
      ],
    }),
  );
  fireEvent.click(screen.getByText("first.txt"));
  fireEvent.click(screen.getByText("second.txt"));
  expect(ensureHome).toHaveBeenCalledTimes(1);
  expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  await act(async () =>
    resolveHome({
      id: "home-1",
      projectId: "project-1",
      projectHome: true,
      worktreePath: "/checkout",
      environmentType: "local",
      status: "running",
    } as Environment),
  );
  await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe("home-1"));
  expect(useUIStore.getState().projectBoardTab).toBe("home");
  expect(useFilesPanelStore.getState().pendingFileOpens.map((request) => request.filePath)).toEqual(
    ["first.txt", "second.txt"],
  );
  expect(useEnvironmentStore.getState().environments.map((environment) => environment.id)).toEqual([
    "home-1",
  ]);
});

test("shows delayed announcements and a container's remote freshness without hiding the lists", async () => {
  const { useWorktreeSnapshotStore } = await import("@/stores/worktreeSnapshotStore");
  useUIStore.setState({ selectedEnvironmentId: "env-1", selectedProjectId: "project-1" });
  useFilesPanelStore.setState({ isOpen: false, activeTab: "changes" });
  useWorktreeSnapshotStore.setState({
    syncStatus: "current",
    entries: new Map([
      [
        "env-1",
        {
          environmentId: "env-1",
          targetGeneration: 1,
          comparisonRef: "origin/main",
          fileListRevision: 1,
          treeRevision: 1,
          freshness: "current",
          watched: false,
          remote: { state: "current" },
        },
      ],
    ]),
  });
  try {
    render(
      <TerminalProvider>
        <FilesPanel />
      </TerminalProvider>,
    );
    expect(document.querySelector("[data-freshness]") === null).toBe(true);

    act(() => {
      useWorktreeSnapshotStore.getState().setSyncStatus("degraded");
      useWorktreeSnapshotStore.getState().applyChange({
        ...useWorktreeSnapshotStore.getState().entries.get("env-1")!,
        remote: { state: "stale", failure: "network" },
      });
    });
    expect(document.querySelector('[data-freshness="degraded"]')?.textContent).toContain(
      "periodic re-read",
    );
    const remote = document.querySelector('[data-freshness="remote-stale"]');
    expect(remote?.textContent).toContain("origin/main");
    expect(remote?.textContent).toContain("exact");

    // The remote baseline belongs to the Changes tab only.
    act(() => useFilesPanelStore.setState({ activeTab: "all-files" }));
    expect(document.querySelector('[data-freshness="remote-stale"]') === null).toBe(true);

    act(() => useWorktreeSnapshotStore.getState().setSyncStatus("current"));
    expect(document.querySelector("[data-freshness]") === null).toBe(true);
  } finally {
    useWorktreeSnapshotStore.setState({ entries: new Map(), generation: null, syncStatus: "idle" });
  }
});
