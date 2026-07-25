import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import * as realMonacoReact from "@monaco-editor/react";

const realBackendSnapshot = { ...realBackend };
const realMonacoReactSnapshot = { ...realMonacoReact };

const readLocalFileMock = mock(async (_worktreePath: string, _filePath: string) => ({
  content: "local modified",
  language: "typescript",
}));
const readLocalFileAtBranchMock = mock(
  async (_worktreePath: string, _filePath: string, _branch: string) => ({
    content: "local original",
    language: "typescript",
  }),
);
const readContainerFileMock = mock(async (_containerId: string, _filePath: string) => ({
  content: "container modified",
  language: "javascript",
}));
const readFileAtBranchMock = mock(
  async (_containerId: string, _filePath: string, _branch: string) => ({
    content: "container original",
    language: "javascript",
  }),
);

interface MockDiffEditorProps {
  language?: string;
  original?: string;
  modified?: string;
  beforeMount?: (monaco: unknown) => void;
  onMount?: (editor: unknown) => void;
  options?: Record<string, unknown>;
}

let renderedDiffEditorProps: MockDiffEditorProps | null = null;

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  readLocalFile: readLocalFileMock,
  readLocalFileAtBranch: readLocalFileAtBranchMock,
  readContainerFile: readContainerFileMock,
  readFileAtBranch: readFileAtBranchMock,
}));

mock.module("@monaco-editor/react", () => ({
  ...realMonacoReactSnapshot,
  DiffEditor: (props: MockDiffEditorProps) => {
    renderedDiffEditorProps = props;
    return (
      <div
        data-testid="diff-editor"
        data-language={props.language}
        data-original={props.original}
        data-modified={props.modified}
        data-side-by-side={String(props.options?.renderSideBySide)}
      />
    );
  },
}));

const { DiffViewerTab } = await import("./DiffViewerTab");

const baseProps = {
  filePath: "src/components/Button.tsx",
  baseBranch: "main",
  gitStatus: "M" as const,
  isActive: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  renderedDiffEditorProps = null;
  readLocalFileMock.mockClear();
  readLocalFileAtBranchMock.mockClear();
  readContainerFileMock.mockClear();
  readFileAtBranchMock.mockClear();
  readLocalFileMock.mockImplementation(async () => ({
    content: "local modified",
    language: "typescript",
  }));
  readLocalFileAtBranchMock.mockImplementation(async () => ({
    content: "local original",
    language: "typescript",
  }));
  readContainerFileMock.mockImplementation(async () => ({
    content: "container modified",
    language: "javascript",
  }));
  readFileAtBranchMock.mockImplementation(async () => ({
    content: "container original",
    language: "javascript",
  }));
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@monaco-editor/react", () => realMonacoReactSnapshot);
});

