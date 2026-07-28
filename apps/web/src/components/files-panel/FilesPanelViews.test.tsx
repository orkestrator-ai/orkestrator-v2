import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { TerminalProvider, useTerminalContext } from "@/contexts";
import { useFilesPanelStore } from "@/stores";
import type { FileNode, GitFileChange } from "@/lib/backend";
import { restoreMatchMedia, setMobileViewport } from "../../../../../tests/mocks/match-media";
import { AllFilesView } from "./AllFilesView";
import { ChangesView } from "./ChangesView";
import { FileTreeNode } from "./FileTreeNode";
import { FilesPanelHeader } from "./FilesPanelHeader";

const createFileTab = mock(() => undefined);

function RegisterFileTab() {
  const { setCreateFileTab } = useTerminalContext();
  useEffect(() => {
    setCreateFileTab(createFileTab);
    return () => setCreateFileTab(null);
  }, [setCreateFileTab]);
  return null;
}

function renderWithTerminal(children: React.ReactNode) {
  return render(
    <TerminalProvider>
      <RegisterFileTab />
      {children}
    </TerminalProvider>,
  );
}

const change: GitFileChange = {
  path: "src/App.tsx",
  filename: "App.tsx",
  directory: "src",
  status: "M",
  additions: 2,
  deletions: 1,
};

const fileTree: FileNode[] = [{
  name: "src",
  path: "src",
  isDirectory: true,
  children: [{
    name: "App.tsx",
    path: "src/App.tsx",
    isDirectory: false,
  }],
}];

describe("files panel views", () => {
  beforeEach(() => {
    createFileTab.mockClear();
    setMobileViewport(false);
    useFilesPanelStore.setState({
      isOpen: true,
      activeTab: "changes",
      expandedFolders: [],
      changes: [],
      isLoadingChanges: false,
      fileTree: [],
      isLoadingTree: false,
      targetBranch: "main",
    });
  });

  afterEach(() => {
    cleanup();
    restoreMatchMedia();
  });

  test("AllFilesView covers loading, empty, and opening a file", async () => {
    useFilesPanelStore.setState({ isLoadingTree: true });
    const view = renderWithTerminal(<AllFilesView />);
    expect(screen.getByText("Loading files...")).toBeTruthy();

    act(() => useFilesPanelStore.setState({ isLoadingTree: false, fileTree: [] }));
    expect(screen.getByText("No files found")).toBeTruthy();

    act(() => useFilesPanelStore.setState({
      fileTree,
      expandedFolders: ["src"],
      changes: [change],
    }));
    await waitFor(() => expect(screen.getByText("App.tsx")).toBeTruthy());
    fireEvent.click(screen.getByText("App.tsx"));
    expect(createFileTab).toHaveBeenCalledWith("src/App.tsx");
    view.unmount();
  });

  test("ChangesView covers loading, empty, and diff opening on mobile", async () => {
    setMobileViewport(true);
    useFilesPanelStore.setState({ isLoadingChanges: true });
    renderWithTerminal(<ChangesView />);
    expect(screen.getByText("Loading changes...")).toBeTruthy();

    act(() => useFilesPanelStore.setState({ isLoadingChanges: false, changes: [] }));
    expect(screen.getByText("No changes")).toBeTruthy();

    act(() => useFilesPanelStore.setState({ changes: [change] }));
    await waitFor(() => expect(screen.getByTitle("src/App.tsx")).toBeTruthy());
    fireEvent.click(screen.getByTitle("src/App.tsx"));
    expect(createFileTab).toHaveBeenCalledWith("src/App.tsx", {
      isDiff: true,
      gitStatus: "M",
    });
    expect(useFilesPanelStore.getState().isOpen).toBe(false);
  });

  test("FileTreeNode expands folders and exposes changed-file actions", async () => {
    const onRevert = mock(() => undefined);
    const onDelete = mock(() => undefined);
    render(
      <FileTreeNode
        item={fileTree[0]!}
        depth={0}
        changedPaths={new Set(["src/App.tsx"])}
        onRevert={onRevert}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "src" }));
    expect(useFilesPanelStore.getState().expandedFolders).toContain("src");
    const fileButton = await screen.findByRole("button", { name: "App.tsx" });
    fireEvent.contextMenu(fileButton);
    const revert = await screen.findByText("Revert");
    fireEvent.click(revert);
    expect(onRevert).toHaveBeenCalledWith("src/App.tsx");
    fireEvent.contextMenu(fileButton);
    fireEvent.click(await screen.findByText("Delete file"));
    expect(onDelete).toHaveBeenCalledWith("src/App.tsx");
  });

  test("FilesPanelHeader switches tabs, reports count, refreshes, and closes", () => {
    const onRefresh = mock(() => undefined);
    useFilesPanelStore.setState({ changes: [change] });
    const { container } = render(<FilesPanelHeader onRefresh={onRefresh} />);
    expect(screen.getByText("1")).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "All files" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(useFilesPanelStore.getState().activeTab).toBe("all-files");

    const iconButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.querySelector("svg"),
    );
    fireEvent.click(iconButtons.at(-2)!);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(iconButtons.at(-1)!);
    expect(useFilesPanelStore.getState().isOpen).toBe(false);
  });
});
