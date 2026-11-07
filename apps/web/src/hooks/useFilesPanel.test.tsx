import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { environmentStore, filesPanelStore, projectStore, uiStore } from "@/stores";
import type { Environment, Project } from "@/types";
import * as realBackend from "@/lib/backend";
import { mockToastError, mockToastSuccess } from "../../../../tests/mocks/sonner";
import type { ChangesRefreshResult } from "@orkestrator/protocol/change-resources";
import { changeProjectionStore } from "@/stores/changeProjectionStore";
import { worktreeSnapshotStore } from "@/stores/worktreeSnapshotStore";
import {
  environmentProjectionFixture,
  resetChangeProjectionStore,
} from "@/components/files-panel/change-projection-test-fixture";
import { filesPanelTestState, setFilesPanelTestState } from "@/test/files-panel-state";
import { appCommandStore } from "@/test/app-command-store";

const realBackendSnapshot = { ...realBackend };
const copyExternalFileMock = mock(
  async (_environmentId: string, directory: string, fileName: string, _base64Data: string) =>
    directory === "." ? fileName : `${directory}/${fileName}`,
);
const getLocalFileTreeSnapshotMock = mock(async (_worktreePath: string) => ({
  unchanged: false,
  digest: "tree",
  value: [],
}));
const getLocalFileSubtreeMock = mock(
  async (_worktreePath: string, directory: string): Promise<realBackend.FileSubtree> => ({
    children: [
      {
        name: "SKILL.md",
        path: `${directory}/SKILL.md`,
        isDirectory: false,
        extension: ".md",
      },
    ],
    truncated: false,
  }),
);
const getLocalGitStatusSnapshotMock = mock(async () => ({
  unchanged: false,
  digest: "changes",
  value: [],
}));

const projectHome = {
  id: "project-home-1",
  projectId: "project-1",
  projectHome: true,
  environmentType: "local",
  worktreePath: "/checkout",
  status: "running",
  branch: "main",
} as Environment;
const ensureProjectHomeEnvironmentMock = mock(async (_projectId: string) => projectHome);
const refreshChangesMock = mock(async (_resourceKey: string): Promise<ChangesRefreshResult> => ({
  kind: "pending",
  token: "refresh-1",
  requiredObservationEpoch: 1,
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  ensureProjectHomeEnvironment: ensureProjectHomeEnvironmentMock,
  copyExternalFile: copyExternalFileMock,
  getLocalFileTreeSnapshot: getLocalFileTreeSnapshotMock,
  getLocalFileSubtreeSnapshot: async (worktreePath: string, directory: string) => ({
    unchanged: false,
    digest: "",
    value: await getLocalFileSubtreeMock(worktreePath, directory),
  }),
  getLocalGitStatusSnapshot: getLocalGitStatusSnapshotMock,
  refreshChanges: refreshChangesMock,
}));

const { MAX_EXTERNAL_FILE_DROP_BYTES, MAX_EXTERNAL_FILE_DROP_COUNT, useFilesPanel } =
  await import("./useFilesPanel");
const { resetReadCoordinatorForTests } = await import("@/lib/read-coordinator");
const { installFakeReadCoordinator } = await import("@/lib/testing/read-coordinator");

function droppedFile(name: string, bytes: number[]): File {
  const contents = Uint8Array.from(bytes);
  return {
    name,
    size: contents.byteLength,
    arrayBuffer: async () => contents.buffer,
  } as File;
}

