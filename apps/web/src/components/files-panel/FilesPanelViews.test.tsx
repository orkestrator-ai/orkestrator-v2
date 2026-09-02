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

const fileTree: FileNode[] = [
  {
    name: "src",
    path: "src",
    isDirectory: true,
    children: [
      {
        name: "App.tsx",
        path: "src/App.tsx",
        isDirectory: false,
      },
    ],
  },
  {
    name: "archive",
    path: "archive",
    isDirectory: true,
    children: [],
  },
];

function createDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: (type?: string) => {
      if (type) values.delete(type);
      else values.clear();
    },
    getData: (type: string) => values.get(type) ?? "",
    setData(type: string, value: string) {
      values.set(type, value);
      (this.types as string[]).splice(0, this.types.length, ...values.keys());
    },
    setDragImage: () => undefined,
  } as DataTransfer;
}

function fireDrag(target: Element, type: string, dataTransfer: DataTransfer): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  fireEvent(target, event);
}

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

    act(() =>
      useFilesPanelStore.setState({
        fileTree,
        expandedFolders: ["src"],
        changes: [change],
      }),
    );
    await waitFor(() => expect(screen.getByText("App.tsx")).toBeTruthy());
    const fileButton = screen.getByRole("button", { name: "App.tsx" });
    expect(fileButton.getAttribute("draggable")).toBe("false");
    fireEvent.click(fileButton);
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
    const onReveal = mock(() => undefined);
    const onRevert = mock(() => undefined);
    const onDelete = mock(() => undefined);
    render(
      <FileTreeNode
        item={fileTree[0]!}
        depth={0}
        changedPaths={new Set(["src/App.tsx"])}
        onReveal={onReveal}
        onRevert={onRevert}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "src" }));
    expect(useFilesPanelStore.getState().expandedFolders).toContain("src");
    const fileButton = await screen.findByRole("button", { name: "App.tsx" });
    fireEvent.contextMenu(fileButton);
    fireEvent.click(await screen.findByText("Reveal in file manager"));
    expect(onReveal).toHaveBeenCalledWith("src/App.tsx");
    fireEvent.contextMenu(fileButton);
    const revert = await screen.findByText("Revert");
    fireEvent.click(revert);
    expect(onRevert).toHaveBeenCalledWith("src/App.tsx");
    fireEvent.contextMenu(fileButton);
    fireEvent.click(await screen.findByText("Delete file"));
    expect(onDelete).toHaveBeenCalledWith("src/App.tsx");
  });

  test("FileTreeNode drags a file onto a destination folder", async () => {
    const onMove = mock(() => undefined);
    useFilesPanelStore.setState({ fileTree, expandedFolders: ["src"] });
    renderWithTerminal(<AllFilesView onMove={onMove} onDelete={() => undefined} />);

    const fileButton = await screen.findByRole("button", { name: "App.tsx" });
    const destination = screen.getByRole("button", { name: "archive" });
    const dataTransfer = createDataTransfer();

    expect(fileButton.getAttribute("draggable")).toBe("true");
    fireDrag(fileButton, "dragstart", dataTransfer);
    expect(dataTransfer.effectAllowed).toBe("move");
    fireDrag(destination, "dragover", dataTransfer);
    expect(destination.className).toContain("ring-primary/60");
    fireDrag(destination, "drop", dataTransfer);

    expect(onMove).toHaveBeenCalledWith("src/App.tsx", "archive");
    expect(useFilesPanelStore.getState().expandedFolders).toContain("archive");
  });

  test("offers an explicit Move to dialog for keyboard and touch users", async () => {
    const onMove = mock(() => undefined);
    useFilesPanelStore.setState({ fileTree, expandedFolders: ["src"] });
    renderWithTerminal(<AllFilesView onMove={onMove} />);

    fireEvent.click(await screen.findByRole("button", { name: "Move App.tsx to another folder" }));
    expect(await screen.findByRole("dialog", { name: "Move file" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "archive" }));
    expect(onMove).toHaveBeenCalledWith("src/App.tsx", "archive");

    fireEvent.contextMenu(screen.getByRole("button", { name: "App.tsx" }));
    fireEvent.click(await screen.findByText("Move to…"));
    expect(screen.getByRole("option", { name: "src" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("option", { name: "Workspace root" }));
    expect(onMove).toHaveBeenLastCalledWith("src/App.tsx", ".");
  });

  test("moves nested files to the root and suppresses same-parent drops", async () => {
    const onMove = mock(() => undefined);
    useFilesPanelStore.setState({ fileTree, expandedFolders: ["src"] });
    renderWithTerminal(<AllFilesView onMove={onMove} />);
    const fileButton = await screen.findByRole("button", { name: "App.tsx" });
    const sourceFolder = screen.getByRole("button", { name: "src" });
    const rootTarget = screen.getByLabelText("Workspace root drop target");

    const sameParentTransfer = createDataTransfer();
    fireDrag(fileButton, "dragstart", sameParentTransfer);
    fireDrag(sourceFolder, "drop", sameParentTransfer);
    expect(onMove).not.toHaveBeenCalled();

    const rootTransfer = createDataTransfer();
    fireDrag(fileButton, "dragstart", rootTransfer);
    fireDrag(rootTarget, "dragover", rootTransfer);
    expect(rootTarget.className).toContain("ring-primary/60");
    fireDrag(rootTarget, "drop", rootTransfer);
    expect(onMove).toHaveBeenCalledWith("src/App.tsx", ".");
  });

  test("ignores foreign drags, clears hover state, and disables moves while pending", async () => {
    const onMove = mock(() => undefined);
    useFilesPanelStore.setState({ fileTree, expandedFolders: ["src"] });
    const view = renderWithTerminal(<AllFilesView onMove={onMove} />);
    const destination = screen.getByRole("button", { name: "archive" });
    const foreignTransfer = createDataTransfer();
    foreignTransfer.setData("text/plain", "src/App.tsx");
    fireDrag(destination, "dragover", foreignTransfer);
    expect(destination.className).not.toContain("ring-primary/60");
    fireDrag(destination, "drop", foreignTransfer);
    expect(onMove).not.toHaveBeenCalled();

    const emptyWorkspaceTransfer = createDataTransfer();
    emptyWorkspaceTransfer.setData("application/x-orkestrator-workspace-file", "");
    fireDrag(destination, "drop", emptyWorkspaceTransfer);
    expect(onMove).not.toHaveBeenCalled();

    const workspaceTransfer = createDataTransfer();
    workspaceTransfer.setData("application/x-orkestrator-workspace-file", "src/App.tsx");
    fireDrag(destination, "dragover", workspaceTransfer);
    expect(destination.className).toContain("ring-primary/60");
    fireDrag(destination, "dragleave", workspaceTransfer);
    expect(destination.className).not.toContain("ring-primary/60");

    view.rerender(
      <TerminalProvider>
        <RegisterFileTab />
        <AllFilesView onMove={onMove} movePending />
      </TerminalProvider>,
    );
    expect(screen.getByRole("button", { name: "App.tsx" }).getAttribute("draggable")).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Move App.tsx to another folder" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireDrag(screen.getByRole("button", { name: "archive" }), "drop", workspaceTransfer);
    expect(onMove).not.toHaveBeenCalled();
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

    const iconButtons = Array.from(container.querySelectorAll("button")).filter((button) =>
      button.querySelector("svg"),
    );
    fireEvent.click(iconButtons.at(-2)!);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(iconButtons.at(-1)!);
    expect(useFilesPanelStore.getState().isOpen).toBe(false);
  });
});
