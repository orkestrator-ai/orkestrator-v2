import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { fileDirtyStore, fileSaveConflict } from "@/stores/fileDirtyStore";
import * as realBackend from "@/lib/backend";
import {
  FILE_WRITE_CONFLICT_MESSAGE,
  fileContentSha256,
} from "@orkestrator/protocol/file-write-precondition";
import { mockToastError, mockToastSuccess } from "../../../../tests/mocks/sonner";
import { appCommandStore } from "@/test/app-command-store";

const realBackendSnapshot = { ...realBackend };
const writeContainerFileMock = mock(
  async (_containerId: string, _filePath: string, _base64Data: string, _expected?: unknown) =>
    "/workspace/file.md",
);
const writeLocalFileMock = mock(
  async (_worktreePath: string, _filePath: string, _base64Data: string, _expected?: unknown) =>
    "/repo/file.md",
);

const readLocalFileMock = mock(async (_worktreePath: string, _filePath: string) => ({
  path: "notes.md",
  content: "agent's version",
  language: "markdown",
}));
const readContainerFileMock = mock(async (_containerId: string, _filePath: string) => ({
  path: "README.md",
  content: "agent's version",
  language: "markdown",
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  writeContainerFile: writeContainerFileMock,
  writeLocalFile: writeLocalFileMock,
  readLocalFile: readLocalFileMock,
  readContainerFile: readContainerFileMock,
}));