beforeEach(() => {
  copyExternalFileMock.mockReset();
  copyExternalFileMock.mockImplementation(async (_environmentId, directory, fileName) =>
    directory === "." ? fileName : `${directory}/${fileName}`,
  );
  getLocalFileTreeSnapshotMock.mockClear();
  getLocalGitStatusSnapshotMock.mockClear();
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
  ensureProjectHomeEnvironmentMock.mockClear();
  refreshChangesMock.mockClear();
  resetChangeProjectionStore();
  appCommandStore(projectStore).setState({ projects: [] });
  appCommandStore(uiStore).setState({
    selectedEnvironmentId: "environment-1",
    selectedProjectId: null,
  });
  appCommandStore(environmentStore).setState({
    environments: [
      {
        id: "environment-1",
        projectId: "project-1",
        environmentType: "local",
        worktreePath: "/worktree",
        status: "running",
      } as Environment,
    ],
  });
  setFilesPanelTestState({
    isOpen: false,
    activeTab: "all-files",
    changes: [],
    fileTree: [],
  });
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  getLocalGitStatusSnapshotMock.mockImplementation(async () => ({
    unchanged: false,
    digest: "changes",
    value: [],
  }));
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("useFilesPanel external file copies", () => {
  test("encodes dropped bytes, targets the selected environment, and refreshes the tree", async () => {
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());
    const file = droppedFile("image.bin", [0, 1, 127, 255]);

    await act(async () => {
      await result.current.copyExternalFiles([file], "assets");
    });

    expect(copyExternalFileMock).toHaveBeenCalledTimes(1);
    expect(copyExternalFileMock).toHaveBeenCalledWith(
      "environment-1",
      "assets",
      "image.bin",
      "AAF//w==",
    );
    expect(getLocalFileTreeSnapshotMock).toHaveBeenCalled();
    expect(getLocalGitStatusSnapshotMock).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith("File copied", {
      description: "assets/image.bin",
    });
    expect(result.current.fileActionPending).toBeNull();
  });

  test("rejects oversized and excessive drops before reading or sending files", async () => {
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());
    const oversized = droppedFile("large.bin", []);
    Object.defineProperty(oversized, "size", { value: MAX_EXTERNAL_FILE_DROP_BYTES + 1 });

    await expect(result.current.copyExternalFiles([oversized], ".")).rejects.toThrow(
      "exceeds the 8 MB file limit",
    );
    await expect(
      result.current.copyExternalFiles(
        Array.from({ length: MAX_EXTERNAL_FILE_DROP_COUNT + 1 }, (_, index) =>
          droppedFile(`${index}.txt`, [index]),
        ),
        ".",
      ),
    ).rejects.toThrow(`Drop up to ${MAX_EXTERNAL_FILE_DROP_COUNT} files at a time`);
    expect(copyExternalFileMock).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledTimes(2);
  });

  test("copies zero-byte files as regular files", async () => {
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());

    await act(async () => {
      await result.current.copyExternalFiles([droppedFile("empty.txt", [])], ".");
    });

    expect(copyExternalFileMock).toHaveBeenCalledWith("environment-1", ".", "empty.txt", "");
    expect(mockToastSuccess).toHaveBeenCalledWith("File copied", {
      description: "empty.txt",
    });
  });

  test("refreshes and reports the remaining files after a partial copy failure", async () => {
    copyExternalFileMock.mockImplementation(async (_environmentId, directory, fileName) => {
      if (fileName === "blocked.txt") throw new Error("already exists");
      return `${directory}/${fileName}`;
    });
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());

    let failure: unknown;
    await act(async () => {
      try {
        await result.current.copyExternalFiles(
          [droppedFile("copied.txt", [1]), droppedFile("blocked.txt", [2])],
          "assets",
        );
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      name: "FileBatchActionError",
      completedPaths: ["assets/copied.txt"],
      remainingPaths: ["blocked.txt"],
    });
    expect(getLocalFileTreeSnapshotMock).toHaveBeenCalled();
    expect(getLocalGitStatusSnapshotMock).toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Failed to copy files", {
      description: "1 of 2 files were changed before the failure: already exists",
    });
    expect(result.current.fileActionPending).toBeNull();
  });

  test("does not refresh when every copied file fails", async () => {
    copyExternalFileMock.mockRejectedValue(new Error("copy failed"));
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());

    let failure: unknown;
    await act(async () => {
      try {
        await result.current.copyExternalFiles(
          [droppedFile("first.txt", [1]), droppedFile("second.txt", [2])],
          ".",
        );
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toMatchObject({
      name: "FileBatchActionError",
      completedPaths: [],
      remainingPaths: ["first.txt", "second.txt"],
    });
    expect(getLocalFileTreeSnapshotMock).not.toHaveBeenCalled();
    expect(getLocalGitStatusSnapshotMock).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Failed to copy files", {
      description: "copy failed",
    });
  });

  test("toasts when the selected environment is unavailable", async () => {
    appCommandStore(uiStore).setState({ selectedEnvironmentId: null });
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());

    await expect(
      result.current.copyExternalFiles([droppedFile("notes.txt", [1])], "."),
    ).rejects.toThrow("The selected environment is not available");
    expect(mockToastError).toHaveBeenCalledWith("Failed to copy file", {
      description: "The selected environment is not available",
    });
    expect(copyExternalFileMock).not.toHaveBeenCalled();
  });
});

