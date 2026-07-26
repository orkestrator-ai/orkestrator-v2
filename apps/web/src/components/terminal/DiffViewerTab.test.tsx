import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import * as realMonacoReact from "@monaco-editor/react";
import { useConfigStore } from "@/stores";

const realBackendSnapshot = { ...realBackend };
const realMonacoReactSnapshot = { ...realMonacoReact };
type MockFileContent = Omit<realBackend.FileContent, "path"> & { path?: string };

const readLocalFileMock = mock(async (_worktreePath: string, _filePath: string) => ({
  content: "local modified",
  language: "typescript",
}));
const readLocalFileAtBranchMock = mock(
  async (
    _worktreePath: string,
    _filePath: string,
    _branch: string,
  ): Promise<MockFileContent | null> => ({
    content: "local original",
    language: "typescript",
  }),
);
const readContainerFileMock = mock(async (_containerId: string, _filePath: string) => ({
  content: "container modified",
  language: "javascript",
}));
const readFileAtBranchMock = mock(
  async (
    _containerId: string,
    _filePath: string,
    _branch: string,
  ): Promise<MockFileContent | null> => ({
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

const { DiffViewerTab, formatBaseRef } = await import("./DiffViewerTab");

const originalMatchMedia = window.matchMedia;
const originalConfig = useConfigStore.getState().config;
let viewportWidth = 1024;
const mediaQueryListeners = new Set<() => void>();

function installMatchMedia() {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === "(max-width: 767px)" && viewportWidth <= 767;
    },
    media: query,
    onchange: null,
    addEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (typeof listener === "function") {
        mediaQueryListeners.add(listener as () => void);
      }
    },
    removeEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (typeof listener === "function") {
        mediaQueryListeners.delete(listener as () => void);
      }
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
}

function setViewportWidth(width: number) {
  act(() => {
    viewportWidth = width;
    for (const listener of mediaQueryListeners) listener();
  });
}

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
  viewportWidth = 1024;
  mediaQueryListeners.clear();
  installMatchMedia();
  useConfigStore.setState({ config: originalConfig });
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
  window.matchMedia = originalMatchMedia;
  useConfigStore.setState({ config: originalConfig });
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
    expect(editor.dataset.language).toBe("javascript");
    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.queryByTitle("View file")).toBeNull();
  });

  test("uses prop and plaintext language fallbacks for deleted files", async () => {
    readFileAtBranchMock.mockImplementationOnce(async () => ({
      content: "deleted ruby",
      language: "",
    }));
    const view = render(
      <DiffViewerTab
        {...baseProps}
        containerId="container-1"
        gitStatus="D"
        language="ruby"
      />,
    );
    expect((await screen.findByTestId("diff-editor")).dataset.language).toBe("ruby");

    readFileAtBranchMock.mockImplementationOnce(async () => null);
    view.rerender(
      <DiffViewerTab
        {...baseProps}
        filePath="README"
        containerId="container-1"
        gitStatus="D"
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("diff-editor").dataset.language).toBe("plaintext");
    });
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

  test("renders container and local original-read failures", async () => {
    readFileAtBranchMock.mockRejectedValueOnce(new Error("container base unavailable"));
    const view = render(
      <DiffViewerTab {...baseProps} containerId="container-1" />,
    );
    expect(await screen.findByText("container base unavailable")).toBeTruthy();

    readLocalFileAtBranchMock.mockRejectedValueOnce("local base unavailable");
    view.rerender(
      <DiffViewerTab
        {...baseProps}
        filePath="src/Local.ts"
        containerId={undefined}
        worktreePath="/repo"
        isLocalEnvironment
      />,
    );
    expect(await screen.findByText("local base unavailable")).toBeTruthy();
  });

  test("treats missing container and local base files as empty original content", async () => {
    readFileAtBranchMock.mockImplementationOnce(async () => null);
    const view = render(<DiffViewerTab {...baseProps} containerId="container-1" />);

    let editor = await screen.findByTestId("diff-editor");
    expect(editor.dataset.original).toBe("");
    expect(editor.dataset.modified).toBe("container modified");

    readLocalFileAtBranchMock.mockImplementationOnce(async () => null);
    view.rerender(
      <DiffViewerTab
        {...baseProps}
        filePath="src/LocalMissing.ts"
        containerId={undefined}
        worktreePath="/repo"
        isLocalEnvironment
      />,
    );
    editor = await screen.findByTestId("diff-editor");
    await waitFor(() => expect(editor.dataset.modified).toBe("local modified"));
    expect(editor.dataset.original).toBe("");
  });

  test("ignores a stale original read after the requested file changes", async () => {
    const firstOriginalRead = deferred<realBackend.FileContent | null>();
    readContainerFileMock.mockImplementation(async (_containerId, filePath) => ({
      content: `${filePath} modified`,
      language: filePath.endsWith("latest.ts") ? "typescript" : "javascript",
    }));
    readFileAtBranchMock.mockImplementation(async (_containerId, filePath) => {
      if (filePath === "src/slow.ts") return firstOriginalRead.promise;
      return {
        path: filePath,
        content: "latest original",
        language: "typescript",
      };
    });

    const view = render(
      <DiffViewerTab
        {...baseProps}
        filePath="src/slow.ts"
        containerId="container-1"
      />,
    );
    await waitFor(() => {
      expect(readFileAtBranchMock).toHaveBeenCalledWith(
        "container-1",
        "src/slow.ts",
        "main",
      );
    });

    view.rerender(
      <DiffViewerTab
        {...baseProps}
        filePath="src/latest.ts"
        containerId="container-1"
      />,
    );
    const editor = await screen.findByTestId("diff-editor");
    expect(editor.dataset.original).toBe("latest original");
    expect(editor.dataset.modified).toBe("src/latest.ts modified");
    expect(editor.dataset.language).toBe("typescript");

    await act(async () => {
      firstOriginalRead.resolve({
        path: "src/slow.ts",
        content: "stale original",
        language: "javascript",
      });
      await firstOriginalRead.promise;
    });
    expect(screen.getByTestId("diff-editor").dataset.original).toBe(
      "latest original",
    );
    expect(screen.getByTestId("diff-editor").dataset.language).toBe("typescript");
    expect(screen.queryByText("Failed to load diff")).toBeNull();
  });

  test("ignores a stale original-read rejection after the requested file changes", async () => {
    const firstOriginalRead = deferred<realBackend.FileContent | null>();
    readFileAtBranchMock.mockImplementation(async (_containerId, filePath) => {
      if (filePath === "src/slow-error.ts") return firstOriginalRead.promise;
      return {
        path: filePath,
        content: "latest original",
        language: "typescript",
      };
    });

    const view = render(
      <DiffViewerTab
        {...baseProps}
        filePath="src/slow-error.ts"
        containerId="container-1"
      />,
    );
    await waitFor(() => {
      expect(readFileAtBranchMock).toHaveBeenCalledWith(
        "container-1",
        "src/slow-error.ts",
        "main",
      );
    });

    view.rerender(
      <DiffViewerTab
        {...baseProps}
        filePath="src/latest.ts"
        containerId="container-1"
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("diff-editor").dataset.original).toBe(
        "latest original",
      );
    });

    await act(async () => {
      firstOriginalRead.reject(new Error("stale base failure"));
      try {
        await firstOriginalRead.promise;
      } catch {
        // A cancelled request must not replace the latest successful state.
      }
    });
    expect(screen.queryByText("stale base failure")).toBeNull();
    expect(screen.getByTestId("diff-editor").dataset.original).toBe(
      "latest original",
    );
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

    await act(async () => {
      firstRead.resolve({
        path: "src/slow.ts",
        content: "stale modified",
        language: "javascript",
      });
      await firstRead.promise;
    });
    expect(screen.getByTestId("diff-editor").dataset.modified).toBe(
      "latest modified",
    );
    expect(screen.getByTestId("diff-editor").dataset.language).toBe("typescript");
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

  test("keeps inactive loading, error, and deleted branches hidden", async () => {
    const pendingRead = deferred<realBackend.FileContent>();
    readContainerFileMock.mockImplementationOnce(async () => pendingRead.promise);
    const view = render(
      <DiffViewerTab
        {...baseProps}
        containerId="container-1"
        gitStatus="A"
        isActive={false}
      />,
    );

    const loadingRoot = screen.getByText("Loading diff...").parentElement?.parentElement;
    expect(loadingRoot?.className).toContain("pointer-events-none");
    expect(loadingRoot?.className).toContain("opacity-0");

    await act(async () => {
      pendingRead.reject(new Error("inactive failure"));
      try {
        await pendingRead.promise;
      } catch {
        // The component converts this rejection into its error state.
      }
    });
    const errorRoot = (await screen.findByText("Failed to load diff"))
      .parentElement?.parentElement;
    expect(errorRoot?.className).toContain("pointer-events-none");
    expect(errorRoot?.className).toContain("opacity-0");

    view.rerender(
      <DiffViewerTab
        {...baseProps}
        filePath="src/Deleted.ts"
        containerId="container-1"
        gitStatus="D"
        isActive={false}
      />,
    );
    const deletedEditor = await screen.findByTestId("diff-editor");
    const deletedRoot = deletedEditor.parentElement?.parentElement;
    expect(deletedRoot?.className).toContain("pointer-events-none");
    expect(deletedRoot?.className).toContain("opacity-0");
    expect(deletedEditor.dataset.modified).toBe("");
  });

  test("switches exactly at 767px and restores the remembered desktop mode", async () => {
    setViewportWidth(768);
    render(<DiffViewerTab {...baseProps} containerId="container-1" />);
    await screen.findByTestId("diff-editor");

    fireEvent.click(screen.getByRole("button", { name: "Inline" }));
    expect(screen.getByTestId("diff-editor").dataset.sideBySide).toBe("false");

    setViewportWidth(767);
    expect(screen.queryByRole("button", { name: "Side by side" })).toBeNull();
    expect(screen.getByTestId("diff-editor").dataset.sideBySide).toBe("false");

    setViewportWidth(768);
    expect(
      screen.getByRole("button", { name: "Inline" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("diff-editor").dataset.sideBySide).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    expect(screen.getByTestId("diff-editor").dataset.sideBySide).toBe("true");
    expect(renderedDiffEditorProps?.options).toMatchObject({
      enableSplitViewResizing: true,
      fontSize: 14,
      useInlineViewWhenSpaceIsLimited: false,
    });
  });
});

