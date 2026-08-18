import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useFileDirtyStore } from "@/stores/fileDirtyStore";
import * as realBackend from "@/lib/backend";
import * as realMarkdownEditorTab from "@/components/markdown/MarkdownEditorTab";
import * as realDiffViewerTab from "./DiffViewerTab";
import * as realMonacoFileEditor from "./MonacoFileEditor";
import { mockToastError } from "../../../../../tests/mocks/sonner";

const realBackendSnapshot = { ...realBackend };
const realMarkdownEditorTabSnapshot = { ...realMarkdownEditorTab };
const realDiffViewerTabSnapshot = { ...realDiffViewerTab };
const realMonacoFileEditorSnapshot = { ...realMonacoFileEditor };

const readLocalFileMock = mock(async (_worktreePath: string, _filePath: string) => ({
  content: "# Loaded Markdown",
  language: "markdown",
}));
const readContainerFileMock = mock(async (_containerId: string, _filePath: string) => ({
  content: "container text",
  language: "plaintext",
}));
const readFileBase64Mock = mock(async (_filePath: string) => "aW1hZ2U=");
const readContainerFileBase64Mock = mock(
  async (_containerId: string, _filePath: string) => "Y29udGFpbmVyLWltYWdl",
);
const getFileDraftMock = mock(
  async (_draftKey: string): Promise<Awaited<ReturnType<typeof realBackend.getFileDraft>>> => null,
);
const saveFileDraftMock = mock(async () => undefined);
const deleteFileDraftMock = mock(async () => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  readLocalFile: readLocalFileMock,
  readContainerFile: readContainerFileMock,
  readFileBase64: readFileBase64Mock,
  readContainerFileBase64: readContainerFileBase64Mock,
  getFileDraft: getFileDraftMock,
  saveFileDraft: saveFileDraftMock,
  deleteFileDraft: deleteFileDraftMock,
}));

mock.module("@/components/markdown/MarkdownEditorTab", () => ({
  MarkdownEditorTab: ({
    filePath,
    initialContent,
    language,
  }: {
    filePath: string;
    initialContent: string;
    language: string;
  }) => (
    <div data-testid="markdown-file-editor">
      <span>{filePath}</span>
      <span>{language}</span>
      <pre>{initialContent}</pre>
    </div>
  ),
}));

mock.module("./MonacoFileEditor", () => ({
  MonacoFileEditor: ({
    language,
    value,
    onChange,
    onSave,
  }: {
    language: string;
    value: string;
    onChange: (value: string) => void;
    onSave: () => void;
  }) => (
    <textarea
      aria-label={`Monaco ${language}`}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.ctrlKey && event.key.toLowerCase() === "s") onSave();
      }}
    />
  ),
}));

mock.module("./DiffViewerTab", () => ({
  DiffViewerTab: ({
    filePath,
    onSwitchToFileView,
  }: {
    filePath: string;
    onSwitchToFileView?: () => void;
  }) => (
    <div data-testid="diff-viewer">
      <span>{filePath}</span>
      <button type="button" onClick={onSwitchToFileView}>
        View file
      </button>
    </div>
  ),
}));

const { FileViewerTab, getFileViewerKind, isMarkdownFile } = await import("./FileViewerTab");

beforeEach(() => {
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  readLocalFileMock.mockClear();
  readContainerFileMock.mockClear();
  readFileBase64Mock.mockClear();
  readContainerFileBase64Mock.mockClear();
  getFileDraftMock.mockReset();
  saveFileDraftMock.mockReset();
  deleteFileDraftMock.mockReset();
  readLocalFileMock.mockImplementation(async () => ({
    content: "# Loaded Markdown",
    language: "markdown",
  }));
  readContainerFileMock.mockImplementation(async () => ({
    content: "container text",
    language: "plaintext",
  }));
  readFileBase64Mock.mockImplementation(async () => "aW1hZ2U=");
  getFileDraftMock.mockImplementation(async () => null);
  saveFileDraftMock.mockImplementation(async () => undefined);
  deleteFileDraftMock.mockImplementation(async () => undefined);
});