describe("useFilesPanel on the project root", () => {
  beforeEach(() => {
    appCommandStore(projectStore).setState({
      projects: [{ id: "project-1", name: "Project", localPath: "/checkout" } as Project],
    });
    appCommandStore(uiStore).setState({
      selectedEnvironmentId: null,
      selectedProjectId: "project-1",
    });
    appCommandStore(environmentStore).setState({ environments: [] });
  });

  test("reads the project's own checkout when no environment is selected", async () => {
    setFilesPanelTestState({ isOpen: true, activeTab: "all-files" });
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isAvailable).toBe(true);
    expect(result.current.worktreePath).toBe("/checkout");
    expect(result.current.projectScopeProjectId).toBe("project-1");
    const firstPath = (calls: unknown[][]) => calls[0]?.[0];
    expect(firstPath(getLocalFileTreeSnapshotMock.mock.calls)).toBe("/checkout");
    expect(firstPath(getLocalGitStatusSnapshotMock.mock.calls)).toBe("/checkout");
    expect(ensureProjectHomeEnvironmentMock).not.toHaveBeenCalled();
  });

  test("drops land in the root checkout through the project home and refresh changes", async () => {
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());

    await act(async () => {
      await result.current.copyExternalFiles([droppedFile("notes.txt", [1])], ".");
    });

    expect(ensureProjectHomeEnvironmentMock).toHaveBeenCalledWith("project-1");
    expect(copyExternalFileMock).toHaveBeenCalledWith(
      "project-home-1",
      ".",
      "notes.txt",
      expect.any(String),
    );
    // The home is now visible to the sidebar and the rest of the renderer.
    expect(
      appCommandStore(environmentStore)
        .getState()
        .environments.map((e) => e.id),
    ).toEqual(["project-home-1"]);
    expect(getLocalGitStatusSnapshotMock).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith("File copied", { description: "notes.txt" });
  });

  test("an existing project home is reconciled before mutations", async () => {
    appCommandStore(environmentStore).setState({ environments: [projectHome] });
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());

    await act(async () => {
      await result.current.copyExternalFiles([droppedFile("a.txt", [1])], "docs");
    });

    expect(ensureProjectHomeEnvironmentMock).toHaveBeenCalledWith("project-1");
    expect(copyExternalFileMock).toHaveBeenCalledWith(
      "project-home-1",
      "docs",
      "a.txt",
      expect.any(String),
    );
  });

  test.each(["deletionError", "cleanupAfterMergeError"] as const)(
    "a failed %s home cannot admit project file actions",
    async (field) => {
      appCommandStore(environmentStore).setState({
        environments: [
          {
            ...projectHome,
            deletionRequestedAt: "2026-11-05T12:00:00Z",
            [field]: "failed",
            agentActivityState: "waiting",
          },
        ],
      });
      const { result } = renderHookInAppCommandScope(() => useFilesPanel());
      let failure: unknown;
      await act(async () => {
        await result.current
          .copyExternalFiles([droppedFile("a.txt", [1])], ".")
          .catch((error: unknown) => {
            failure = error;
          });
      });
      expect(failure).toMatchObject({ message: "The project home is being deleted" });
      expect(ensureProjectHomeEnvironmentMock).not.toHaveBeenCalled();
      expect(copyExternalFileMock).not.toHaveBeenCalled();
    },
  );

  test("reports a project home that cannot be created", async () => {
    ensureProjectHomeEnvironmentMock.mockImplementationOnce(async () => {
      throw new Error("The configured local checkout is unavailable");
    });
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());

    let failure: unknown;
    await act(async () => {
      await result.current
        .copyExternalFiles([droppedFile("a.txt", [1])], ".")
        .catch((error: unknown) => {
          failure = error;
        });
    });
    expect(failure).toMatchObject({ message: "The configured local checkout is unavailable" });
    expect(copyExternalFileMock).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Failed to copy file", {
      description: "The configured local checkout is unavailable",
    });
  });

  test("a project without a checkout has nothing to show", () => {
    appCommandStore(projectStore).setState({
      projects: [{ id: "project-1", name: "Project", localPath: null } as Project],
    });
    const { result } = renderHookInAppCommandScope(() => useFilesPanel());
    expect(result.current.isAvailable).toBe(false);
  });

  test("opening from the project board starts on all files", () => {
    setFilesPanelTestState({ isOpen: false, activeTab: "changes" });
    appCommandStore(filesPanelStore).getState().openPanelOnAllFiles();
    expect(filesPanelTestState()).toMatchObject({ isOpen: true, activeTab: "all-files" });
  });
});