const { useFileSave } = await import("./useFileSave");

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

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
  appCommandStore(fileDirtyStore).setState({ dirtyFiles: new Map() });
  writeContainerFileMock.mockClear();
  writeLocalFileMock.mockClear();
  readLocalFileMock.mockClear();
  readContainerFileMock.mockClear();
  readLocalFileMock.mockImplementation(async () => ({
    path: "notes.md",
    content: "agent's version",
    language: "markdown",
  }));
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("useFileSave", () => {
  test("writes current container content and marks it saved", async () => {
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "updated");
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "README.md",
        containerId: "container-1",
        isLocalEnvironment: false,
      }),
    );

    let saved = false;
    await act(async () => {
      saved = await result.current.saveFile();
    });

    expect(saved).toBe(true);
    expect(writeContainerFileMock).toHaveBeenCalledTimes(1);
    const call = writeContainerFileMock.mock.calls[0];
    expect(call?.[0]).toBe("container-1");
    expect(call?.[1]).toBe("README.md");
    expect(decodeBase64Utf8(call?.[2] ?? "")).toBe("updated");
    // The write is conditional on the file still holding what was loaded.
    expect(call?.[3]).toEqual({ sha256: fileContentSha256("original") });
    expect(appCommandStore(fileDirtyStore).getState().isDirty("tab")).toBe(false);
  });

  test("a reload while the buffer is edited does not move what the save checks", async () => {
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "mine");
    // An agent changed the file; the tab remounted and read it back.
    appCommandStore(fileDirtyStore).getState().observeDiskContent("tab", "agent's version");

    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "README.md",
        containerId: "container-1",
        isLocalEnvironment: false,
      }),
    );
    await act(async () => {
      await result.current.saveFile();
    });

    expect(writeContainerFileMock.mock.calls[0]?.[3]).toEqual({
      sha256: fileContentSha256("original"),
    });
  });

  test("a file changed on disk keeps both versions and offers compare or use theirs", async () => {
    writeLocalFileMock.mockRejectedValueOnce(new Error(FILE_WRITE_CONFLICT_MESSAGE));
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "mine");
    const reload = mock(() => undefined);
    const compare = mock(() => undefined);
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "notes.md",
        worktreePath: "/repo",
        isLocalEnvironment: true,
        onReloadFromDisk: reload,
        onCompare: compare,
      }),
    );

    await act(async () => {
      await expect(result.current.saveFile()).resolves.toBe(false);
    });
    // The buffer is untouched; the newer version was read back beside it.
    const entry = appCommandStore(fileDirtyStore).getState().dirtyFiles.get("tab");
    expect(entry).toEqual({
      content: "mine",
      originalContent: "agent's version",
      baseContent: "original",
    });
    expect(fileSaveConflict(entry)).toEqual({
      kind: "changed",
      disk: "agent's version",
      mine: "mine",
    });
    expect(writeLocalFileMock).toHaveBeenCalledTimes(1);
    const [title, options] = mockToastError.mock.calls.at(-1)! as [
      string,
      {
        action: { label: string; onClick: () => void };
        cancel: { label: string; onClick: () => void };
      },
    ];
    expect(title).toBe("File changed on disk");
    expect(options.action.label).toBe("Compare");
    options.action.onClick();
    expect(compare).toHaveBeenCalledTimes(1);
    expect(options.cancel.label).toBe("Use theirs");
    options.cancel.onClick();
    expect(reload).toHaveBeenCalledTimes(1);

    // A plain save again is refused again rather than overwriting.
    writeLocalFileMock.mockRejectedValueOnce(new Error(FILE_WRITE_CONFLICT_MESSAGE));
    await act(async () => {
      await expect(result.current.saveFile()).resolves.toBe(false);
    });
    expect(writeLocalFileMock.mock.calls.at(-1)?.[3]).toEqual({
      sha256: fileContentSha256("original"),
    });
    expect(appCommandStore(fileDirtyStore).getState().isDirty("tab")).toBe(true);
  });

  test("keep mine writes over the version shown, and keeps it restorable", async () => {
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "mine");
    appCommandStore(fileDirtyStore).getState().observeDiskContent("tab", "agent's version");
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "notes.md",
        worktreePath: "/repo",
        isLocalEnvironment: true,
      }),
    );

    await act(async () => {
      await expect(result.current.keepMine()).resolves.toBe(true);
    });
    const call = writeLocalFileMock.mock.calls.at(-1);
    expect(decodeBase64Utf8(call?.[2] ?? "")).toBe("mine");
    // Conditional on the newer version the user saw, never unconditional.
    expect(call?.[3]).toEqual({ sha256: fileContentSha256("agent's version") });
    expect(appCommandStore(fileDirtyStore).getState().dirtyFiles.get("tab")).toEqual({
      content: "mine",
      originalContent: "mine",
    });

    const [title, options] = mockToastSuccess.mock.calls.at(-1)! as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe("Saved your version");
    expect(options.action.label).toBe("Restore theirs");
    act(() => options.action.onClick());
    expect(appCommandStore(fileDirtyStore).getState().dirtyFiles.get("tab")).toEqual({
      content: "agent's version",
      originalContent: "mine",
    });
  });

  test("keep mine refuses again when the file moved after it was compared", async () => {
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "mine");
    appCommandStore(fileDirtyStore).getState().observeDiskContent("tab", "agent's version");
    writeLocalFileMock.mockRejectedValueOnce(new Error(FILE_WRITE_CONFLICT_MESSAGE));
    readLocalFileMock.mockImplementation(async () => ({
      path: "notes.md",
      content: "agent's second version",
      language: "markdown",
    }));
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "notes.md",
        worktreePath: "/repo",
        isLocalEnvironment: true,
      }),
    );

    await act(async () => {
      await expect(result.current.keepMine()).resolves.toBe(false);
    });
    expect(writeLocalFileMock).toHaveBeenCalledTimes(1);
    expect(
      fileSaveConflict(appCommandStore(fileDirtyStore).getState().dirtyFiles.get("tab")),
    ).toEqual({
      kind: "changed",
      disk: "agent's second version",
      mine: "mine",
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("a disk that already holds the buffer counts as saved", async () => {
    writeContainerFileMock.mockRejectedValueOnce(new Error(FILE_WRITE_CONFLICT_MESSAGE));
    readContainerFileMock.mockImplementationOnce(async () => ({
      path: "README.md",
      content: "mine",
      language: "markdown",
    }));
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "mine");
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "README.md",
        containerId: "container-1",
        isLocalEnvironment: false,
      }),
    );

    await act(async () => {
      await expect(result.current.saveFile()).resolves.toBe(true);
    });
    expect(appCommandStore(fileDirtyStore).getState().isDirty("tab")).toBe(false);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a disk that changed and changed back is retried once with the same check", async () => {
    writeContainerFileMock.mockRejectedValueOnce(new Error(FILE_WRITE_CONFLICT_MESSAGE));
    readContainerFileMock.mockImplementationOnce(async () => ({
      path: "README.md",
      content: "original",
      language: "markdown",
    }));
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "mine");
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "README.md",
        containerId: "container-1",
        isLocalEnvironment: false,
      }),
    );

    await act(async () => {
      await expect(result.current.saveFile()).resolves.toBe(true);
    });
    expect(writeContainerFileMock).toHaveBeenCalledTimes(2);
    expect(writeContainerFileMock.mock.calls[1]?.[3]).toEqual({
      sha256: fileContentSha256("original"),
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a file that can no longer be read keeps the buffer and saves only on request", async () => {
    writeLocalFileMock.mockRejectedValueOnce(new Error(FILE_WRITE_CONFLICT_MESSAGE));
    readLocalFileMock.mockImplementation(async () => {
      throw new Error("ENOENT");
    });
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "mine");
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "notes.md",
        worktreePath: "/repo",
        isLocalEnvironment: true,
        onReloadFromDisk: () => undefined,
        onCompare: () => undefined,
      }),
    );

    const logs = captureLogs();
    try {
      await act(async () => {
        await expect(result.current.saveFile()).resolves.toBe(false);
      });
    } finally {
      logs.restore();
    }
    expect(
      fileSaveConflict(appCommandStore(fileDirtyStore).getState().dirtyFiles.get("tab")),
    ).toEqual({
      kind: "unreadable",
      mine: "mine",
    });
    const options = mockToastError.mock.calls.at(-1)?.[1] as {
      action: { label: string; onClick: () => void };
      cancel?: unknown;
    };
    expect(options.action.label).toBe("Save mine");
    expect(options.cancel).toBeUndefined();
    await act(async () => {
      options.action.onClick();
      await Promise.resolve();
    });
    // Nothing on disk to compare against: the explicit save recreates it.
    const recreate = writeLocalFileMock.mock.calls.at(-1);
    expect(decodeBase64Utf8(recreate?.[2] ?? "")).toBe("mine");
    expect(recreate?.[3]).toBeUndefined();
    expect(appCommandStore(fileDirtyStore).getState().dirtyFiles.get("tab")).toEqual({
      content: "mine",
      originalContent: "mine",
    });
  });

  test("flushes a Unicode override through the local save path", async () => {
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "notes.md",
        worktreePath: "/repo",
        isLocalEnvironment: true,
      }),
    );

    await act(async () => {
      await result.current.saveFile("# Updated 🌍");
    });

    const call = writeLocalFileMock.mock.calls[0];
    expect(call?.[0]).toBe("/repo");
    expect(call?.[1]).toBe("notes.md");
    expect(decodeBase64Utf8(call?.[2] ?? "")).toBe("# Updated 🌍");
    expect(appCommandStore(fileDirtyStore).getState().getContent("tab")).toBe("# Updated 🌍");
    expect(appCommandStore(fileDirtyStore).getState().isDirty("tab")).toBe(false);
  });

  test("encodes empty and chunk-spanning UTF-8 content", async () => {
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "large.md",
        containerId: "container-1",
        isLocalEnvironment: false,
      }),
    );
    const largeContent = `${"a".repeat(8_191)}🌍${"b".repeat(9_000)}`;

    await act(async () => {
      await result.current.saveFile(largeContent);
    });
    expect(decodeBase64Utf8(writeContainerFileMock.mock.calls[0]?.[2] ?? "")).toBe(largeContent);

    await act(async () => {
      await result.current.saveFile("");
    });
    expect(decodeBase64Utf8(writeContainerFileMock.mock.calls[1]?.[2] ?? "missing")).toBe("");
  });

  test("rejects saves with missing environment identifiers or content", async () => {
    const local = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "local",
        filePath: "README.md",
        isLocalEnvironment: true,
      }),
    );
    const container = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "container",
        filePath: "README.md",
        isLocalEnvironment: false,
      }),
    );
    const noContent = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "empty",
        filePath: "README.md",
        containerId: "container-1",
        isLocalEnvironment: false,
      }),
    );

    await expect(local.result.current.saveFile()).resolves.toBe(false);
    await expect(container.result.current.saveFile()).resolves.toBe(false);
    await expect(noContent.result.current.saveFile()).resolves.toBe(false);
    expect(writeLocalFileMock).not.toHaveBeenCalled();
    expect(writeContainerFileMock).not.toHaveBeenCalled();
  });

  test("keeps content dirty when the backend write fails", async () => {
    const logs = captureLogs();
    writeContainerFileMock.mockRejectedValueOnce(new Error("disk unavailable"));
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "updated");
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "README.md",
        containerId: "container-1",
        isLocalEnvironment: false,
      }),
    );

    await expect(result.current.saveFile()).resolves.toBe(false);

    expect(appCommandStore(fileDirtyStore).getState().getContent("tab")).toBe("updated");
    expect(appCommandStore(fileDirtyStore).getState().isDirty("tab")).toBe(true);
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        level: "error",
        area: "web.files",
        event: "file.save-failed",
        fields: expect.objectContaining({ tabId: "tab" }),
      }),
    );
    expect(logs.lines.join("\n")).not.toContain("README.md");
    logs.restore();
  });

  test("preserves edits made during a save and rejects a concurrent save", async () => {
    const write = deferred<string>();
    writeContainerFileMock.mockImplementationOnce(() => write.promise);
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "captured-for-save");
    const { result } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "README.md",
        containerId: "container-1",
        isLocalEnvironment: false,
      }),
    );

    let firstSave!: Promise<boolean>;
    await act(async () => {
      firstSave = result.current.saveFile();
      await Promise.resolve();
    });
    expect(result.current.isSaving).toBe(true);
    await expect(result.current.saveFile()).resolves.toBe(false);

    act(() => {
      appCommandStore(fileDirtyStore).getState().setContent("tab", "typed-during-save");
    });
    write.resolve("/workspace/README.md");
    await act(async () => {
      await expect(firstSave).resolves.toBe(true);
    });

    expect(writeContainerFileMock).toHaveBeenCalledTimes(1);
    expect(appCommandStore(fileDirtyStore).getState().getContent("tab")).toBe("typed-during-save");
    expect(appCommandStore(fileDirtyStore).getState().isDirty("tab")).toBe(true);
    expect(result.current.isSaving).toBe(false);
  });

  test("does not recreate dirty state when a tab unmounts during save", async () => {
    const write = deferred<string>();
    writeContainerFileMock.mockImplementationOnce(() => write.promise);
    appCommandStore(fileDirtyStore).getState().setOriginalContent("tab", "original");
    appCommandStore(fileDirtyStore).getState().setContent("tab", "saving");
    const { result, unmount } = renderHookInAppCommandScope(() =>
      useFileSave({
        tabId: "tab",
        filePath: "README.md",
        containerId: "container-1",
        isLocalEnvironment: false,
      }),
    );

    let save!: Promise<boolean>;
    act(() => {
      save = result.current.saveFile();
    });
    unmount();
    appCommandStore(fileDirtyStore).getState().clearDirty("tab");
    write.resolve("/workspace/README.md");
    await expect(save).resolves.toBe(true);

    expect(appCommandStore(fileDirtyStore).getState().getContent("tab")).toBeNull();
  });
});
