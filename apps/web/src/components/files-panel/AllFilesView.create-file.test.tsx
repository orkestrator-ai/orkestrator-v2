import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MAX_WORKSPACE_FILE_NAME_BYTES } from "@orkestrator/protocol/contract/domains/files";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { TerminalProvider, useTerminalContext } from "@/contexts";
import { filesPanelStore } from "@/stores";
import type { FileNode, GitFileChange } from "@/lib/backend";
import { appCommandStore } from "@/test/app-command-store";
import { setFilesPanelTestState } from "@/test/files-panel-state";
import { AllFilesView } from "./AllFilesView";
import { ChangedFileItem } from "./ChangedFileItem";
import { CreateFileDialog } from "./CreateFileDialog";
import { CreateFolderDialog } from "./CreateFolderDialog";

const createFileTab = mock((_path: string) => undefined);

function RegisterFileTab() {
  const { setCreateFileTab } = useTerminalContext();
  useEffect(() => {
    setCreateFileTab(createFileTab);
    return () => setCreateFileTab(null);
  }, [setCreateFileTab]);
  return null;
}

function renderWithTerminal(children: React.ReactNode) {
  return renderInAppCommandScope(
    <TerminalProvider>
      <RegisterFileTab />
      {children}
    </TerminalProvider>,
  );
}

const fileTree: FileNode[] = [
  {
    name: "src",
    path: "src",
    isDirectory: true,
    children: [{ name: "App.tsx", path: "src/App.tsx", isDirectory: false }],
  },
  { name: "archive", path: "archive", isDirectory: true, children: [] },
];

const joined = (parentDirectory: string, name: string) =>
  parentDirectory === "." ? name : `${parentDirectory}/${name}`;

describe("New file in the All files view", () => {
  beforeEach(() => {
    createFileTab.mockClear();
    setFilesPanelTestState({ fileTree: [], changes: [], expandedFolders: [] });
  });

  afterEach(() => {
    cleanup();
  });

  test("creates an empty file inside a right-clicked folder and opens it", async () => {
    const onCreateFile = mock(async (parentDirectory: string, fileName: string) =>
      joined(parentDirectory, fileName),
    );
    appCommandStore(filesPanelStore).setState({ fileTree, expandedFolders: [] });
    renderWithTerminal(<AllFilesView onCreateFile={onCreateFile} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "archive" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New file" }));
    expect(await screen.findByRole("dialog", { name: "New file" })).toBeTruthy();
    expect(screen.getByText(/Create an empty file in/).textContent).toContain("archive");

    const nameInput = screen.getByLabelText("File name") as HTMLInputElement;
    expect(nameInput.value).toBe("untitled.txt");
    fireEvent.change(nameInput, { target: { value: "notes.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Create file" }));

    await waitFor(() => expect(onCreateFile).toHaveBeenCalledWith("archive", "notes.md"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New file" }) === null).toBe(true),
    );
    // The folder opens so the new file is visible, and the file is opened for editing.
    expect(appCommandStore(filesPanelStore).getState().expandedFolders).toContain("archive");
    expect(createFileTab).toHaveBeenCalledWith("archive/notes.md");
  });

  test("creates the file in a right-clicked file's folder", async () => {
    const onCreateFile = mock(async (parentDirectory: string, fileName: string) =>
      joined(parentDirectory, fileName),
    );
    appCommandStore(filesPanelStore).setState({ fileTree, expandedFolders: ["src"] });
    renderWithTerminal(<AllFilesView onCreateFile={onCreateFile} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "App.tsx" }));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.click(await screen.findByRole("menuitem", { name: "New file" }));
    expect(screen.getByText(/Create an empty file in/).textContent).toContain("src");
    fireEvent.change(screen.getByLabelText("File name"), { target: { value: "  main.ts " } });
    fireEvent.click(screen.getByRole("button", { name: "Create file" }));
    await waitFor(() => expect(onCreateFile).toHaveBeenCalledWith("src", "main.ts"));
  });

  test("creates the file at the workspace root from empty space", async () => {
    const onCreateFile = mock(async (_parent: string, fileName: string) => fileName);
    appCommandStore(filesPanelStore).setState({ fileTree, expandedFolders: [] });
    const { unmount } = renderWithTerminal(<AllFilesView onCreateFile={onCreateFile} />);

    fireEvent.contextMenu(screen.getByLabelText("Workspace empty space"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New file" }));
    expect(screen.getByText(/workspace root/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create file" }));
    await waitFor(() => expect(onCreateFile).toHaveBeenCalledWith(".", "untitled.txt"));
    unmount();

    appCommandStore(filesPanelStore).setState({ fileTree: [], isLoadingTree: false });
    renderWithTerminal(<AllFilesView onCreateFile={onCreateFile} />);
    fireEvent.contextMenu(screen.getByText("No files found"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New file" }));
    fireEvent.change(screen.getByLabelText("File name"), { target: { value: "README.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Create file" }));
    await waitFor(() => expect(onCreateFile).toHaveBeenLastCalledWith(".", "README.md"));
  });

  test("lists New file beside New folder, and only when creation is available", async () => {
    appCommandStore(filesPanelStore).setState({ fileTree, expandedFolders: ["src"] });
    const { unmount } = renderWithTerminal(
      <AllFilesView
        onCreateFile={mock(async () => "x")}
        onCreateFolder={mock(async () => "x")}
        onRename={mock(async () => "x")}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "src" }));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items.slice(0, 2)).toEqual(["New file", "New folder"]);
    expect(items).toContain("Copy path");
    expect(items).toContain("Rename…");
    unmount();

    renderWithTerminal(<AllFilesView onCreateFolder={mock(async () => "x")} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "App.tsx" }));
    expect(await screen.findByText("New folder")).toBeTruthy();
    expect(screen.queryByText("New file") === null).toBe(true);
  });

  test("keeps New file disabled while a mutation is pending", async () => {
    appCommandStore(filesPanelStore).setState({ fileTree, expandedFolders: [] });
    renderWithTerminal(<AllFilesView onCreateFile={mock(async () => "x")} movePending />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "archive" }));
    const item = await screen.findByRole("menuitem", { name: "New file" });
    expect(item.hasAttribute("data-disabled")).toBe(true);
  });

  test("leaves the Changes view's menu without New file", async () => {
    const change: GitFileChange = {
      path: "src/App.tsx",
      filename: "App.tsx",
      directory: "src",
      status: "M",
      additions: 1,
      deletions: 0,
    };
    renderInAppCommandScope(
      <ChangedFileItem change={change} onRevert={() => undefined} onDelete={() => undefined} />,
    );

    fireEvent.contextMenu(screen.getByTitle("src/App.tsx"));
    expect(await screen.findByText("Copy path")).toBeTruthy();
    expect(screen.queryByText("New file") === null).toBe(true);
    expect(screen.queryByText("New folder") === null).toBe(true);
  });
});