describe("useFilesPanel truncated folders", () => {
  const boundedTree: realBackend.FileNode[] = [
    {
      name: "skills",
      path: "skills",
      isDirectory: true,
      children: [
        {
          name: "release",
          path: "skills/release",
          isDirectory: true,
          children: [],
          truncated: true,
        },
      ],
    },
  ];

  beforeEach(() => {
    installFakeReadCoordinator();
    getLocalFileSubtreeMock.mockClear();
    getLocalFileTreeSnapshotMock.mockImplementation(async () => ({
      unchanged: false,
      digest: "bounded-tree",
      value: boundedTree as never[],
    }));
    setFilesPanelTestState({
      isOpen: true,
      activeTab: "all-files",
      expandedFolders: ["skills", "skills/release"],
      fileSubtreeKey: "",
      fileSubtrees: {},
      loadingFolders: [],
      failedFolders: [],
    });
  });

  afterEach(() => {
    getLocalFileTreeSnapshotMock.mockImplementation(async () => ({
      unchanged: false,
      digest: "tree",
      value: [],
    }));
  });

  async function settle() {
    for (let tick = 0; tick < 5; tick += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  test("reads an expanded truncated folder once and again after it is collapsed", async () => {
    renderHookInAppCommandScope(() => useFilesPanel());
    await settle();

    expect(getLocalFileSubtreeMock.mock.calls).toEqual([["/worktree", "skills/release"]]);
    expect(appCommandStore(filesPanelStore).getState().fileSubtrees).toEqual({
      "skills/release": {
        children: [
          {
            name: "SKILL.md",
            path: "skills/release/SKILL.md",
            isDirectory: false,
            extension: ".md",
          },
        ],
        truncated: false,
      },
    });
    expect(appCommandStore(filesPanelStore).getState().loadingFolders).toEqual([]);

    act(() =>
      appCommandStore(filesPanelStore).getState().setFolderExpanded("skills/release", false),
    );
    expect(appCommandStore(filesPanelStore).getState().fileSubtrees).toEqual({});
    await settle();
    expect(getLocalFileSubtreeMock).toHaveBeenCalledTimes(1);

    act(() =>
      appCommandStore(filesPanelStore).getState().setFolderExpanded("skills/release", true),
    );
    await settle();
    expect(getLocalFileSubtreeMock).toHaveBeenCalledTimes(2);
  });

  test("a failed read is not retried until the folder is expanded again", async () => {
    getLocalFileSubtreeMock.mockImplementationOnce(async () => {
      throw new Error("unreadable");
    });
    const logs = captureLogs();
    try {
      renderHookInAppCommandScope(() => useFilesPanel());
      await settle();
      expect(logs.records()).toContainEqual(
        expect.objectContaining({ level: "error", area: "web.files", event: "folder.load-failed" }),
      );
      expect(logs.lines.join("\n")).not.toContain("skills/release");
    } finally {
      logs.restore();
    }

    expect(getLocalFileSubtreeMock).toHaveBeenCalledTimes(1);
    expect(appCommandStore(filesPanelStore).getState().failedFolders).toEqual(["skills/release"]);
    expect(appCommandStore(filesPanelStore).getState().fileSubtrees).toEqual({});

    act(() =>
      appCommandStore(filesPanelStore).getState().setFolderExpanded("skills/release", false),
    );
    act(() =>
      appCommandStore(filesPanelStore).getState().setFolderExpanded("skills/release", true),
    );
    await settle();
    expect(getLocalFileSubtreeMock).toHaveBeenCalledTimes(2);
    expect(appCommandStore(filesPanelStore).getState().failedFolders).toEqual([]);
    expect(Object.keys(appCommandStore(filesPanelStore).getState().fileSubtrees)).toEqual([
      "skills/release",
    ]);
  });

  test("silent polling refreshes loaded contents with an unchanged bounded-tree digest", async () => {
    const { clock } = installFakeReadCoordinator();
    renderHookInAppCommandScope(() => useFilesPanel());
    await settle();
    const originalTree = appCommandStore(filesPanelStore).getState().fileTree;
    getLocalFileSubtreeMock.mockResolvedValueOnce({
      children: [{ name: "new.txt", path: "skills/release/new.txt", isDirectory: false }],
      truncated: false,
    });
    await act(() => clock.advance(5_000));
    await settle();
    expect(appCommandStore(filesPanelStore).getState().fileTree).toBe(originalTree);
    expect(getLocalFileSubtreeMock).toHaveBeenCalledTimes(2);
    expect(
      appCommandStore(filesPanelStore).getState().fileSubtrees["skills/release"]?.children[0]?.name,
    ).toBe("new.txt");
  });

  for (const action of ["refresh", "copy"] as const) {
    test(`${action} awaits a post-action read when the initial subtree request is pending`, async () => {
      let resolveOld!: (value: realBackend.FileSubtree) => void;
      let resolveNew!: (value: realBackend.FileSubtree) => void;
      getLocalFileSubtreeMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      );
      getLocalFileSubtreeMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve;
          }),
      );
      const { result } = renderHookInAppCommandScope(() => useFilesPanel());
      await settle();
      let complete = false;
      let operation!: Promise<void>;
      await act(async () => {
        operation = (
          action === "refresh"
            ? result.current.refresh()
            : result.current.copyExternalFiles([droppedFile("new.txt", [1])], "skills/release")
        ).then(() => {
          complete = true;
        });
        await Promise.resolve();
      });
      await settle();
      expect(complete).toBe(false);
      expect(getLocalFileSubtreeMock).toHaveBeenCalledTimes(1);
      await act(async () => resolveOld({ children: [], truncated: false }));
      await settle();
      expect(getLocalFileSubtreeMock).toHaveBeenCalledTimes(2);
      expect(complete).toBe(false);
      await act(async () => {
        resolveNew({
          children: [{ name: "new.txt", path: "skills/release/new.txt", isDirectory: false }],
          truncated: false,
        });
        await operation;
      });
      expect(complete).toBe(true);
      expect(
        appCommandStore(filesPanelStore).getState().fileSubtrees["skills/release"]?.children[0]
          ?.name,
      ).toBe("new.txt");
    });
  }

  test("a changed bounded tree reloads existing subtrees and reopening the view reconciles them", async () => {
    const { clock } = installFakeReadCoordinator();
    renderHookInAppCommandScope(() => useFilesPanel());
    await settle();
    getLocalFileTreeSnapshotMock.mockResolvedValueOnce({
      unchanged: false,
      digest: "changed",
      value: [...boundedTree] as never[],
    });
    await act(() => clock.advance(5_000));
    await settle();
    const reads = getLocalFileSubtreeMock.mock.calls.length;
    expect(reads).toBeGreaterThan(1);
    act(() => appCommandStore(filesPanelStore).getState().setActiveTab("changes"));
    await settle();
    act(() => appCommandStore(filesPanelStore).getState().setActiveTab("all-files"));
    await settle();
    expect(getLocalFileSubtreeMock.mock.calls.length).toBeGreaterThan(reads);
  });

  test("collapsing a parent invalidates descendant results and reopening fetches them again", async () => {
    renderHookInAppCommandScope(() => useFilesPanel());
    await settle();
    act(() => appCommandStore(filesPanelStore).getState().setFolderExpanded("skills", false));
    expect(appCommandStore(filesPanelStore).getState().fileSubtrees).toEqual({});
    act(() => appCommandStore(filesPanelStore).getState().setFolderExpanded("skills", true));
    await settle();
    expect(getLocalFileSubtreeMock).toHaveBeenCalledTimes(2);
  });

  test("a closed panel reads no folders", async () => {
    setFilesPanelTestState({ isOpen: false });
    renderHookInAppCommandScope(() => useFilesPanel());
    await settle();
    expect(getLocalFileSubtreeMock).not.toHaveBeenCalled();
  });
});