describe("DiffViewerTab content loading", () => {
  test("loads modified and original content from a local worktree", async () => {
    render(
      <DiffViewerTab
        {...baseProps}
        worktreePath="/repo"
        isLocalEnvironment
      />,
    );

    expect(screen.getByText("Loading diff...")).toBeTruthy();
    const editor = await screen.findByTestId("diff-editor");
    expect(readLocalFileMock).toHaveBeenCalledWith("/repo", baseProps.filePath);
    expect(readLocalFileAtBranchMock).toHaveBeenCalledWith(
      "/repo",
      baseProps.filePath,
      "main",
    );
    expect(editor.dataset.original).toBe("local original");
    expect(editor.dataset.modified).toBe("local modified");
    expect(editor.dataset.language).toBe("typescript");
    expect(screen.getByText("Modified")).toBeTruthy();
  });

  test("loads modified and original content from a container", async () => {
    render(<DiffViewerTab {...baseProps} containerId="container-1" />);

    const editor = await screen.findByTestId("diff-editor");
    expect(readContainerFileMock).toHaveBeenCalledWith(
      "container-1",
      baseProps.filePath,
    );
    expect(readFileAtBranchMock).toHaveBeenCalledWith(
      "container-1",
      baseProps.filePath,
      "main",
    );
    expect(editor.dataset.original).toBe("container original");
    expect(editor.dataset.modified).toBe("container modified");
    expect(editor.dataset.language).toBe("javascript");
  });

  test.each(["A", "?"] as const)(
    "treats %s as a new file and skips the original read",
    async (gitStatus) => {
      render(
        <DiffViewerTab
          {...baseProps}
          containerId="container-1"
          gitStatus={gitStatus}
        />,
      );

      const editor = await screen.findByTestId("diff-editor");
      expect(editor.dataset.original).toBe("");
      expect(editor.dataset.modified).toBe("container modified");
      expect(readFileAtBranchMock).not.toHaveBeenCalled();
      expect(screen.getByText("New file")).toBeTruthy();
    },
  );

  test("loads only the original content for a deleted file", async () => {
    const onSwitchToFileView = mock(() => {});
    render(
      <DiffViewerTab
        {...baseProps}
        containerId="container-1"
        gitStatus="D"
        onSwitchToFileView={onSwitchToFileView}
      />,
    );

    const editor = await screen.findByTestId("diff-editor");
    expect(readContainerFileMock).not.toHaveBeenCalled();
    expect(readFileAtBranchMock).toHaveBeenCalledWith(
      "container-1",
      baseProps.filePath,
      "main",
    );
    expect(editor.dataset.original).toBe("container original");
    expect(editor.dataset.modified).toBe("");
    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.queryByTitle("View file")).toBeNull();
  });

  test("uses the prop language and plaintext fallbacks when detection is absent", async () => {
    readContainerFileMock.mockImplementation(async () => ({
      content: "puts :ok",
      language: "",
    }));
    const view = render(
      <DiffViewerTab
        {...baseProps}
        containerId="container-1"
        gitStatus="A"
        language="ruby"
      />,
    );

    expect((await screen.findByTestId("diff-editor")).dataset.language).toBe("ruby");

    view.rerender(
      <DiffViewerTab
        {...baseProps}
        filePath="README"
        containerId="container-1"
        gitStatus="A"
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("diff-editor").dataset.language).toBe("plaintext");
    });
  });

  test("reports missing environment paths for current and original reads", async () => {
    const view = render(<DiffViewerTab {...baseProps} gitStatus="A" />);

    expect(await screen.findByText("Failed to load diff")).toBeTruthy();
    expect(
      screen.getByText("No container ID or worktree path available"),
    ).toBeTruthy();

    view.rerender(<DiffViewerTab {...baseProps} gitStatus="D" />);
    expect(await screen.findByText("Failed to load diff")).toBeTruthy();
    expect(
      screen.getByText("No container ID or worktree path available"),
    ).toBeTruthy();
  });

  test("renders Error and non-Error backend failures", async () => {
    readContainerFileMock.mockRejectedValueOnce(new Error("backend unavailable"));
    const view = render(
      <DiffViewerTab {...baseProps} containerId="container-1" gitStatus="A" />,
    );

    expect(await screen.findByText("backend unavailable")).toBeTruthy();

    readContainerFileMock.mockRejectedValueOnce("string failure");
    view.rerender(
      <DiffViewerTab
        {...baseProps}
        filePath="src/Other.ts"
        containerId="container-1"
        gitStatus="A"
      />,
    );
    expect(await screen.findByText("string failure")).toBeTruthy();
  });

  test("ignores a stale async completion after the requested file changes", async () => {
    const firstRead = deferred<realBackend.FileContent>();
    readContainerFileMock.mockImplementation(async (_containerId, filePath) => {
      if (filePath === "src/slow.ts") return firstRead.promise;
      return { content: "latest modified", language: "typescript" };
    });
    readFileAtBranchMock.mockImplementation(async (_containerId, filePath) => ({
      content: `${filePath} original`,
      language: "typescript",
    }));

    const view = render(
      <DiffViewerTab
        {...baseProps}
        filePath="src/slow.ts"
        containerId="container-1"
      />,
    );
    expect(screen.getByText("Loading diff...")).toBeTruthy();

    view.rerender(
      <DiffViewerTab
        {...baseProps}
        filePath="src/latest.ts"
        containerId="container-1"
      />,
    );
    const editor = await screen.findByTestId("diff-editor");
    expect(editor.dataset.modified).toBe("latest modified");
    expect(editor.dataset.original).toBe("src/latest.ts original");

    firstRead.resolve({
      path: "src/slow.ts",
      content: "stale modified",
      language: "javascript",
    });
    await Promise.resolve();
    expect(screen.getByTestId("diff-editor").dataset.modified).toBe(
      "latest modified",
    );
    expect(readFileAtBranchMock).not.toHaveBeenCalledWith(
      "container-1",
      "src/slow.ts",
      "main",
    );
  });
});

