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
  expect(useFilesPanelStore.getState().pendingFileOpens.map((request) => request.filePath)).toEqual(
    ["first.txt", "second.txt"],
  );
  expect(useEnvironmentStore.getState().environments.map((environment) => environment.id)).toEqual([
    "home-1",
  ]);
});
