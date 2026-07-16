import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useFileDirtyStore } from "@/stores/fileDirtyStore";
import * as realBackend from "@/lib/backend";
import * as realMarkdownEditorTab from "@/components/markdown/MarkdownEditorTab";
import * as realDiffViewerTab from "./DiffViewerTab";
import * as realMonacoFileEditor from "./MonacoFileEditor";

const realBackendSnapshot = { ...realBackend };
const realMarkdownEditorTabSnapshot = { ...realMarkdownEditorTab };
const realDiffViewerTabSnapshot = { ...realDiffViewerTab };
const realMonacoFileEditorSnapshot = { ...realMonacoFileEditor };

const readLocalFileMock = mock(
  async (_worktreePath: string, _filePath: string) => ({
    content: "# Loaded Markdown",
    language: "markdown",
  }),
);
const readContainerFileMock = mock(
  async (_containerId: string, _filePath: string) => ({
    content: "container text",
    language: "plaintext",
  }),
);
const readFileBase64Mock = mock(async (_filePath: string) => "aW1hZ2U=");
const readContainerFileBase64Mock = mock(
  async (_containerId: string, _filePath: string) => "Y29udGFpbmVyLWltYWdl",
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  readLocalFile: readLocalFileMock,
  readContainerFile: readContainerFileMock,
  readFileBase64: readFileBase64Mock,
  readContainerFileBase64: readContainerFileBase64Mock,
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

const {
  FileViewerTab,
  getFileViewerKind,
  isMarkdownFile,
} = await import("./FileViewerTab");

beforeEach(() => {
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  readLocalFileMock.mockClear();
  readContainerFileMock.mockClear();
  readFileBase64Mock.mockClear();
  readContainerFileBase64Mock.mockClear();
  readLocalFileMock.mockImplementation(async () => ({
    content: "# Loaded Markdown",
    language: "markdown",
  }));
  readContainerFileMock.mockImplementation(async () => ({
    content: "container text",
    language: "plaintext",
  }));
  readFileBase64Mock.mockImplementation(async () => "aW1hZ2U=");
});

afterEach(() => {
  cleanup();
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module(
    "@/components/markdown/MarkdownEditorTab",
    () => realMarkdownEditorTabSnapshot,
  );
  mock.module("./DiffViewerTab", () => realDiffViewerTabSnapshot);
  mock.module("./MonacoFileEditor", () => realMonacoFileEditorSnapshot);
});

describe("FileViewerTab routing", () => {
  test("routes Markdown extensions to the rich editor", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("docs/guide.MARKDOWN")).toBe(true);
    expect(getFileViewerKind("README.md", {
      showDiff: false,
      hasDiffData: false,
    })).toBe("markdown");
  });

  test("keeps non-Markdown text files in Monaco", () => {
    expect(isMarkdownFile("src/index.ts")).toBe(false);
    expect(isMarkdownFile("component.mdx")).toBe(false);
    expect(getFileViewerKind("src/index.ts", {
      showDiff: false,
      hasDiffData: false,
    })).toBe("text");
  });

  test("prioritizes valid diffs except for images", () => {
    expect(getFileViewerKind("README.md", {
      showDiff: true,
      hasDiffData: true,
    })).toBe("diff");
    expect(getFileViewerKind("diagram.png", {
      showDiff: true,
      hasDiffData: true,
    })).toBe("image");
    expect(getFileViewerKind("README.md", {
      showDiff: true,
      hasDiffData: false,
    })).toBe("markdown");
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
    expect(useFileDirtyStore.getState().getContent("markdown-tab")).toBe(
      "# Loaded Markdown",
    );
  });

  test("loads container text into Monaco and tracks changes", async () => {
    render(
      <FileViewerTab
        tabId="text-tab"
        filePath="notes.txt"
        containerId="container-1"
        isActive
      />,
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
    expect(image.getAttribute("src")).toBe(
      "data:image/webp;base64,Y29udGFpbmVyLWltYWdl",
    );
    expect(readContainerFileBase64Mock).toHaveBeenCalledWith(
      "container-1",
      "assets/logo.webp",
    );
  });

  test("reports an image load error when no environment path is available", async () => {
    render(
      <FileViewerTab
        tabId="missing-image-environment-tab"
        filePath="assets/logo.png"
        isActive
      />,
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

    expect(screen.getByTestId("diff-viewer")).toBeTruthy();
    expect(readLocalFileMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View file" }));
    expect(await screen.findByTestId("markdown-file-editor")).toBeTruthy();
    expect(readLocalFileMock).toHaveBeenCalledWith("/repo", "README.md");
  });

  test("clears per-tab dirty state when the file tab unmounts", async () => {
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

    expect(useFileDirtyStore.getState().getContent("closing-tab")).toBeNull();
  });
});
