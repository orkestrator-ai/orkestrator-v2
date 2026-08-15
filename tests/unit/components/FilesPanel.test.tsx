import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  TerminalProvider,
  useTerminalContext,
  type CreateFileTabOptions,
} from "../../../apps/web/src/contexts/TerminalContext";
import { useFilesPanelStore } from "../../../apps/web/src/stores/filesPanelStore";
import type { FileNode, GitFileChange } from "../../../apps/web/src/lib/backend";
import { invoke } from "../../../apps/web/src/lib/native/backend";
import { mockToastError } from "../../mocks/sonner";
import * as realHooks from "@/hooks";
import * as realContextMenu from "@/components/ui/context-menu";
import * as realAlertDialog from "@/components/ui/alert-dialog";
import { createContext, useContext, useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";

const realHooksSnapshot = { ...realHooks };
const realContextMenuSnapshot = { ...realContextMenu };
const realAlertDialogSnapshot = { ...realAlertDialog };
const refreshMock = mock(() => {});
const revertFileMock = mock(async () => {});
const deleteFileMock = mock(async () => {});
let mockEnvironmentId: string | null = "env-container";
let mockFileActionPending: string | null = null;
let mockIsMobile = false;
let mockIsLocalEnvironment = false;
let mockWorktreePath: string | null = null;
const invokeMock = invoke as ReturnType<typeof mock>;

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useFilesPanel: () => ({
    refresh: refreshMock,
    loadChanges: mock(() => {}),
    loadFileTree: mock(() => {}),
    isAvailable: true,
    environmentId: mockEnvironmentId,
    containerId: "container-1",
    worktreePath: mockWorktreePath,
    isLocalEnvironment: mockIsLocalEnvironment,
    revertFile: revertFileMock,
    deleteFile: deleteFileMock,
    fileActionPending: mockFileActionPending,
  }),
  useMediaQuery: () => mockIsMobile,
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

const AlertDialogOpenChangeContext = createContext<((open: boolean) => void) | null>(null);
mock.module("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => open
    ? <AlertDialogOpenChangeContext.Provider value={onOpenChange ?? null}>{children}</AlertDialogOpenChangeContext.Provider>
    : null,
  AlertDialogAction: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  AlertDialogCancel: ({ children, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
    const onOpenChange = useContext(AlertDialogOpenChangeContext);
    return (
      <button
        type="button"
        {...props}
        onClick={(event) => {
          onClick?.(event);
          onOpenChange?.(false);
        }}
      >
        {children}
      </button>
    );
  },
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const { ChangedFileItem } = await import("../../../apps/web/src/components/files-panel/ChangedFileItem");
const { FileTreeNode } = await import("../../../apps/web/src/components/files-panel/FileTreeNode");
const { FilesPanelHeader } = await import("../../../apps/web/src/components/files-panel/FilesPanelHeader");
const { FilesPanel } = await import("../../../apps/web/src/components/files-panel/FilesPanel");
const { AllFilesView } = await import("../../../apps/web/src/components/files-panel/AllFilesView");
const { ChangesView } = await import("../../../apps/web/src/components/files-panel/ChangesView");
const { FileActionDialog } = await import("../../../apps/web/src/components/files-panel/FileActionDialog");
const filesPanelExports = await import("../../../apps/web/src/components/files-panel");

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

function FileViewHarness({
  children,
  createFileTab,
}: {
  children: ReactNode;
  createFileTab: (filePath: string, options?: CreateFileTabOptions) => void;
}) {
  const { setCreateFileTab } = useTerminalContext();
  useEffect(() => {
    setCreateFileTab(createFileTab);
    return () => setCreateFileTab(null);
  }, [createFileTab, setCreateFileTab]);
  return children;
}

describe("Files panel components", () => {
  afterEach(() => {
    cleanup();
    refreshMock.mockClear();
    revertFileMock.mockClear();
    deleteFileMock.mockClear();
    revertFileMock.mockImplementation(async () => {});
    deleteFileMock.mockImplementation(async () => {});
    mockEnvironmentId = "env-container";
    mockFileActionPending = null;
    mockIsMobile = false;
    mockIsLocalEnvironment = false;
    mockWorktreePath = null;
    invokeMock.mockClear();
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
    mock.module("@/components/ui/alert-dialog", () => realAlertDialogSnapshot);
  });

  test("ChangedFileItem renders directory, filename, stats, and click target", () => {
    const onClick = mock(() => {});
    render(<ChangedFileItem change={change} onClick={onClick} />);

    const directory = screen.getByText("src/components");
    const filename = screen.getByText("/Button.tsx");
    expect(directory.className).toContain("[direction:rtl]");
    expect(directory.className).toContain("shrink");
    expect(filename.className).toContain("shrink-0");
    expect(filename.className).toContain("max-w-full");
    expect(filename.className).toContain("truncate");
    expect(filename.parentElement?.className).toContain("items-baseline");
    expect(filename.parentElement?.className).toContain("text-xs");
    expect(directory.className).not.toContain("text-xs");
    expect(filename.className).not.toContain("text-sm");
    expect(screen.getByText("+12").className).toContain("text-green-500");
    expect(screen.getByText("-3").className).toContain("text-red-400");

    const fileButton = screen.getByTitle("src/components/Button.tsx");
    fireEvent.click(fileButton);
    expect(onClick).toHaveBeenCalledWith("src/components/Button.tsx");
  });

  test("ChangedFileItem exposes revert and delete context actions", () => {
    const onReveal = mock(() => {});
    const onRevert = mock(() => {});
    const onDelete = mock(() => {});
    render(
      <ChangedFileItem
        change={change}
        onReveal={onReveal}
        onRevert={onRevert}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reveal in file manager" }));
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));

    expect(onReveal).toHaveBeenCalledWith("src/components/Button.tsx");
    expect(onRevert).toHaveBeenCalledWith("src/components/Button.tsx");
    expect(onDelete).toHaveBeenCalledWith("src/components/Button.tsx");
  });

  test("ChangedFileItem hides reveal for deleted files", () => {
    render(
      <ChangedFileItem
        change={{ ...change, status: "D" }}
        onReveal={mock(() => {})}
      />,
    );

    expect(screen.queryByRole("button", { name: "Reveal in file manager" }) === null).toBe(true);
  });

  test("ChangedFileItem renders a root-level file without a directory segment", () => {
    const rootChange: GitFileChange = {
      ...change,
      path: "README.md",
      filename: "README.md",
      directory: "",
    };
    render(<ChangedFileItem change={rootChange} />);

    const filename = screen.getByText("README.md");
    expect(filename.parentElement?.childElementCount).toBe(1);
    expect(screen.queryByText("/") === null).toBe(true);
    expect(screen.getByTitle("README.md")).toBeTruthy();
  });

  test("ChangedFileItem suppresses zero and negative change counts", () => {
    const { rerender } = render(
      <ChangedFileItem change={{ ...change, additions: 0, deletions: 0 }} />,
    );

    expect(screen.queryByText("+0") === null).toBe(true);
    expect(screen.queryByText("-0") === null).toBe(true);

    rerender(<ChangedFileItem change={{ ...change, additions: -2, deletions: -3 }} />);

    expect(screen.queryByText("+-2") === null).toBe(true);
    expect(screen.queryByText("--3") === null).toBe(true);
  });

  test("ChangedFileItem exposes only the supplied context action", () => {
    const onRevert = mock(() => {});
    const onDelete = mock(() => {});
    const { rerender } = render(<ChangedFileItem change={change} onRevert={onRevert} />);

    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(onRevert).toHaveBeenCalledWith(change.path);
    expect(screen.queryByRole("button", { name: "Delete file" }) === null).toBe(true);

    rerender(<ChangedFileItem change={change} onDelete={onDelete} />);

    expect(screen.queryByRole("button", { name: "Revert" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    expect(onDelete).toHaveBeenCalledWith(change.path);
  });

  test("ChangedFileItem remains clickable when onClick is omitted", () => {
    render(<ChangedFileItem change={change} />);

    expect(() => fireEvent.click(screen.getByTitle(change.path))).not.toThrow();
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
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    expect(onRevert).toHaveBeenCalledWith(file.path);
    expect(onDelete).toHaveBeenCalledWith(file.path);

    rerender(
      <FileTreeNode
        item={file}
        depth={0}
        changedPaths={new Set()}
        onRevert={onRevert}
        onDelete={onDelete}
      />,
    );

    expect(screen.queryByRole("button", { name: "Revert" }) === null).toBe(true);
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

  test("FilesPanelHeader switches tabs, refreshes, and closes the panel", () => {
    useFilesPanelStore.setState({
      isOpen: true,
      activeTab: "changes",
      isLoadingChanges: false,
      isLoadingTree: false,
    });
    render(<FilesPanelHeader onRefresh={refreshMock} />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "All files" }), { button: 0, ctrlKey: false });
    expect(useFilesPanelStore.getState().activeTab).toBe("all-files");

    const actionButtons = screen.getAllByRole("button").filter((button) => button.getAttribute("role") !== "tab");
    fireEvent.click(actionButtons[0]!);
    fireEvent.click(actionButtons[1]!);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(useFilesPanelStore.getState().isOpen).toBe(false);
  });

  test("view components render loading and empty states", () => {
    useFilesPanelStore.setState({ isLoadingTree: true, fileTree: [] });
    const { rerender } = render(
      <TerminalProvider>
        <AllFilesView />
      </TerminalProvider>,
    );
    expect(screen.getByText("Loading files...")).toBeTruthy();

    act(() => useFilesPanelStore.setState({ isLoadingTree: false, fileTree: [] }));
    rerender(<TerminalProvider><AllFilesView /></TerminalProvider>);
    expect(screen.getByText("No files found")).toBeTruthy();

    act(() => useFilesPanelStore.setState({ isLoadingChanges: true, changes: [] }));
    rerender(<TerminalProvider><ChangesView /></TerminalProvider>);
    expect(screen.getByText("Loading changes...")).toBeTruthy();

    act(() => useFilesPanelStore.setState({ isLoadingChanges: false, changes: [] }));
    rerender(<TerminalProvider><ChangesView /></TerminalProvider>);
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  test("file views open regular and diff tabs and close on mobile", async () => {
    const createFileTab = mock((_filePath: string, _options?: CreateFileTabOptions) => {});
    mockIsMobile = true;
    useFilesPanelStore.setState({
      isOpen: true,
      activeTab: "all-files",
      expandedFolders: ["src"],
      fileTree,
      changes: [change],
    });
    const { rerender } = render(
      <TerminalProvider>
        <FileViewHarness createFileTab={createFileTab}>
          <AllFilesView />
        </FileViewHarness>
      </TerminalProvider>,
    );

    await waitFor(() => expect(screen.getByText("App.tsx")).toBeTruthy());
    fireEvent.click(screen.getByText("App.tsx"));
    expect(createFileTab).toHaveBeenCalledWith("src/App.tsx");
    expect(useFilesPanelStore.getState().isOpen).toBe(false);

    act(() => useFilesPanelStore.setState({ isOpen: true, activeTab: "changes" }));
    rerender(
      <TerminalProvider>
        <FileViewHarness createFileTab={createFileTab}>
          <ChangesView />
        </FileViewHarness>
      </TerminalProvider>,
    );
    fireEvent.click(screen.getByTitle(change.path));
    expect(createFileTab).toHaveBeenCalledWith(change.path, { isDiff: true, gitStatus: "M" });
    expect(useFilesPanelStore.getState().isOpen).toBe(false);
  });

  test("FileActionDialog describes and dispatches revert and delete actions", () => {
    const onCancel = mock(() => {});
    const onConfirm = mock(async () => {});
    const { rerender } = render(
      <FileActionDialog
        action={{ environmentId: "env-1", kind: "revert", path: "src/App.tsx" }}
        targetRef="main"
        isPending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole("heading", { name: "Revert file?" })).toBeTruthy();
    expect(screen.getByText("src/App.tsx")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <FileActionDialog
        action={null}
        targetRef="main"
        isPending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    rerender(
      <FileActionDialog
        action={{ environmentId: "env-1", kind: "revert", path: "src/App.tsx" }}
        targetRef="main"
        isPending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      <FileActionDialog
        action={{ environmentId: "env-1", kind: "delete", path: "src/App.tsx" }}
        targetRef="main"
        isPending={true}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole("heading", { name: "Delete file?" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Working..." }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
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
    expect(screen.getByText("src/components")).toBeTruthy();
    expect(screen.getByText("/Button.tsx")).toBeTruthy();
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
    expect(screen.queryByText("App.tsx") === null).toBe(true);

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

    expect(screen.queryByText("App.tsx") === null).toBe(true);
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
    expect(screen.queryByText("Button.tsx") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /components/i }));

    expect(screen.getByText("Button.tsx")).toBeTruthy();
    expect(useFilesPanelStore.getState().expandedFolders).toEqual([
      "src",
      "src/components",
    ]);
  });

  test("FilesPanel confirms actions and keeps failed actions open for retry", async () => {
    useFilesPanelStore.setState({ activeTab: "changes", changes: [change] });
    const { rerender } = render(
      <TerminalProvider>
        <FilesPanel />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(screen.getByRole("heading", { name: "Revert file?" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Revert" }).at(-1)!);
    await waitFor(() => {
      expect(revertFileMock).toHaveBeenCalledWith(change.path);
      expect(screen.queryByRole("heading", { name: "Revert file?" }) === null).toBe(true);
    });

    deleteFileMock.mockImplementation(async () => {
      throw new Error("delete failed");
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete file" }).at(-1)!);
    await waitFor(() => expect(deleteFileMock).toHaveBeenCalledWith(change.path));
    expect(screen.getByRole("heading", { name: "Delete file?" })).toBeTruthy();

    mockEnvironmentId = "env-other";
    rerender(<TerminalProvider><FilesPanel /></TerminalProvider>);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Delete file?" }) === null).toBe(true));
  });

  test("FilesPanel does not queue destructive actions without an environment", () => {
    mockEnvironmentId = null;
    useFilesPanelStore.setState({ activeTab: "changes", changes: [change] });
    render(<TerminalProvider><FilesPanel /></TerminalProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    expect(screen.queryByRole("heading", { name: "Delete file?" }) === null).toBe(true);
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  test("reveals local files by absolute worktree path and hides the action for containers", async () => {
    mockEnvironmentId = "env-local";
    mockIsLocalEnvironment = true;
    mockWorktreePath = "/worktrees/feature/";
    useFilesPanelStore.setState({ activeTab: "changes", changes: [change] });
    const { rerender } = render(<TerminalProvider><FilesPanel /></TerminalProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Reveal in file manager" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("reveal_in_file_manager", {
      path: "/worktrees/feature/src/components/Button.tsx",
    }));

    mockIsLocalEnvironment = false;
    mockWorktreePath = null;
    rerender(<TerminalProvider><FilesPanel /></TerminalProvider>);
    expect(screen.queryByRole("button", { name: "Reveal in file manager" }) === null).toBe(true);
  });

  test("reports file-manager reveal failures", async () => {
    mockEnvironmentId = "env-local";
    mockIsLocalEnvironment = true;
    mockWorktreePath = "/worktrees/feature";
    invokeMock.mockRejectedValueOnce(new Error("file manager unavailable"));
    useFilesPanelStore.setState({ activeTab: "changes", changes: [change] });
    render(<TerminalProvider><FilesPanel /></TerminalProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Reveal in file manager" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to reveal file",
      { description: "file manager unavailable" },
    ));
  });

  test("the files-panel barrel exports every public component", () => {
    expect(filesPanelExports.FilesPanel).toBe(FilesPanel);
    expect(filesPanelExports.FilesPanelHeader).toBe(FilesPanelHeader);
    expect(filesPanelExports.ChangedFileItem).toBe(ChangedFileItem);
    expect(filesPanelExports.FileTreeNode).toBe(FileTreeNode);
    expect(filesPanelExports.AllFilesView).toBe(AllFilesView);
    expect(filesPanelExports.ChangesView).toBe(ChangesView);
    expect(filesPanelExports.FileActionDialog).toBe(FileActionDialog);
  });
});