afterEach(() => {
  cleanup();
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/components/markdown/MarkdownEditorTab", () => realMarkdownEditorTabSnapshot);
  mock.module("./DiffViewerTab", () => realDiffViewerTabSnapshot);
  mock.module("./MonacoFileEditor", () => realMonacoFileEditorSnapshot);
});

describe("FileViewerTab routing", () => {
  test("routes Markdown extensions to the rich editor", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("docs/guide.MARKDOWN")).toBe(true);
    expect(
      getFileViewerKind("README.md", {
        showDiff: false,
        hasDiffData: false,
      }),
    ).toBe("markdown");
  });

  test("keeps non-Markdown text files in Monaco", () => {
    expect(isMarkdownFile("src/index.ts")).toBe(false);
    expect(isMarkdownFile("component.mdx")).toBe(false);
    expect(
      getFileViewerKind("src/index.ts", {
        showDiff: false,
        hasDiffData: false,
      }),
    ).toBe("text");
  });

  test("prioritizes valid diffs except for images", () => {
    expect(
      getFileViewerKind("README.md", {
        showDiff: true,
        hasDiffData: true,
      }),
    ).toBe("diff");
    expect(
      getFileViewerKind("diagram.png", {
        showDiff: true,
        hasDiffData: true,
      }),
    ).toBe("image");
    expect(
      getFileViewerKind("README.md", {
        showDiff: true,
        hasDiffData: false,
      }),
    ).toBe("markdown");
  });
});