describe("CreateFileDialog", () => {
  afterEach(() => {
    cleanup();
  });

  test("explains an invalid name without calling the backend", async () => {
    const onCreate = mock(async () => undefined);
    renderInAppCommandScope(
      <CreateFileDialog
        parentDirectory="src"
        isPending={false}
        onCancel={() => undefined}
        onCreate={onCreate}
      />,
    );
    const input = screen.getByLabelText("File name");
    const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create file" }));

    for (const [value, message] of [
      ["   ", "Enter a file name"],
      ["a/b.ts", "File names cannot contain / or \\"],
      ["a\\b.ts", "File names cannot contain / or \\"],
      ["..", "File names cannot be . or .."],
      [
        "x".repeat(MAX_WORKSPACE_FILE_NAME_BYTES + 1),
        `File names cannot exceed ${MAX_WORKSPACE_FILE_NAME_BYTES} bytes`,
      ],
    ] as const) {
      fireEvent.change(input, { target: { value } });
      submit();
      expect((await screen.findByRole("alert")).textContent).toBe(message);
    }
    expect(onCreate).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    // Editing the name clears the message.
    fireEvent.change(input, { target: { value: "ok.ts" } });
    expect(screen.queryByRole("alert") === null).toBe(true);
  });

  test("keeps the dialog open with the backend's error when the name exists", async () => {
    const onCreate = mock(async () => {
      throw new Error("A file or folder already exists at src/App.tsx");
    });
    renderInAppCommandScope(
      <CreateFileDialog
        parentDirectory="src"
        isPending={false}
        onCancel={() => undefined}
        onCreate={onCreate}
      />,
    );
    fireEvent.change(screen.getByLabelText("File name"), { target: { value: "App.tsx" } });
    fireEvent.click(screen.getByRole("button", { name: "Create file" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "A file or folder already exists at src/App.tsx",
    );
    expect(screen.getByRole("dialog", { name: "New file" })).toBeTruthy();
  });

  test("ignores dismissals while creation is pending", () => {
    const onCancel = mock(() => undefined);
    renderInAppCommandScope(
      <CreateFileDialog
        parentDirectory="src"
        isPending
        onCancel={onCancel}
        onCreate={mock(async () => undefined)}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Creating…" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "New file" }), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  test("New folder shares the same checks with its own wording", async () => {
    const onCreate = mock(async () => undefined);
    renderInAppCommandScope(
      <CreateFolderDialog
        parentDirectory="."
        isPending={false}
        onCancel={() => undefined}
        onCreate={onCreate}
      />,
    );
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a folder name");
    expect(onCreate).not.toHaveBeenCalled();
  });
});
