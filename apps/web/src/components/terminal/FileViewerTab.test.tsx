import { invoke } from "@/lib/native/backend";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { fileDirtyStore } from "@/stores/fileDirtyStore";
import { changeProjectionStore } from "@/stores/changeProjectionStore";
import { resetChangeSubscriptionsForTests } from "@/lib/changes/subscriptions";
import * as realBackend from "@/lib/backend";
import * as realMarkdownEditorTab from "@/components/markdown/MarkdownEditorTab";
import * as realDiffViewerTab from "./DiffViewerTab";
import * as realMonacoFileEditor from "./MonacoFileEditor";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import { FILE_WRITE_CONFLICT_MESSAGE } from "@orkestrator/protocol/file-write-precondition";
import { appCommandStore } from "@/test/app-command-store";

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

const { FileViewerTab, getFileViewerKind, isHtmlFile, isMarkdownFile } =
  await import("./FileViewerTab");

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
    appCommandStore(changeProjectionStore)
      .getState()
      .applyContentInvalidation(RESOURCE_KEY, generation, null, ownerGeneration);
  });
}

beforeEach(() => {
  resetChangeSubscriptionsForTests();
  appCommandStore(changeProjectionStore).setState({
    projections: new Map(),
    retiredOwners: new Map(),
    transportRevision: 0,
    deleted: new Set(),
    contentGenerations: new Map(),
    toolPresentations: new Map(),
  });
  appCommandStore(fileDirtyStore).setState({ dirtyFiles: new Map() });
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
  appCommandStore(fileDirtyStore).setState({ dirtyFiles: new Map() });
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

  test("routes HTML extensions to the rendered view", () => {
    expect(isHtmlFile("docs/report.html")).toBe(true);
    expect(isHtmlFile("index.HTM")).toBe(true);
    expect(isHtmlFile("page.html.tmpl")).toBe(false);
    expect(
      getFileViewerKind("docs/report.html", {
        showDiff: false,
        hasDiffData: false,
      }),
    ).toBe("html");
    expect(
      getFileViewerKind("docs/report.html", {
        showDiff: true,
        hasDiffData: true,
      }),
    ).toBe("diff");
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
    renderInAppCommandScope(
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
    expect(appCommandStore(fileDirtyStore).getState().getContent("markdown-tab")).toBe(
      "# Loaded Markdown",
    );
  });

  test("opens a local HTML file on its rendered view, with Raw one click away", async () => {
    readLocalFileMock.mockImplementationOnce(async () => ({
      content: "<h1>Report</h1>",
      language: "html",
    }));
    renderInAppCommandScope(
      <FileViewerTab
        tabId="html-tab"
        filePath="docs/report.html"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
      />,
    );

    const frame = await screen.findByTitle("Rendered view of docs/report.html");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Report</h1>");
    expect(readLocalFileMock).toHaveBeenCalledWith("/repo", "docs/report.html");
    expect(appCommandStore(fileDirtyStore).getState().getContent("html-tab")).toBe(
      "<h1>Report</h1>",
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Raw" }), { button: 0 });
    const editor = await screen.findByRole("textbox", { name: "Monaco html" });
    expect((editor as HTMLTextAreaElement).value).toBe("<h1>Report</h1>");
  });

  test("a changed HTML file opens on its diff and renders from View file", async () => {
    readLocalFileMock.mockImplementationOnce(async () => ({
      content: "<h1>Report</h1>",
      language: "html",
    }));
    renderInAppCommandScope(
      <FileViewerTab
        tabId="html-diff-tab"
        filePath="docs/report.html"
        worktreePath="/repo"
        isLocalEnvironment
        isActive
        changeDiff={{ ...liveTarget, path: "docs/report.html", title: "report.html" }}
      />,
    );

    expect(await screen.findByTestId("diff-viewer")).toBeTruthy();
    expect(readLocalFileMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "View file" }));
    expect(await screen.findByTitle("Rendered view of docs/report.html")).toBeTruthy();
  });

  test("loads container text into Monaco and tracks changes", async () => {
    renderInAppCommandScope(
      <FileViewerTab tabId="text-tab" filePath="notes.txt" containerId="container-1" isActive />,
    );

    const editor = await screen.findByRole("textbox", { name: "Monaco plaintext" });
    expect((editor as HTMLTextAreaElement).value).toBe("container text");
    fireEvent.change(editor, { target: { value: "updated text" } });
    expect(appCommandStore(fileDirtyStore).getState().getContent("text-tab")).toBe("updated text");
  });

  test("shows backend read errors", async () => {
    readLocalFileMock.mockRejectedValueOnce(new Error("read unavailable"));
    renderInAppCommandScope(
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
    renderInAppCommandScope(
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
    renderInAppCommandScope(
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
    renderInAppCommandScope(
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
    renderInAppCommandScope(
      <FileViewerTab tabId="missing-image-environment-tab" filePath="assets/logo.png" isActive />,
    );

    expect(await screen.findByText("Failed to load file")).toBeTruthy();
    expect(
      screen.getByText("No container ID or worktree path available for image viewing"),
    ).toBeTruthy();
  });

  test("switches from a Markdown diff to the loaded rich editor", async () => {
    renderInAppCommandScope(
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
    renderInAppCommandScope(
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
    renderInAppCommandScope(<FileViewerTab {...liveImageProps} />);

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
    renderInAppCommandScope(
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
    renderInAppCommandScope(
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
    renderInAppCommandScope(<FileViewerTab {...liveImageProps} />);
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
    renderInAppCommandScope(<FileViewerTab {...liveImageProps} />);
    await screen.findByRole("img");
    readEnvironmentFileBase64Mock.mockRejectedValueOnce(new Error("Connection lost"));

    act(() => appCommandStore(changeProjectionStore).getState().resync());
    await screen.findByTestId("diff-viewer");
    act(() => appCommandStore(changeProjectionStore).getState().resync());

    await screen.findByRole("img");
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(3);
  });

  test("refreshes when the resource owner changes even if its generation does not advance", async () => {
    invalidateImage(5, "owner-a");
    renderInAppCommandScope(<FileViewerTab {...liveImageProps} />);
    await screen.findByRole("img");
    readEnvironmentFileBase64Mock.mockResolvedValueOnce(BLUE_PNG);

    invalidateImage(1, "owner-b");

    await waitFor(() =>
      expect(screen.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${BLUE_PNG}`),
    );
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(2);
  });

  test("refreshes on reactivation after a missed event and resets failure state", async () => {
    const view = renderInAppCommandScope(<FileViewerTab {...liveImageProps} />);
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
    const view = renderInAppCommandScope(<FileViewerTab {...liveImageProps} isActive={false} />);
    expect(readEnvironmentFileBase64Mock).not.toHaveBeenCalled();
    view.rerender(<FileViewerTab {...liveImageProps} />);
    await screen.findByRole("img");
    expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(1);
  });

  test("falls back after image decode failure and retries on invalidation", async () => {
    readEnvironmentFileBase64Mock.mockResolvedValueOnce("bm90IGFuIGltYWdl");
    renderInAppCommandScope(<FileViewerTab {...liveImageProps} />);
    fireEvent.error(await screen.findByRole("img"));
    await screen.findByTestId("diff-viewer");

    invalidateImage(1);
    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe(`data:image/png;base64,${RED_PNG}`);
  });

  test("ignores decode errors from an inactive preview while its replacement loads", async () => {
    let resolveRead!: (value: string) => void;
    const view = renderInAppCommandScope(<FileViewerTab {...liveImageProps} />);
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
    renderInAppCommandScope(
      <FileViewerTab {...liveImageProps} filePath="assets/logo.svg" changeDiff={target} />,
    );
    const viewer = await screen.findByTestId("diff-viewer");
    expect(JSON.parse(viewer.dataset.target ?? "null")).toEqual(target);
    expect(readEnvironmentFileBase64Mock).not.toHaveBeenCalled();
    // The existing file-view control still permits an explicit SVG preview.
    fireEvent.click(screen.getByRole("button", { name: "View file" }));
    await screen.findByRole("img", { name: "assets/logo.svg" });
  });

  test("retries when a different target owns the same image path", async () => {
    readEnvironmentFileBase64Mock.mockRejectedValueOnce(new Error("No such file"));
    const view = renderInAppCommandScope(<FileViewerTab {...liveImageProps} />);
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
    const view = renderInAppCommandScope(<FileViewerTab {...liveImageProps} />);
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
    const view = renderInAppCommandScope(
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
      appCommandStore(fileDirtyStore).getState().setContent("closing-tab", "unsaved");
    });

    view.unmount();

    expect(appCommandStore(fileDirtyStore).getState().getContent("closing-tab")).toBe("unsaved");
  });

  test("prefers a newer in-memory buffer over an older backend draft on remount", async () => {
    appCommandStore(fileDirtyStore)
      .getState()
      .hydrateDraft("remount-tab", "newer unsaved buffer", "older disk");
    getFileDraftMock.mockResolvedValueOnce({
      draftKey: "file:env-1:notes.txt",
      environmentId: "env-1",
      filePath: "notes.txt",
      content: "stale backend buffer",
      originalContent: "older disk",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    });

    renderInAppCommandScope(
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
    expect(appCommandStore(fileDirtyStore).getState().dirtyFiles.get("remount-tab")).toEqual({
      content: "newer unsaved buffer",
      originalContent: "container text",
      // A save still checks what the buffer was edited from, not the newer read.
      baseContent: "older disk",
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

    renderInAppCommandScope(
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
    expect(appCommandStore(fileDirtyStore).getState().dirtyFiles.get("restore-tab")).toEqual({
      content: "restored buffer",
      originalContent: "container text",
      baseContent: "old disk",
    });
  });

  test("reloading after a save conflict drops the edits and the saved draft", async () => {
    writeContainerFileMock.mockRejectedValueOnce(new Error(FILE_WRITE_CONFLICT_MESSAGE));
    mockToastError.mockClear();
    renderInAppCommandScope(
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
    expect(appCommandStore(fileDirtyStore).getState().isDirty("conflict-tab")).toBe(true);

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
    expect(appCommandStore(fileDirtyStore).getState().dirtyFiles.get("conflict-tab")).toEqual({
      content: "newer on disk",
      originalContent: "newer on disk",
    });
  });

  test("persists edits through the environment-scoped file draft path", async () => {
    renderInAppCommandScope(
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
    const view = renderInAppCommandScope(
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
    renderInAppCommandScope(
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
    const view = renderInAppCommandScope(
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
      expect(appCommandStore(fileDirtyStore).getState().isDirty("save-unmount-tab")).toBe(false),
    );

    view.unmount();

    await waitFor(() =>
      expect(deleteFileDraftMock).toHaveBeenCalledWith("file:env-save:notes.txt", 0),
    );
  });

  test("continues with the disk buffer when backend draft restore fails", async () => {
    getFileDraftMock.mockRejectedValueOnce(new Error("draft store unavailable"));

    renderInAppCommandScope(
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
    expect(appCommandStore(fileDirtyStore).getState().isDirty("draft-error-tab")).toBe(false);
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
    renderInAppCommandScope(
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
    expect(appCommandStore(fileDirtyStore).getState().getContent("save-conflict-tab")).toBe(
      "my unsaved text",
    );
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
    renderInAppCommandScope(
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
    const view = renderInAppCommandScope(
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
    expect(appCommandStore(fileDirtyStore).getState().getContent("stale-read-tab")).toBe(
      "container text",
    );
  });

  test("ignores an older file-read rejection after its props change", async () => {
    let rejectOldRead!: (error: Error) => void;
    const oldRead = new Promise<realBackend.FileContent>((_resolve, reject) => {
      rejectOldRead = reject;
    });
    readContainerFileMock.mockImplementationOnce(() => oldRead);
    const view = renderInAppCommandScope(
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
    const view = renderInAppCommandScope(
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
    expect(appCommandStore(fileDirtyStore).getState().getContent("stale-draft-tab")).toBe(
      "container text",
    );
  });

  test("ignores a file read that finishes after unmount", async () => {
    let resolveRead!: (content: realBackend.FileContent) => void;
    readContainerFileMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const view = renderInAppCommandScope(
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

    expect(appCommandStore(fileDirtyStore).getState().getContent("unmounted-read-tab")).toBeNull();
  });
});

for (const diff of [false, true]) {
  test(`unreachable stream falls back in ${diff ? "live diff" : "file viewer"}`, async () => {
    const originalImage = globalThis.Image;
    const invokeMock = invoke as unknown as ReturnType<typeof mock>;
    resetTranscriptArtifactCapabilities();
    const closed: string[] = [];
    invokeMock.mockImplementation(async (command: string, args: { streamId?: string }) => {
      if (command === "transcript_artifact_capabilities")
        return {
          backendId: "backend-1",
          contentOrigin: "https://artifacts.example-usercontent.net",
        };
      if (command === "transcript_media_open_stream")
        return {
          url: "https://artifacts.example-usercontent.net/m/unreachable",
          mimeType: "image/png",
          streamId: "stream-1",
        };
      if (command === "transcript_media_close_stream") closed.push(args.streamId!);
      return null;
    });
    globalThis.Image = function () {
      const img = document.createElement("img");
      Object.defineProperty(img, "src", {
        set: () => queueMicrotask(() => img.dispatchEvent(new Event("error"))),
      });
      return img;
    } as unknown as typeof Image;
    try {
      const view = renderInAppCommandScope(
        <FileViewerTab {...liveImageProps} changeDiff={diff ? liveImageTarget : undefined} />,
      );
      await waitFor(() =>
        expect(screen.getByAltText("assets/logo.png").getAttribute("src")).toBe(
          `data:image/png;base64,${RED_PNG}`,
        ),
      );
      expect(readEnvironmentFileBase64Mock).toHaveBeenCalledTimes(1);
      expect(closed).toEqual(["stream-1"]);
      view.unmount();
      expect(closed).toEqual(["stream-1"]);
    } finally {
      globalThis.Image = originalImage;
      resetTranscriptArtifactCapabilities();
      invokeMock.mockImplementation(() => Promise.resolve());
    }
  });
}

for (const diff of [false, true]) {
  test(`pending stream is released on path change and unmount in ${diff ? "live diff" : "file viewer"}`, async () => {
    const originalImage = globalThis.Image;
    const invokeMock = invoke as unknown as ReturnType<typeof mock>;
    resetTranscriptArtifactCapabilities();
    const closed: string[] = [];
    let opened = 0;
    invokeMock.mockImplementation(async (command: string, args: { streamId?: string }) => {
      if (command === "transcript_artifact_capabilities")
        return {
          backendId: "backend-1",
          contentOrigin: "https://artifacts.example-usercontent.net",
        };
      if (command === "transcript_media_open_stream")
        return {
          url: "https://artifacts.example-usercontent.net/m/pending",
          mimeType: "image/png",
          streamId: `stream-${++opened}`,
        };
      if (command === "transcript_media_close_stream") closed.push(args.streamId!);
      return null;
    });
    globalThis.Image = function () {
      return document.createElement("img");
    } as unknown as typeof Image;
    try {
      const view = renderInAppCommandScope(
        <FileViewerTab {...liveImageProps} changeDiff={diff ? liveImageTarget : undefined} />,
      );
      await waitFor(() => expect(opened).toBe(1));
      view.rerender(
        <FileViewerTab
          {...liveImageProps}
          filePath="other.png"
          changeDiff={diff ? { ...liveImageTarget, path: "other.png" } : undefined}
        />,
      );
      await waitFor(() => expect(opened).toBe(2));
      expect(closed).toEqual(["stream-1"]);
      view.unmount();
      await waitFor(() => expect(closed).toEqual(["stream-1", "stream-2"]));
      expect(readEnvironmentFileBase64Mock).not.toHaveBeenCalled();
    } finally {
      globalThis.Image = originalImage;
      resetTranscriptArtifactCapabilities();
      invokeMock.mockImplementation(() => Promise.resolve());
    }
  });
}
