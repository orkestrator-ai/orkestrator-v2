import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useFileDirtyStore } from "@/stores/fileDirtyStore";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";
import { resetChangeSubscriptionsForTests } from "@/lib/changes/subscriptions";
import * as realBackend from "@/lib/backend";
import * as realMarkdownEditorTab from "@/components/markdown/MarkdownEditorTab";
import * as realDiffViewerTab from "./DiffViewerTab";
import * as realMonacoFileEditor from "./MonacoFileEditor";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import { FILE_WRITE_CONFLICT_MESSAGE } from "@orkestrator/protocol/file-write-precondition";

const realBackendSnapshot = { ...realBackend };
const realMarkdownEditorTabSnapshot = { ...realMarkdownEditorTab };
const realDiffViewerTabSnapshot = { ...realDiffViewerTab };
const realMonacoFileEditorSnapshot = { ...realMonacoFileEditor };

// Valid 1x1 RGBA PNGs (red and blue), also suitable for browser decode checks.
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const BLUE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==";

const readLocalFileMock = mock(async (_worktreePath: string, _filePath: string) => ({
  content: "# Loaded Markdown",
  language: "markdown",
}));
const readContainerFileMock = mock(async (_containerId: string, _filePath: string) => ({
  content: "container text",
  language: "plaintext",
}));
const readEnvironmentFileBase64Mock = mock(
  async (_environmentId: string, _filePath: string) => RED_PNG,
);
const readContainerFileBase64Mock = mock(
  async (_containerId: string, _filePath: string) => RED_PNG,
);
const getFileDraftMock = mock(
  async (_draftKey: string): Promise<Awaited<ReturnType<typeof realBackend.getFileDraft>>> => null,
);
const saveFileDraftMock = mock(async () => undefined);
const deleteFileDraftMock = mock(async () => undefined);
const writeContainerFileMock = mock(
  async (_containerId: string, _filePath: string, _data: string, _expected?: unknown) =>
    "/workspace/notes.txt",
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  writeContainerFile: writeContainerFileMock,
  readLocalFile: readLocalFileMock,
  readContainerFile: readContainerFileMock,
  readEnvironmentFileBase64: readEnvironmentFileBase64Mock,
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
    target,
    onSwitchToFileView,
  }: {
    filePath: string;
    target: ChangeDiffTarget;
    onSwitchToFileView?: () => void;
  }) => (
    <div data-testid="diff-viewer" data-target={JSON.stringify(target)}>
      <span>{filePath}</span>
      <button type="button" onClick={onSwitchToFileView}>
        View file
      </button>
    </div>
  ),
}));

const { FileViewerTab, getFileViewerKind, isMarkdownFile } = await import("./FileViewerTab");

const RESOURCE_KEY = "environment-net/environment/env-1/live";
const liveTarget: ChangeDiffTarget = {
  kind: "live",
  resourceKey: RESOURCE_KEY,
  path: "README.md",
  title: "README.md",
};

const liveImageTarget: ChangeDiffTarget = {
  kind: "live",
  resourceKey: liveTarget.resourceKey,
  path: "assets/logo.png",
  title: "logo.png",
};
const liveImageProps = {
  tabId: "live-image-diff-tab",
  environmentId: "env-1",
  filePath: "assets/logo.png",
  worktreePath: "/repo",
  isLocalEnvironment: true,
  isActive: true,
  changeDiff: liveImageTarget,
};

function invalidateImage(generation: number, ownerGeneration?: string) {
  act(() => {
    useChangeProjectionStore
      .getState()
      .applyContentInvalidation(RESOURCE_KEY, generation, null, ownerGeneration);
  });
}

beforeEach(() => {
  resetChangeSubscriptionsForTests();
  useChangeProjectionStore.setState({
    projections: new Map(),
    retiredOwners: new Map(),
    transportRevision: 0,
    deleted: new Set(),
    contentGenerations: new Map(),
    toolPresentations: new Map(),
  });
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  readLocalFileMock.mockClear();
  readContainerFileMock.mockClear();
  readEnvironmentFileBase64Mock.mockClear();
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
  readEnvironmentFileBase64Mock.mockImplementation(async () => RED_PNG);
  readContainerFileBase64Mock.mockImplementation(async () => RED_PNG);
  getFileDraftMock.mockImplementation(async () => null);
  saveFileDraftMock.mockImplementation(async () => undefined);
  deleteFileDraftMock.mockImplementation(async () => undefined);
});