describe("DiffViewerTab editor lifecycle and controls", () => {
  test("disables diagnostics before mount and disposes the editor on unmount", async () => {
    const setTypeScriptOptions = mock((_options: unknown) => {});
    const setJavaScriptOptions = mock((_options: unknown) => {});
    const setJsonOptions = mock((_options: unknown) => {});
    const monaco = {
      languages: {
        typescript: {
          typescriptDefaults: { setDiagnosticsOptions: setTypeScriptOptions },
          javascriptDefaults: { setDiagnosticsOptions: setJavaScriptOptions },
        },
        json: {
          jsonDefaults: { setDiagnosticsOptions: setJsonOptions },
        },
      },
    };
    const dispose = mock(() => {});
    const view = render(
      <DiffViewerTab {...baseProps} containerId="container-1" />,
    );
    await screen.findByTestId("diff-editor");

    renderedDiffEditorProps?.beforeMount?.(monaco);
    expect(setTypeScriptOptions).toHaveBeenCalledWith({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    expect(setJavaScriptOptions).toHaveBeenCalledWith({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    expect(setJsonOptions).toHaveBeenCalledWith({ validate: false });

    renderedDiffEditorProps?.onMount?.({ dispose });
    view.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("ignores disposal errors from an already-disposed editor", async () => {
    const view = render(
      <DiffViewerTab {...baseProps} containerId="container-1" />,
    );
    await screen.findByTestId("diff-editor");
    renderedDiffEditorProps?.onMount?.({
      dispose: () => {
        throw new Error("already disposed");
      },
    });

    expect(() => view.unmount()).not.toThrow();
  });

  test("switches diff modes, updates editor options, and opens file view", async () => {
    const onSwitchToFileView = mock(() => {});
    render(
      <DiffViewerTab
        {...baseProps}
        containerId="container-1"
        onSwitchToFileView={onSwitchToFileView}
      />,
    );
    await screen.findByTestId("diff-editor");

    const sideBySide = screen.getByRole("button", { name: "Side by side" });
    const inline = screen.getByRole("button", { name: "Inline" });
    expect(sideBySide.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("diff-editor").dataset.sideBySide).toBe("true");

    fireEvent.click(inline);
    expect(inline.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("diff-editor").dataset.sideBySide).toBe("false");

    fireEvent.click(sideBySide);
    expect(sideBySide.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("diff-editor").dataset.sideBySide).toBe("true");

    fireEvent.click(screen.getByTitle("View file"));
    expect(onSwitchToFileView).toHaveBeenCalledTimes(1);
  });

  test("hides an inactive view without removing its authoritative content", async () => {
    render(
      <DiffViewerTab
        {...baseProps}
        containerId="container-1"
        isActive={false}
      />,
    );

    await screen.findByTestId("diff-editor");
    const root = screen.getByTestId("diff-editor").parentElement?.parentElement;
    expect(root?.className).toContain("pointer-events-none");
    expect(root?.className).toContain("opacity-0");
    expect(screen.getByTestId("diff-editor").dataset.modified).toBe(
      "container modified",
    );
  });
});

describe("DiffViewerTab path rendering", () => {
  test.each([
    {
      name: "POSIX",
      filePath: "src/components/Button.tsx",
      directory: "src/components",
      filenameSegment: "/Button.tsx",
    },
    {
      name: "Windows",
      filePath: String.raw`src\components\Button.tsx`,
      directory: String.raw`src\components`,
      filenameSegment: String.raw`\Button.tsx`,
    },
    {
      name: "basename-only",
      filePath: "README.md",
      directory: null,
      filenameSegment: "README.md",
    },
  ])(
    "renders and exposes the complete $name path",
    async ({ filePath, directory, filenameSegment }) => {
      render(
        <DiffViewerTab
          {...baseProps}
          filePath={filePath}
          containerId="container-1"
          gitStatus="A"
        />,
      );
      await screen.findByTestId("diff-editor");

      const path = screen.getByTitle(filePath);
      const accessiblePath = path.querySelector(".sr-only");
      const visualPath = path.querySelector('[aria-hidden="true"]');
      expect(path.hasAttribute("aria-label")).toBe(false);
      expect(accessiblePath?.textContent).toBe(filePath);
      expect(visualPath?.children.length).toBe(directory ? 2 : 1);
      if (directory) {
        expect(visualPath?.children[0]?.textContent).toBe(directory);
      }
      expect(visualPath?.lastElementChild?.textContent).toBe(filenameSegment);
    },
  );
});