describe("formatBaseRef", () => {
  test.each([
    ["63d12576e9198f24bc2271a6a8c3702dfb391eae", "63d1257"],
    ["ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD", "ABCDEFA"],
    ["main", "main"],
    ["feature/63d12576", "feature/63d12576"],
    ["63d1257", "63d1257"],
  ])("renders %s as %s", (baseBranch, expected) => {
    expect(formatBaseRef(baseBranch)).toBe(expected);
  });
});

describe("DiffViewerTab on a mobile viewport", () => {
  beforeEach(() => {
    setViewportWidth(390);
  });

  test("forces the inline view and hides the mode toggle", async () => {
    const onSwitchToFileView = mock(() => {});
    render(
      <DiffViewerTab
        {...baseProps}
        containerId="container-1"
        onSwitchToFileView={onSwitchToFileView}
      />,
    );

    expect((await screen.findByTestId("diff-editor")).dataset.sideBySide).toBe("false");
    expect(screen.queryByRole("button", { name: "Side by side" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Inline" })).toBeNull();
    fireEvent.click(screen.getByTitle("View file"));
    expect(onSwitchToFileView).toHaveBeenCalledTimes(1);
  });

  test("trims the editor chrome and wraps long lines", async () => {
    render(<DiffViewerTab {...baseProps} containerId="container-1" />);
    await screen.findByTestId("diff-editor");

    const options = renderedDiffEditorProps?.options ?? {};
    expect(options).toMatchObject({
      readOnly: true,
      renderSideBySide: false,
      fontFamily: `"FiraCode Nerd Font", "Fira Code", monospace`,
      automaticLayout: true,
      ignoreTrimWhitespace: false,
      fontSize: 12,
      enableSplitViewResizing: false,
      compactMode: true,
      wordWrap: "on",
      diffWordWrap: "on",
      minimap: { enabled: false },
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 12,
      lineNumbersMinChars: 2,
      scrollBeyondLastLine: false,
      hideUnchangedRegions: {
        enabled: true,
        contextLineCount: 2,
        minimumLineCount: 4,
        revealLineCount: 10,
      },
      scrollbar: {
        verticalScrollbarSize: 6,
        horizontalScrollbarSize: 6,
        useShadows: false,
      },
      padding: { top: 4, bottom: 24 },
    });
  });

  test("preserves smaller configured fonts and reacts to appearance changes", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          terminalAppearance: {
            ...state.config.global.terminalAppearance,
            fontFamily: "Monaco",
            fontSize: 10,
          },
        },
      },
    }));
    render(<DiffViewerTab {...baseProps} containerId="container-1" />);
    await screen.findByTestId("diff-editor");
    expect(renderedDiffEditorProps?.options).toMatchObject({
      fontFamily: `"Monaco", "Fira Code", monospace`,
      fontSize: 10,
    });

    act(() => {
      useConfigStore.setState((state) => ({
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            terminalAppearance: {
              ...state.config.global.terminalAppearance,
              fontFamily: "Menlo",
              fontSize: 11,
            },
          },
        },
      }));
    });
    await waitFor(() => {
      expect(renderedDiffEditorProps?.options).toMatchObject({
        fontFamily: `"Menlo", "Fira Code", monospace`,
        fontSize: 11,
      });
    });
  });

  test("shows only the basename and the short base ref", async () => {
    render(
      <DiffViewerTab
        {...baseProps}
        baseBranch="63d12576e9198f24bc2271a6a8c3702dfb391eae"
        containerId="container-1"
        gitStatus="A"
      />,
    );
    await screen.findByTestId("diff-editor");

    const path = screen.getByTitle(baseProps.filePath);
    expect(path.querySelector(".sr-only")?.textContent).toBe(baseProps.filePath);
    const visualPath = path.querySelector('[aria-hidden="true"]');
    expect(visualPath?.children.length).toBe(1);
    expect(visualPath?.textContent).toBe("Button.tsx");
    expect(screen.getByText("vs 63d1257")).toBeTruthy();
    expect(
      screen.getByTitle(
        "vs 63d12576e9198f24bc2271a6a8c3702dfb391eae",
      ),
    ).toBeTruthy();
    expect(screen.getByText("New file").className).toContain("sr-only");
  });

  test("lets a long ordinary base ref shrink before the action controls", async () => {
    const baseBranch = "feature/a-realistically-very-long-mobile-branch-name";
    render(
      <DiffViewerTab
        {...baseProps}
        baseBranch={baseBranch}
        containerId="container-1"
        onSwitchToFileView={() => {}}
      />,
    );
    await screen.findByTestId("diff-editor");

    const baseRef = screen.getByTitle(`vs ${baseBranch}`);
    expect(baseRef.className).toContain("max-w-[35vw]");
    expect(baseRef.className).toContain("shrink");
    expect(baseRef.className).toContain("truncate");
    expect(baseRef.textContent).toBe(`vs ${baseBranch}`);
  });

  test.each([
    ["A", "New file", true],
    ["M", "Modified", true],
    ["D", "Deleted", false],
  ] as const)(
    "keeps the %s status accessible and handles file-view availability",
    async (gitStatus, statusText, hasFileView) => {
      render(
        <DiffViewerTab
          {...baseProps}
          containerId="container-1"
          gitStatus={gitStatus}
          onSwitchToFileView={() => {}}
        />,
      );
      await screen.findByTestId("diff-editor");

      expect(screen.getByText(statusText).className).toContain("sr-only");
      expect(Boolean(screen.queryByTitle("View file"))).toBe(hasFileView);
    },
  );
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
