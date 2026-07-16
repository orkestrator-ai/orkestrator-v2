import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalProvider } from "../../../apps/web/src/contexts/TerminalContext";
import { useFilesPanelStore } from "../../../apps/web/src/stores/filesPanelStore";
import type { FileNode, GitFileChange } from "../../../apps/web/src/lib/backend";
import * as realHooks from "@/hooks";
import * as realContextMenu from "@/components/ui/context-menu";
import type { ReactNode } from "react";

const realHooksSnapshot = { ...realHooks };
const realContextMenuSnapshot = { ...realContextMenu };
const refreshMock = mock(() => {});
const revertFileMock = mock(async () => {});
const deleteFileMock = mock(async () => {});

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useFilesPanel: () => ({
    refresh: refreshMock,
    loadChanges: mock(() => {}),
    loadFileTree: mock(() => {}),
    isAvailable: true,
    containerId: "container-1",
    worktreePath: null,
    isLocalEnvironment: false,
    revertFile: revertFileMock,
    deleteFile: deleteFileMock,
    fileActionPending: null,
  }),
}));

mock.module("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => <button onClick={onSelect}>{children}</button>,
}));

const { ChangedFileItem } = await import("../../../apps/web/src/components/files-panel/ChangedFileItem");
const { FileTreeNode } = await import("../../../apps/web/src/components/files-panel/FileTreeNode");
const { FilesPanelHeader } = await import("../../../apps/web/src/components/files-panel/FilesPanelHeader");
const { FilesPanel } = await import("../../../apps/web/src/components/files-panel/FilesPanel");

const change: GitFileChange = {
  path: "src/components/Button.tsx",
  filename: "Button.tsx",
  directory: "src/components",
  additions: 12,
  deletions: 3,
  status: "M",
};

const fileTree: FileNode[] = [
  {
    name: "src",
    path: "src",
    isDirectory: true,
    children: [{ name: "App.tsx", path: "src/App.tsx", isDirectory: false }],
  },
];

const nestedFileTree: FileNode[] = [
  {
    name: "src",
    path: "src",
    isDirectory: true,
    children: [
      {
        name: "components",
        path: "src/components",
        isDirectory: true,
        children: [
          { name: "Button.tsx", path: "src/components/Button.tsx", isDirectory: false },
        ],
      },
    ],
  },
];

describe("Files panel components", () => {
  afterEach(() => {
    cleanup();
    refreshMock.mockClear();
    revertFileMock.mockClear();
    deleteFileMock.mockClear();
    useFilesPanelStore.setState({
      isOpen: false,
      activeTab: "changes",
      expandedFolders: [],
      changes: [],
      isLoadingChanges: false,
      fileTree: [],
      isLoadingTree: false,
    });
  });

  afterAll(() => {
    mock.module("@/hooks", () => realHooksSnapshot);
    mock.module("@/components/ui/context-menu", () => realContextMenuSnapshot);
  });

  test("ChangedFileItem renders directory, filename, stats, and click target", () => {
    const onClick = mock(() => {});
    render(<ChangedFileItem change={change} onClick={onClick} />);

    expect(screen.getByText("src/components/")).toBeTruthy();
    expect(screen.getByText("Button.tsx")).toBeTruthy();
    expect(screen.getByText("+12").className).toContain("text-green-500");
    expect(screen.getByText("-3").className).toContain("text-red-400");

    fireEvent.click(screen.getByTitle("src/components/Button.tsx"));
    expect(onClick).toHaveBeenCalledWith("src/components/Button.tsx");
  });

  test("ChangedFileItem exposes revert and delete context actions", () => {
    const onRevert = mock(() => {});
    const onDelete = mock(() => {});
    render(
      <ChangedFileItem
        change={change}
        onRevert={onRevert}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));

    expect(onRevert).toHaveBeenCalledWith("src/components/Button.tsx");
    expect(onDelete).toHaveBeenCalledWith("src/components/Button.tsx");
  });

  test("all-files rows always expose delete and only changed files expose revert", () => {
    const file: FileNode = { name: "App.tsx", path: "src/App.tsx", isDirectory: false };
    const onRevert = mock(() => {});
    const onDelete = mock(() => {});
    const { rerender } = render(
      <FileTreeNode
        item={file}
        depth={0}
        changedPaths={new Set([file.path])}
        onRevert={onRevert}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByRole("button", { name: "Revert" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete file" })).toBeTruthy();

    rerender(
      <FileTreeNode
        item={file}
        depth={0}
        changedPaths={new Set()}
        onRevert={onRevert}
        onDelete={onDelete}
      />,
    );

    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete file" })).toBeTruthy();
  });

  test("FilesPanelHeader shows changed count and refresh loading state", () => {
    useFilesPanelStore.setState({
      activeTab: "changes",
      changes: [change],
      isLoadingChanges: true,
      isLoadingTree: false,
    });

    render(<FilesPanelHeader onRefresh={refreshMock} />);

    expect(screen.getByText("1")).toBeTruthy();
    const refreshButton = screen.getAllByRole("button").find((button) =>
      button.querySelector(".animate-spin"),
    ) as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(true);
  });

  test("FilesPanel renders the panel surface and switches between tab views", () => {
    useFilesPanelStore.setState({
      activeTab: "all-files",
      fileTree: [],
      changes: [change],
    });

    const { container, rerender } = render(
      <TerminalProvider>
        <FilesPanel />
      </TerminalProvider>,
    );

    expect(container.firstElementChild?.className).toContain("bg-zinc-900");
    expect(screen.getByText("No files found")).toBeTruthy();

    act(() => {
      useFilesPanelStore.setState({ activeTab: "changes" });
    });
    rerender(
      <TerminalProvider>
        <FilesPanel />
      </TerminalProvider>,
    );
    expect(screen.getByText("src/components/")).toBeTruthy();
  });

  test("All files folders are collapsed by default and expand on click", () => {
    useFilesPanelStore.setState({
      activeTab: "all-files",
      expandedFolders: [],
      fileTree,
    });

    render(
      <TerminalProvider>
        <FilesPanel />
      </TerminalProvider>,
    );

    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.queryByText("App.tsx")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /src/i }));

    expect(screen.getByText("App.tsx")).toBeTruthy();
    expect(useFilesPanelStore.getState().expandedFolders).toEqual(["src"]);
  });

  test("clicking an expanded folder collapses it and hides its children", () => {
    useFilesPanelStore.setState({
      activeTab: "all-files",
      expandedFolders: ["src"],
      fileTree,
    });

    render(
      <TerminalProvider>
        <FilesPanel />
      </TerminalProvider>,
    );

    // Starts expanded because "src" is in expandedFolders.
    expect(screen.getByText("App.tsx")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /src/i }));

    expect(screen.queryByText("App.tsx")).toBeNull();
    expect(useFilesPanelStore.getState().expandedFolders).toEqual([]);
  });

  test("nested folders stay collapsed until their own parent row is clicked", () => {
    useFilesPanelStore.setState({
      activeTab: "all-files",
      expandedFolders: ["src"],
      fileTree: nestedFileTree,
    });

    render(
      <TerminalProvider>
        <FilesPanel />
      </TerminalProvider>,
    );

    // Expanding the parent reveals the nested folder row but NOT its children,
    // because each folder tracks its own expanded state by path.
    expect(screen.getByText("components")).toBeTruthy();
    expect(screen.queryByText("Button.tsx")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /components/i }));

    expect(screen.getByText("Button.tsx")).toBeTruthy();
    expect(useFilesPanelStore.getState().expandedFolders).toEqual([
      "src",
      "src/components",
    ]);
  });
});