describe("useFilesPanel coordinated auto-refresh", () => {
  const snapshotCalls = () => ({
    tree: getLocalFileTreeSnapshotMock.mock.calls.length,
    changes: getLocalGitStatusSnapshotMock.mock.calls.length,
  });

  async function openPanel(activeTab: "all-files" | "changes" = "all-files") {
    setFilesPanelTestState({ isOpen: true, activeTab });
    const view = renderHookInAppCommandScope(() => useFilesPanel());
    // The open read stays a direct, immediate load.
    await act(async () => {
      await Promise.resolve();
    });
    return view;
  }

  test("keeps the 5 s cadence while visible, pauses while hidden and reconciles once", async () => {
    const { clock, document } = installFakeReadCoordinator();
    await openPanel();
    expect(snapshotCalls()).toEqual({ tree: 1, changes: 1 });

    await act(() => clock.advance(4_999));
    expect(snapshotCalls()).toEqual({ tree: 1, changes: 1 });
    await act(() => clock.advance(1));
    expect(snapshotCalls()).toEqual({ tree: 2, changes: 2 });

    document.setVisibility("hidden");
    await act(() => clock.advance(60_000));
    expect(snapshotCalls()).toEqual({ tree: 2, changes: 2 });
    expect(clock.pending).toBe(0);

    document.setVisibility("visible");
    // Standard priority: 50 ms coalescing plus the start of its spread window.
    await act(() => clock.advance(149));
    expect(snapshotCalls()).toEqual({ tree: 2, changes: 2 });
    await act(() => clock.advance(1));
    expect(snapshotCalls()).toEqual({ tree: 3, changes: 3 });
    await act(() => clock.advance(4_999));
    expect(snapshotCalls()).toEqual({ tree: 3, changes: 3 });
    await act(() => clock.advance(1));
    expect(snapshotCalls()).toEqual({ tree: 4, changes: 4 });
  });

  test("with data saving on, an unwatched target's poll backs off to 10 s", async () => {
    const { clock, coordinator } = installFakeReadCoordinator();
    coordinator.setDataSaving(true);
    await openPanel();
    expect(snapshotCalls()).toEqual({ tree: 1, changes: 1 });
    await act(() => clock.advance(5_000));
    expect(snapshotCalls()).toEqual({ tree: 2, changes: 2 });
    await act(() => clock.advance(9_999));
    expect(snapshotCalls()).toEqual({ tree: 2, changes: 2 });
    await act(() => clock.advance(1));
    expect(snapshotCalls()).toEqual({ tree: 3, changes: 3 });
    await act(() => clock.advance(10_000));
    expect(snapshotCalls()).toEqual({ tree: 4, changes: 4 });
  });

  test("with data saving on, a watched worktree's poll backs off to 30 s and a refresh restores it", async () => {
    const { clock, coordinator } = installFakeReadCoordinator();
    coordinator.setDataSaving(true);
    appCommandStore(worktreeSnapshotStore).setState({
      entries: new Map([
        [
          "environment-1",
          {
            environmentId: "environment-1",
            targetGeneration: 1,
            comparisonRef: "unrelated-baseline",
            fileListRevision: 1,
            treeRevision: 1,
            freshness: "current",
            watched: true,
          },
        ],
      ]),
    });
    try {
      const { result } = await openPanel();
      // 5 s, then the 10, 15 and 30 s steps.
      await act(() => clock.advance(60_000));
      expect(snapshotCalls()).toEqual({ tree: 5, changes: 5 });
      await act(async () => {
        await result.current.refresh();
        await clock.advance(0);
      });
      const afterRefresh = snapshotCalls();
      await act(() => clock.advance(5_000));
      expect(snapshotCalls().tree).toBe(afterRefresh.tree + 1);
    } finally {
      act(() => appCommandStore(worktreeSnapshotStore).setState({ entries: new Map() }));
    }
  });

  test("a mutation restores backed-off polling without explicit refresh", async () => {
    const { clock, coordinator } = installFakeReadCoordinator();
    coordinator.setDataSaving(true);
    const { result } = await openPanel();
    await act(() => clock.advance(15_000));
    await act(async () => {
      await result.current.copyExternalFiles([droppedFile("new.txt", [1])], ".");
    });
    const afterMutation = snapshotCalls();
    await act(() => clock.advance(4_999));
    expect(snapshotCalls()).toEqual(afterMutation);
    await act(() => clock.advance(1));
    expect(snapshotCalls().tree).toBe(afterMutation.tree + 1);
  });

  test("watch coverage changes the backoff while the panel stays open", async () => {
    const { clock, coordinator } = installFakeReadCoordinator();
    coordinator.setDataSaving(true);
    await openPanel();
    await act(() => clock.advance(15_000));
    const setWatched = (watched: boolean) =>
      act(() =>
        appCommandStore(worktreeSnapshotStore).setState({
          entries: new Map([
            [
              "environment-1",
              {
                environmentId: "environment-1",
                targetGeneration: 1,
                comparisonRef: "unrelated-baseline",
                fileListRevision: 1,
                treeRevision: 1,
                freshness: "current",
                watched,
              },
            ],
          ]),
        }),
      );
    try {
      setWatched(true);
      await act(() => clock.advance(60_000));
      const filesEntry = () =>
        coordinator.getDiagnostics().entries.find((entry) => entry.id.includes("files-panel"))!;
      expect(filesEntry().cadenceMs).toBe(30_000);
      await act(() => clock.advance(filesEntry().timerDueAt! - clock.time));
      const watchedReads = snapshotCalls();
      await act(() => clock.advance(29_999));
      expect(snapshotCalls()).toEqual(watchedReads);
      await act(() => clock.advance(1));
      expect(snapshotCalls().tree).toBe(watchedReads.tree + 1);
      setWatched(false);
      const unwatchedReads = snapshotCalls();
      await act(() => clock.advance(10_000));
      expect(snapshotCalls().tree).toBe(unwatchedReads.tree + 1);
    } finally {
      act(() => appCommandStore(worktreeSnapshotStore).setState({ entries: new Map() }));
    }
  });

  test("a closed panel keeps no periodic demand", async () => {
    const { clock } = installFakeReadCoordinator();
    setFilesPanelTestState({ isOpen: false });
    renderHookInAppCommandScope(() => useFilesPanel());
    await act(() => clock.advance(30_000));
    expect(snapshotCalls()).toEqual({ tree: 0, changes: 0 });
    expect(clock.pending).toBe(0);
  });

  test("manual refresh reads again instead of joining an older snapshot", async () => {
    const { clock } = installFakeReadCoordinator();
    const { result } = await openPanel("changes");
    expect(snapshotCalls().changes).toBe(1);

    const releases: Array<() => void> = [];
    getLocalGitStatusSnapshotMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ unchanged: false, digest: "changes-2", value: [] }));
        }),
    );
    await act(() => clock.advance(5_000));
    expect(snapshotCalls().changes).toBe(2);

    let refreshed = false;
    await act(async () => {
      void result.current.refresh().then(() => {
        refreshed = true;
      });
      await Promise.resolve();
    });
    expect(snapshotCalls().changes).toBe(2);

    await act(async () => {
      releases.shift()!();
      await clock.advance(0);
    });
    expect(snapshotCalls().changes).toBe(3);
    expect(refreshed).toBe(false);

    await act(async () => {
      releases.shift()!();
      await clock.advance(0);
    });
    expect(refreshed).toBe(true);
  });

  test("an event-driven change projection owns the Changes tab: the list is not polled", async () => {
    const { clock } = installFakeReadCoordinator();
    appCommandStore(changeProjectionStore)
      .getState()
      .applyProjection(environmentProjectionFixture("environment-1"));
    const { result } = await openPanel("changes");
    expect(result.current.changeEnvironmentId).toBe("environment-1");

    await act(() => clock.advance(30_000));
    // Neither the open nor the old 5 s cadence reads the legacy change list.
    expect(snapshotCalls()).toEqual({ tree: 0, changes: 0 });
    expect(clock.pending).toBe(0);

    // An explicit refresh asks the backend for a fenced pass instead, and a
    // settled projection replaces the held one.
    refreshChangesMock.mockImplementationOnce(async () => ({
      kind: "settled",
      token: "refresh-2",
      requiredObservationEpoch: 2,
      projection: environmentProjectionFixture("environment-1", {
        revision: 2,
        measurementId: "m-2",
      }),
    }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(refreshChangesMock).toHaveBeenCalledWith(
      "environment-net/environment/environment-1/live",
    );
    expect(snapshotCalls().changes).toBe(0);
    expect(
      appCommandStore(changeProjectionStore)
        .getState()
        .projections.get("environment-net/environment/environment-1/live")?.measurementId,
    ).toBe("m-2");
  });

  test("the file tree keeps its cadence while a change projection exists", async () => {
    const { clock } = installFakeReadCoordinator();
    appCommandStore(changeProjectionStore)
      .getState()
      .applyProjection(environmentProjectionFixture("environment-1"));
    await openPanel("all-files");
    expect(snapshotCalls()).toEqual({ tree: 1, changes: 1 });
    await act(() => clock.advance(5_000));
    expect(snapshotCalls()).toEqual({ tree: 2, changes: 2 });
  });

  test("an older backend without a projection keeps polling the change list", async () => {
    const { clock } = installFakeReadCoordinator();
    await openPanel("changes");
    expect(snapshotCalls().changes).toBe(1);
    await act(() => clock.advance(5_000));
    expect(snapshotCalls().changes).toBe(2);
    expect(refreshChangesMock).not.toHaveBeenCalled();
  });
});

