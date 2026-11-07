import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { environmentStore, projectStore, useFilesPanelStore, useUIStore } from "@/stores";
import { TerminalProvider } from "@/contexts/TerminalContext";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import type { Environment, Project } from "@/types";
import { setFilesPanelTestState } from "@/test/files-panel-state";
import { appCommandStore } from "@/test/app-command-store";

const originalBackend = { ...realBackend };
const deleteLocalFile = mock<(id: string, path: string) => Promise<string>>(
  async (_id, path) => path,
);
const folderTree = [{ name: "docs", path: "docs", isDirectory: true, children: [] }];
let remainingTree = folderTree;

let rejectHome: (error: Error) => void;
let resolveHome: (home: Environment) => void;
const ensureHome = mock(
  () =>
    new Promise<Environment>((resolve, reject) => {
      resolveHome = resolve;
      rejectHome = reject;
    }),
);
mock.module("@/lib/backend", () => ({
  ...originalBackend,
  ensureProjectHomeEnvironment: ensureHome,
  deleteLocalFile,
  getLocalFileTreeSnapshot: async () => ({
    unchanged: false,
    digest: JSON.stringify(remainingTree),
    value: remainingTree,
  }),
  getLocalGitStatusSnapshot: async () => ({ unchanged: false, digest: "[]", value: [] }),
}));
const { FilesPanel } = await import("./FilesPanel");
const { resetReadCoordinatorForTests } = await import("@/lib/read-coordinator");

beforeEach(() => {
  ensureHome.mockClear();
  deleteLocalFile.mockClear();
  deleteLocalFile.mockImplementation(async (_id, path) => path);
  remainingTree = folderTree;
  mockToastError.mockClear();
  appCommandStore(projectStore).setState({
    projects: [{ id: "project-1", localPath: "/checkout" } as Project],
  });
  useUIStore.setState({ selectedEnvironmentId: null, selectedProjectId: "project-1" });
  appCommandStore(environmentStore).setState({ environments: [] });
  setFilesPanelTestState({
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
  expect(
    appCommandStore(environmentStore)
      .getState()
      .environments.map((environment) => environment.id),
  ).toEqual(["home-1"]);
});

test("shows delayed announcements and a container's remote freshness without hiding the lists", async () => {
  const { useWorktreeSnapshotStore } = await import("@/stores/worktreeSnapshotStore");
  useUIStore.setState({ selectedEnvironmentId: "env-1", selectedProjectId: "project-1" });
  setFilesPanelTestState({ isOpen: false, activeTab: "changes" });
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

test("a failed board file open strips Electron's invoke prefix from its toast", async () => {
  render(
    <TerminalProvider>
      <FilesPanel />
    </TerminalProvider>,
  );
  act(() =>
    useFilesPanelStore.setState({
      fileTree: [{ name: "first.txt", path: "first.txt", isDirectory: false }],
    }),
  );
  fireEvent.click(screen.getByText("first.txt"));
  await act(async () =>
    rejectHome(
      new Error(
        "Error invoking remote method 'orkestrator:invoke': Error: checkout does not exist",
      ),
    ),
  );
  await waitFor(() =>
    expect(mockToastError).toHaveBeenCalledWith("Could not open the project home", {
      description: "checkout does not exist",
    }),
  );
  expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  expect(useFilesPanelStore.getState().pendingFileOpens).toEqual([]);
});

for (const fails of [false, true]) {
  test(`Delete folder runs the real menu/dialog/hook flow and ${fails ? "retains the failed action for retry" : "closes on success"}`, async () => {
    const environment = {
      id: "env-folder",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/checkout",
      status: "running",
    } as Environment;
    appCommandStore(environmentStore).setState({ environments: [environment] });
    useUIStore.setState({ selectedEnvironmentId: environment.id });
    render(
      <TerminalProvider>
        <FilesPanel />
      </TerminalProvider>,
    );
    act(() => useFilesPanelStore.setState({ fileTree: folderTree, expandedFolders: ["docs"] }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "docs" }));
    fireEvent.click(await screen.findByText("Delete folder"));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Delete folder?")).toBeTruthy();
    if (fails)
      deleteLocalFile.mockRejectedValueOnce(
        new Error("Cannot delete docs: nested Git repository at docs/vendor"),
      );
    else remainingTree = [];
    fireEvent.click(screen.getByRole("button", { name: /^Delete folder$/ }));
    await waitFor(() => expect(deleteLocalFile).toHaveBeenCalledWith("env-folder", "docs"));
    if (fails) {
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Failed to delete folder", {
          description: "Cannot delete docs: nested Git repository at docs/vendor",
        }),
      );
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(screen.getByRole("button", { name: /^Delete folder$/ }).hasAttribute("disabled")).toBe(
        false,
      );
      remainingTree = [];
      fireEvent.click(screen.getByRole("button", { name: /^Delete folder$/ }));
    }
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
    expect(useFilesPanelStore.getState().expandedFolders).not.toContain("docs");
    expect(useFilesPanelStore.getState().fileTree).toEqual([]);
    expect(deleteLocalFile).toHaveBeenCalledTimes(fails ? 2 : 1);
  });
}