afterEach(() => {
  cleanup();
  resetChangeSubscriptionsForTests();
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

  test("prioritizes a diff target, including for images", () => {
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
    ).toBe("diff");
    expect(
      getFileViewerKind("app-preview.AVIF", {
        showDiff: false,
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
        environmentId="environment-1"
        filePath="assets/logo.png"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
      />,
    );

    const image = await screen.findByRole("img", { name: "assets/logo.png" });
    expect(image.getAttribute("src")).toBe(`data:image/png;base64,${RED_PNG}`);
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledWith("environment-1", "assets/logo.png");
  });

  test("loads AVIF images with the correct MIME type", async () => {
    render(
      <FileViewerTab
        tabId="avif-image-tab"
        environmentId="environment-1"
        filePath="assets/app-preview.avif"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
      />,
    );

    const image = await screen.findByRole("img", { name: "assets/app-preview.avif" });
    expect(image.getAttribute("src")).toBe(`data:image/avif;base64,${RED_PNG}`);
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledWith(
      "environment-1",
      "assets/app-preview.avif",
    );
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
    expect(image.getAttribute("src")).toBe(`data:image/webp;base64,${RED_PNG}`);
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
        changeDiff={liveTarget}
      />,
    );

    const viewer = await screen.findByTestId("diff-viewer");
    expect(JSON.parse(viewer.dataset.target ?? "null")).toEqual(liveTarget);
    expect(readLocalFileMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View file" }));
    expect(await screen.findByTestId("markdown-file-editor")).toBeTruthy();
    expect(readLocalFileMock).toHaveBeenCalledWith("/repo", "README.md");
  });

  test("renders an image diff target as a diff without reading today's image", async () => {
    const historicalTarget: ChangeDiffTarget = {
      kind: "historical",
      diffIdentityId: "diff-1",
      title: "logo.png",
    };
    render(
      <FileViewerTab
        tabId="image-diff-tab"
        environmentId="env-1"
        filePath="assets/logo.png"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
        changeDiff={historicalTarget}
      />,
    );

    const viewer = await screen.findByTestId("diff-viewer");
    expect(JSON.parse(viewer.dataset.target ?? "null")).toEqual(historicalTarget);
    expect(readEnvironmentFileBase64Mock).not.toHaveBeenCalled();
    expect(readLocalFileMock).not.toHaveBeenCalled();
  });

  test("previews a live image target instead of its binary diff", async () => {
    render(<FileViewerTab {...liveImageProps} />);

    const image = await screen.findByRole("img", { name: "assets/logo.png" });
    expect(image.getAttribute("src")).toBe(`data:image/png;base64,${RED_PNG}`);
    expect(screen.queryByTestId("diff-viewer") === null).toBe(true);
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledWith("env-1", "assets/logo.png");
  });

  test("falls back to the diff when a live image cannot be read", async () => {
    readEnvironmentFileBase64Mock.mockImplementationOnce(async () => {
      throw new Error("No such file");
    });
    const liveImageTarget: ChangeDiffTarget = {
      kind: "live",
      resourceKey: "environment-net/environment/env-1/live",
      path: "assets/deleted.png",
      title: "deleted.png",
    };
    render(
      <FileViewerTab
        tabId="deleted-image-diff-tab"
        environmentId="env-1"
        filePath="assets/deleted.png"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
        changeDiff={liveImageTarget}
      />,
    );

    const viewer = await screen.findByTestId("diff-viewer");
    expect(JSON.parse(viewer.dataset.target ?? "null")).toEqual(liveImageTarget);
    expect(screen.queryByText("Failed to load file") === null).toBe(true);
  });

  test("refreshes live container images after content invalidation", async () => {
    render(
      <FileViewerTab {...liveImageProps} isLocalEnvironment={false} containerId="container-1" />,
    );
    await screen.findByRole("img", { name: "assets/logo.png" });
    readContainerFileBase64Mock.mockResolvedValueOnce(BLUE_PNG);

    invalidateImage(1);

    await waitFor(() =>
      expect(screen.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${BLUE_PNG}`),
    );
    expect(readContainerFileBase64Mock).toHaveBeenCalledTimes(2);
    expect(readContainerFileBase64Mock).toHaveBeenLastCalledWith("container-1", "assets/logo.png");
    expect(readEnvironmentFileBase64Mock).not.toHaveBeenCalled();
  });

  test("falls back on deletion and recovers when the same live image is restored", async () => {
    render(<FileViewerTab {...liveImageProps} />);
    await screen.findByRole("img");
    readEnvironmentFileBase64Mock.mockRejectedValueOnce(new Error("No such file"));

    invalidateImage(1);
    await screen.findByTestId("diff-viewer");
    expect(screen.queryByRole("img") === null).toBe(true);

    readEnvironmentFileBase64Mock.mockResolvedValueOnce(BLUE_PNG);
    invalidateImage(2);
    await waitFor(() =>
      expect(screen.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${BLUE_PNG}`),
    );
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(3);
  });

  test("refreshes on reconnect and retries a failed preview", async () => {
    render(<FileViewerTab {...liveImageProps} />);
    await screen.findByRole("img");
    readEnvironmentFileBase64Mock.mockRejectedValueOnce(new Error("Connection lost"));

    act(() => useChangeProjectionStore.getState().resync());
    await screen.findByTestId("diff-viewer");
    act(() => useChangeProjectionStore.getState().resync());

    await screen.findByRole("img");
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(3);
  });

  test("refreshes when the resource owner changes even if its generation does not advance", async () => {
    invalidateImage(5, "owner-a");
    render(<FileViewerTab {...liveImageProps} />);
    await screen.findByRole("img");
    readEnvironmentFileBase64Mock.mockResolvedValueOnce(BLUE_PNG);

    invalidateImage(1, "owner-b");

    await waitFor(() =>
      expect(screen.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${BLUE_PNG}`),
    );
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(2);
  });

  test("refreshes on reactivation after a missed event and resets failure state", async () => {
    const view = render(<FileViewerTab {...liveImageProps} />);
    await screen.findByRole("img");
    view.rerender(<FileViewerTab {...liveImageProps} isActive={false} />);
    readEnvironmentFileBase64Mock.mockRejectedValueOnce(new Error("Deleted while away"));
    // No invalidation is delivered while the tab is away.
    view.rerender(<FileViewerTab {...liveImageProps} />);
    await screen.findByTestId("diff-viewer");

    view.rerender(<FileViewerTab {...liveImageProps} isActive={false} />);
    invalidateImage(1);
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(2);
    view.rerender(<FileViewerTab {...liveImageProps} />);
    await screen.findByRole("img");
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(3);
  });

  test("does not read an initially inactive preview until it becomes active", async () => {
    const view = render(<FileViewerTab {...liveImageProps} isActive={false} />);
    expect(readEnvironmentFileBase64Mock).not.toHaveBeenCalled();
    view.rerender(<FileViewerTab {...liveImageProps} />);
    await screen.findByRole("img");
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(1);
  });

  test("falls back after image decode failure and retries on invalidation", async () => {
    readEnvironmentFileBase64Mock.mockResolvedValueOnce("bm90IGFuIGltYWdl");
    render(<FileViewerTab {...liveImageProps} />);
    fireEvent.error(await screen.findByRole("img"));
    await screen.findByTestId("diff-viewer");

    invalidateImage(1);
    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe(`data:image/png;base64,${RED_PNG}`);
  });

  test("ignores decode errors from an inactive preview while its replacement loads", async () => {
    let resolveRead!: (value: string) => void;
    const view = render(<FileViewerTab {...liveImageProps} />);
    const oldImage = await screen.findByRole("img");
    view.rerender(<FileViewerTab {...liveImageProps} isActive={false} />);
    readEnvironmentFileBase64Mock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    view.rerender(<FileViewerTab {...liveImageProps} />);
    await waitFor(() => expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(2));
    // The old node is still mounted until the reactivation read answers.
    fireEvent.error(oldImage);
    expect(screen.queryByTestId("diff-viewer") === null).toBe(true);
    await act(async () => resolveRead(BLUE_PNG));
    await waitFor(() =>
      expect(screen.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${BLUE_PNG}`),
    );
  });

  test("keeps live SVG source hunks accessible through the backend diff", async () => {
    const target: ChangeDiffTarget = { ...liveImageTarget, path: "assets/logo.svg" };
    render(<FileViewerTab {...liveImageProps} filePath="assets/logo.svg" changeDiff={target} />);
    const viewer = await screen.findByTestId("diff-viewer");
    expect(JSON.parse(viewer.dataset.target ?? "null")).toEqual(target);
    expect(readEnvironmentFileBase64Mock).not.toHaveBeenCalled();
    // The existing file-view control still permits an explicit SVG preview.
    fireEvent.click(screen.getByRole("button", { name: "View file" }));
    await screen.findByRole("img", { name: "assets/logo.svg" });
  });

  test("retries when a different target owns the same image path", async () => {
    readEnvironmentFileBase64Mock.mockRejectedValueOnce(new Error("No such file"));
    const view = render(<FileViewerTab {...liveImageProps} />);
    await screen.findByTestId("diff-viewer");
    view.rerender(
      <FileViewerTab
        {...liveImageProps}
        environmentId="env-2"
        changeDiff={{ ...liveImageTarget, resourceKey: "environment-net/environment/env-2/live" }}
      />,
    );
    await screen.findByRole("img");
    expect(readEnvironmentFileBase64Mock).toHaveBeenLastCalledWith("env-2", "assets/logo.png");
  });

  test("ignores superseded image reads, rejections, and decode errors", async () => {
    let resolveOldRead!: (value: string) => void;
    let rejectOldRead!: (error: Error) => void;
    const view = render(<FileViewerTab {...liveImageProps} />);
    const oldImage = await screen.findByRole("img");
    readEnvironmentFileBase64Mock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldRead = resolve;
        }),
    );
    invalidateImage(1);
    await waitFor(() => expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(2));
    readEnvironmentFileBase64Mock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOldRead = reject;
        }),
    );
    invalidateImage(2);
    await waitFor(() => expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(3));
    readEnvironmentFileBase64Mock.mockResolvedValueOnce(BLUE_PNG);
    view.rerender(
      <FileViewerTab
        {...liveImageProps}
        filePath="assets/new.png"
        changeDiff={{ ...liveImageTarget, path: "assets/new.png" }}
      />,
    );
    await screen.findByRole("img", { name: "assets/new.png" });

    await act(async () => {
      resolveOldRead(RED_PNG);
      rejectOldRead(new Error("Old read failed"));
      fireEvent.error(oldImage);
      await Promise.resolve();
    });
    expect(screen.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${BLUE_PNG}`);
    expect(screen.queryByTestId("diff-viewer") === null).toBe(true);
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

  test("reloading after a save conflict drops the edits and the saved draft", async () => {
    writeContainerFileMock.mockRejectedValueOnce(new Error(FILE_WRITE_CONFLICT_MESSAGE));
    mockToastError.mockClear();
    render(
      <FileViewerTab
        tabId="conflict-tab"
        environmentId="env-conflict"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    fireEvent.change(editor, { target: { value: "mine" } });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(useFileDirtyStore.getState().isDirty("conflict-tab")).toBe(true);

    readContainerFileMock.mockImplementation(async () => ({
      content: "newer on disk",
      language: "plaintext",
    }));
    const options = mockToastError.mock.calls.at(-1)?.[1] as {
      cancel: { label: string; onClick: () => void };
    };
    expect(options.cancel.label).toBe("Reload");
    act(() => options.cancel.onClick());

    await waitFor(async () =>
      expect(
        ((await screen.findByRole("textbox", { name: "Monaco plaintext" })) as HTMLTextAreaElement)
          .value,
      ).toBe("newer on disk"),
    );
    expect(deleteFileDraftMock).toHaveBeenCalled();
    expect(useFileDirtyStore.getState().dirtyFiles.get("conflict-tab")).toEqual({
      content: "newer on disk",
      originalContent: "newer on disk",
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