test("the board follows a changed checkout and stops reading or mutating when it is cleared", async () => {
  appCommandStore(projectStore).setState({
    projects: [{ id: "project-1", localPath: "/checkout" } as Project],
  });
  appCommandStore(uiStore).setState({
    selectedProjectId: "project-1",
    selectedEnvironmentId: null,
  });
  appCommandStore(environmentStore).setState({ environments: [projectHome] });
  setFilesPanelTestState({ isOpen: true });
  const { result } = renderHookInAppCommandScope(() => useFilesPanel());
  await act(async () => {
    await Promise.resolve();
  });
  ensureProjectHomeEnvironmentMock.mockImplementationOnce(async () => ({
    ...projectHome,
    worktreePath: "/checkout-B",
  }));
  await act(async () => {
    appCommandStore(projectStore).setState({
      projects: [{ id: "project-1", localPath: "/checkout-B" } as Project],
    });
  });
  expect(result.current.worktreePath).toBe("/checkout-B");
  await act(async () => {
    await result.current.copyExternalFiles([droppedFile("B.txt", [1])], ".");
  });
  expect(ensureProjectHomeEnvironmentMock).toHaveBeenCalledWith("project-1");
  expect(appCommandStore(environmentStore).getState().environments[0]?.worktreePath).toBe(
    "/checkout-B",
  );
  expect(getLocalFileTreeSnapshotMock.mock.calls.at(-1)?.[0]).toBe("/checkout-B");
  const staleAction = result.current.copyExternalFiles;
  await act(async () => {
    appCommandStore(projectStore).setState({
      projects: [{ id: "project-1", localPath: null } as Project],
    });
  });
  expect(result.current.isAvailable).toBe(false);
  expect(result.current.worktreePath).toBeNull();
  const reads = getLocalFileTreeSnapshotMock.mock.calls.length;
  await act(async () => {
    await result.current.refresh();
  });
  expect(getLocalFileTreeSnapshotMock.mock.calls).toHaveLength(reads);
  await expect(staleAction([droppedFile("A.txt", [1])], ".")).rejects.toThrow("checkout changed");
  expect(copyExternalFileMock).toHaveBeenCalledTimes(1);
});