describe("FileViewerTab component", () => {
  test("loads a local Markdown file into the rich editor and dirty store", async () => {
    render(
      <FileViewerTab
        tabId="markdown-tab"
        filePath="README.md"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
      />,
    );

    expect(screen.getByText("Loading file...")).toBeTruthy();
    expect(await screen.findByTestId("markdown-file-editor")).toBeTruthy();
    expect(screen.getByText("# Loaded Markdown")).toBeTruthy();
    expect(readLocalFileMock).toHaveBeenCalledWith("/repo", "README.md");
    expect(useFileDirtyStore.getState().getContent("markdown-tab")).toBe("# Loaded Markdown");
  });

  test("loads container text into Monaco and tracks changes", async () => {
    render(
      <FileViewerTab tabId="text-tab" filePath="notes.txt" containerId="container-1" isActive />,
    );

    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    expect((editor as HTMLTextAreaElement).value).toBe("container text");
    fireEvent.change(editor, { target: { value: "updated text" } });
    expect(useFileDirtyStore.getState().getContent("text-tab")).toBe("updated text");
  });

  test("shows backend read errors", async () => {
    readLocalFileMock.mockRejectedValueOnce(new Error("read unavailable"));
    render(
      <FileViewerTab
        tabId="error-tab"
        filePath="README.md"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
      />,
    );

    expect(await screen.findByText("Failed to load file")).toBeTruthy();
    expect(screen.getByText("read unavailable")).toBeTruthy();
  });

  test("loads local images as data URLs", async () => {
    render(
      <FileViewerTab
        tabId="image-tab"
        filePath="assets/logo.png"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
      />,
    );

    const image = await screen.findByRole("img", { name: "assets/logo.png" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(readFileBase64Mock).toHaveBeenCalledWith("/repo/assets/logo.png");
  });

  test("loads container images through the container backend", async () => {
    render(
      <FileViewerTab
        tabId="container-image-tab"
        filePath="assets/logo.webp"
        containerId="container-1"
        isActive
      />,
    );

    const image = await screen.findByRole("img", { name: "assets/logo.webp" });
    expect(image.getAttribute("src")).toBe("data:image/webp;base64,Y29udGFpbmVyLWltYWdl");
    expect(readContainerFileBase64Mock).toHaveBeenCalledWith("container-1", "assets/logo.webp");
  });

  test("reports an image load error when no environment path is available", async () => {
    render(
      <FileViewerTab tabId="missing-image-environment-tab" filePath="assets/logo.png" isActive />,
    );

    expect(await screen.findByText("Failed to load file")).toBeTruthy();
    expect(
      screen.getByText("No container ID or worktree path available for image viewing"),
    ).toBeTruthy();
  });

  test("switches from a Markdown diff to the loaded rich editor", async () => {
    render(
      <FileViewerTab
        tabId="diff-tab"
        filePath="README.md"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
        isDiff
        gitStatus="M"
        baseBranch="main"
      />,
    );

    expect(await screen.findByTestId("diff-viewer")).toBeTruthy();
    expect(readLocalFileMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View file" }));
    expect(await screen.findByTestId("markdown-file-editor")).toBeTruthy();
    expect(readLocalFileMock).toHaveBeenCalledWith("/repo", "README.md");
  });

  test("keeps per-tab dirty state when the file tab temporarily unmounts", async () => {
    const view = render(
      <FileViewerTab
        tabId="closing-tab"
        filePath="README.md"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
      />,
    );
    await screen.findByTestId("markdown-file-editor");
    act(() => {
      useFileDirtyStore.getState().setContent("closing-tab", "unsaved");
    });

    view.unmount();

    expect(useFileDirtyStore.getState().getContent("closing-tab")).toBe("unsaved");
  });

  test("prefers a newer in-memory buffer over an older backend draft on remount", async () => {
    useFileDirtyStore.getState().hydrateDraft("remount-tab", "newer unsaved buffer", "older disk");
    getFileDraftMock.mockResolvedValueOnce({
      draftKey: "file:env-1:notes.txt",
      environmentId: "env-1",
      filePath: "notes.txt",
      content: "stale backend buffer",
      originalContent: "older disk",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    });

    render(
      <FileViewerTab
        tabId="remount-tab"
        environmentId="env-1"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    expect((editor as HTMLTextAreaElement).value).toBe("newer unsaved buffer");
    expect(getFileDraftMock).not.toHaveBeenCalled();
    expect(useFileDirtyStore.getState().dirtyFiles.get("remount-tab")).toEqual({
      content: "newer unsaved buffer",
      originalContent: "container text",
    });
  });

  test("hydrates a valid backend draft with the owning environment", async () => {
    getFileDraftMock.mockResolvedValueOnce({
      draftKey: "file:env-restore:notes.txt",
      environmentId: "env-restore",
      filePath: "notes.txt",
      content: "restored buffer",
      originalContent: "old disk",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    });

    render(
      <FileViewerTab
        tabId="restore-tab"
        environmentId="env-restore"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    expect((editor as HTMLTextAreaElement).value).toBe("restored buffer");
    expect(getFileDraftMock).toHaveBeenCalledWith("file:env-restore:notes.txt");
    expect(useFileDirtyStore.getState().dirtyFiles.get("restore-tab")).toEqual({
      content: "restored buffer",
      originalContent: "container text",
    });
  });

  test("persists edits through the environment-scoped file draft path", async () => {
    render(
      <FileViewerTab
        tabId="persist-tab"
        environmentId="env-persist"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    fireEvent.change(editor, { target: { value: "unsaved text" } });

    await waitFor(
      () =>
        expect(saveFileDraftMock).toHaveBeenCalledWith(
          "file:env-persist:notes.txt",
          "env-persist",
          "notes.txt",
          "unsaved text",
          "container text",
          0,
        ),
      { timeout: 1_500 },
    );
  });

  test("flushes an edit when the tab unmounts before the debounce expires", async () => {
    const view = render(
      <FileViewerTab
        tabId="unmount-flush-tab"
        environmentId="env-unmount"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    fireEvent.change(editor, { target: { value: "latest unsaved text" } });

    view.unmount();

    await waitFor(() =>
      expect(saveFileDraftMock).toHaveBeenCalledWith(
        "file:env-unmount:notes.txt",
        "env-unmount",
        "notes.txt",
        "latest unsaved text",
        "container text",
        0,
      ),
    );
  });

  test("flushes the current edit on pagehide", async () => {
    render(
      <FileViewerTab
        tabId="pagehide-flush-tab"
        environmentId="env-pagehide"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    fireEvent.change(editor, { target: { value: "leaving page" } });

    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() =>
      expect(saveFileDraftMock).toHaveBeenCalledWith(
        "file:env-pagehide:notes.txt",
        "env-pagehide",
        "notes.txt",
        "leaving page",
        "container text",
        0,
      ),
    );
  });

  test("flushes draft deletion after a successful save and immediate unmount", async () => {
    const view = render(
      <FileViewerTab
        tabId="save-unmount-tab"
        environmentId="env-save"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    fireEvent.change(editor, { target: { value: "saved text" } });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(useFileDirtyStore.getState().isDirty("save-unmount-tab")).toBe(false),
    );

    view.unmount();

    await waitFor(() =>
      expect(deleteFileDraftMock).toHaveBeenCalledWith("file:env-save:notes.txt", 0),
    );
  });

  test("continues with the disk buffer when backend draft restore fails", async () => {
    getFileDraftMock.mockRejectedValueOnce(new Error("draft store unavailable"));

    render(
      <FileViewerTab
        tabId="draft-error-tab"
        environmentId="env-error"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    expect((editor as HTMLTextAreaElement).value).toBe("container text");
    expect(useFileDirtyStore.getState().isDirty("draft-error-tab")).toBe(false);
  });

  test("offers to save the local buffer after a draft revision conflict", async () => {
    getFileDraftMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      draftKey: "file:env-conflict:notes.txt",
      environmentId: "env-conflict",
      filePath: "notes.txt",
      content: "other window",
      originalContent: "container text",
      updatedAt: "2026-07-29T00:00:00.000Z",
      revision: 4,
    });
    saveFileDraftMock
      .mockRejectedValueOnce(new Error("revision conflict"))
      .mockResolvedValueOnce(undefined);
    render(
      <FileViewerTab
        tabId="save-conflict-tab"
        environmentId="env-conflict"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    fireEvent.change(editor, { target: { value: "my unsaved text" } });

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    const toastOptions = mockToastError.mock.calls.at(-1)?.[1] as {
      action?: { label: string; onClick: () => void };
    };
    expect(toastOptions.action?.label).toBe("Save mine");
    toastOptions.action?.onClick();

    await waitFor(() =>
      expect(saveFileDraftMock).toHaveBeenLastCalledWith(
        "file:env-conflict:notes.txt",
        "env-conflict",
        "notes.txt",
        "my unsaved text",
        "container text",
        4,
      ),
    );
    expect(useFileDirtyStore.getState().getContent("save-conflict-tab")).toBe("my unsaved text");
  });

  test("offers to finish discarding after a draft deletion conflict", async () => {
    getFileDraftMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      draftKey: "file:env-discard:notes.txt",
      environmentId: "env-discard",
      filePath: "notes.txt",
      content: "other window",
      originalContent: "container text",
      updatedAt: "2026-07-29T00:00:00.000Z",
      revision: 7,
    });
    deleteFileDraftMock
      .mockRejectedValueOnce(new Error("revision conflict"))
      .mockResolvedValueOnce(undefined);
    render(
      <FileViewerTab
        tabId="discard-conflict-tab"
        environmentId="env-discard"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );
    await screen.findByRole("textbox", { name: "Monaco plaintext" });

    await waitFor(() => expect(mockToastError).toHaveBeenCalled(), {
      timeout: 1_500,
    });
    const toastOptions = mockToastError.mock.calls.at(-1)?.[1] as {
      action?: { label: string; onClick: () => void };
    };
    expect(toastOptions.action?.label).toBe("Discard saved draft");
    toastOptions.action?.onClick();

    await waitFor(() =>
      expect(deleteFileDraftMock).toHaveBeenLastCalledWith("file:env-discard:notes.txt", 7),
    );
  });

  test("ignores an older file read after its props change", async () => {
    let resolveOldRead!: (content: realBackend.FileContent) => void;
    readContainerFileMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldRead = resolve;
        }),
    );
    const view = render(
      <FileViewerTab
        tabId="stale-read-tab"
        filePath="old.txt"
        containerId="container-1"
        isActive
      />,
    );
    await waitFor(() =>
      expect(readContainerFileMock).toHaveBeenCalledWith("container-1", "old.txt"),
    );

    view.rerender(
      <FileViewerTab
        tabId="stale-read-tab"
        filePath="new.txt"
        containerId="container-1"
        isActive
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    expect((editor as HTMLTextAreaElement).value).toBe("container text");

    await act(async () => {
      resolveOldRead({
        path: "old.txt",
        content: "stale content",
        language: "plaintext",
      });
      await Promise.resolve();
    });
    expect((editor as HTMLTextAreaElement).value).toBe("container text");
    expect(useFileDirtyStore.getState().getContent("stale-read-tab")).toBe("container text");
  });

  test("ignores an older file-read rejection after its props change", async () => {
    let rejectOldRead!: (error: Error) => void;
    const oldRead = new Promise<realBackend.FileContent>((_resolve, reject) => {
      rejectOldRead = reject;
    });
    readContainerFileMock.mockImplementationOnce(() => oldRead);
    const view = render(
      <FileViewerTab
        tabId="stale-read-error-tab"
        filePath="old.txt"
        containerId="container-1"
        isActive
      />,
    );
    await waitFor(() =>
      expect(readContainerFileMock).toHaveBeenCalledWith("container-1", "old.txt"),
    );

    view.rerender(
      <FileViewerTab
        tabId="stale-read-error-tab"
        filePath="new.txt"
        containerId="container-1"
        isActive
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });

    await act(async () => {
      rejectOldRead(new Error("stale read failure"));
      try {
        await oldRead;
      } catch {
        // FileViewerTab must consume this rejection without replacing newer state.
      }
    });
    expect(screen.queryByText("stale read failure") === null).toBe(true);
    expect(screen.queryByText("Failed to load file") === null).toBe(true);
    expect((editor as HTMLTextAreaElement).value).toBe("container text");
  });

  test("does not hydrate a draft that resolves after the file changes", async () => {
    let resolveOldDraft!: (draft: Awaited<ReturnType<typeof realBackend.getFileDraft>>) => void;
    getFileDraftMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldDraft = resolve;
        }),
    );
    const view = render(
      <FileViewerTab
        tabId="stale-draft-tab"
        environmentId="env-stale"
        filePath="old.txt"
        containerId="container-1"
        isActive
      />,
    );
    await waitFor(() => expect(getFileDraftMock).toHaveBeenCalledWith("file:env-stale:old.txt"));

    view.rerender(
      <FileViewerTab
        tabId="stale-draft-tab"
        environmentId="env-stale"
        filePath="new.txt"
        containerId="container-1"
        isActive
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    expect((editor as HTMLTextAreaElement).value).toBe("container text");

    await act(async () => {
      resolveOldDraft({
        draftKey: "file:env-stale:old.txt",
        environmentId: "env-stale",
        filePath: "old.txt",
        content: "stale draft",
        originalContent: "old disk",
        updatedAt: "2026-07-29T00:00:00.000Z",
        revision: 3,
      });
      await Promise.resolve();
    });
    expect((editor as HTMLTextAreaElement).value).toBe("container text");
    expect(useFileDirtyStore.getState().getContent("stale-draft-tab")).toBe("container text");
  });

  test("ignores a file read that finishes after unmount", async () => {
    let resolveRead!: (content: realBackend.FileContent) => void;
    readContainerFileMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const view = render(
      <FileViewerTab
        tabId="unmounted-read-tab"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );
    await waitFor(() => expect(readContainerFileMock).toHaveBeenCalled());

    view.unmount();
    resolveRead({
      path: "notes.txt",
      content: "late content",
      language: "plaintext",
    });
    await Promise.resolve();

    expect(useFileDirtyStore.getState().getContent("unmounted-read-tab")).toBeNull();
  });
});
