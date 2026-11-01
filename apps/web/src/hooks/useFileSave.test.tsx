import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useFileDirtyStore } from "@/stores/fileDirtyStore";
import * as realBackend from "@/lib/backend";
import {
  FILE_WRITE_CONFLICT_MESSAGE,
  fileContentSha256,
} from "@orkestrator/protocol/file-write-precondition";
import { mockToastError } from "../../../../tests/mocks/sonner";

const realBackendSnapshot = { ...realBackend };
const writeContainerFileMock = mock(
  async (_containerId: string, _filePath: string, _base64Data: string, _expected?: unknown) =>
    "/workspace/file.md",
);
const writeLocalFileMock = mock(
  async (_worktreePath: string, _filePath: string, _base64Data: string, _expected?: unknown) =>
    "/repo/file.md",
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  writeContainerFile: writeContainerFileMock,
  writeLocalFile: writeLocalFileMock,
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
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  writeContainerFileMock.mockClear();
  writeLocalFileMock.mockClear();
  mockToastError.mockClear();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("useFileSave", () => {
  test("writes current container content and marks it saved", async () => {
    useFileDirtyStore.getState().setOriginalContent("tab", "original");
    useFileDirtyStore.getState().setContent("tab", "updated");
    const { result } = renderHook(() =>
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
    expect(useFileDirtyStore.getState().isDirty("tab")).toBe(false);
  });

  test("a file changed on disk keeps the buffer and offers overwrite or reload", async () => {
    writeLocalFileMock.mockRejectedValueOnce(new Error(FILE_WRITE_CONFLICT_MESSAGE));
    useFileDirtyStore.getState().setOriginalContent("tab", "original");
    useFileDirtyStore.getState().setContent("tab", "mine");
    const reload = mock(() => undefined);
    const { result } = renderHook(() =>
      useFileSave({
        tabId: "tab",
        filePath: "notes.md",
        worktreePath: "/repo",
        isLocalEnvironment: true,
        onReloadFromDisk: reload,
      }),
    );

    await act(async () => {
      await expect(result.current.saveFile()).resolves.toBe(false);
    });
    expect(useFileDirtyStore.getState().isDirty("tab")).toBe(true);
    const [title, options] = mockToastError.mock.calls.at(-1)! as [
      string,
      {
        action: { label: string; onClick: () => void };
        cancel: { label: string; onClick: () => void };
      },
    ];
    expect(title).toBe("File changed on disk");
    expect(options.cancel.label).toBe("Reload");
    options.cancel.onClick();
    expect(reload).toHaveBeenCalledTimes(1);

    expect(options.action.label).toBe("Overwrite");
    await act(async () => {
      options.action.onClick();
      await Promise.resolve();
    });
    // Overwrite is the same save without the precondition.
    const overwrite = writeLocalFileMock.mock.calls.at(-1);
    expect(decodeBase64Utf8(overwrite?.[2] ?? "")).toBe("mine");
    expect(overwrite?.[3]).toBeUndefined();
    expect(useFileDirtyStore.getState().isDirty("tab")).toBe(false);
  });

  test("flushes a Unicode override through the local save path", async () => {
    useFileDirtyStore.getState().setOriginalContent("tab", "original");
    const { result } = renderHook(() =>
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
    expect(useFileDirtyStore.getState().getContent("tab")).toBe("# Updated 🌍");
    expect(useFileDirtyStore.getState().isDirty("tab")).toBe(false);
  });

  test("encodes empty and chunk-spanning UTF-8 content", async () => {
    useFileDirtyStore.getState().setOriginalContent("tab", "original");
    const { result } = renderHook(() =>
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
    const local = renderHook(() =>
      useFileSave({
        tabId: "local",
        filePath: "README.md",
        isLocalEnvironment: true,
      }),
    );
    const container = renderHook(() =>
      useFileSave({
        tabId: "container",
        filePath: "README.md",
        isLocalEnvironment: false,
      }),
    );
    const noContent = renderHook(() =>
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
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    writeContainerFileMock.mockRejectedValueOnce(new Error("disk unavailable"));
    useFileDirtyStore.getState().setOriginalContent("tab", "original");
    useFileDirtyStore.getState().setContent("tab", "updated");
    const { result } = renderHook(() =>
      useFileSave({
        tabId: "tab",
        filePath: "README.md",
        containerId: "container-1",
        isLocalEnvironment: false,
      }),
    );

    await expect(result.current.saveFile()).resolves.toBe(false);

    expect(useFileDirtyStore.getState().getContent("tab")).toBe("updated");
    expect(useFileDirtyStore.getState().isDirty("tab")).toBe(true);
    errorSpy.mockRestore();
  });

  test("preserves edits made during a save and rejects a concurrent save", async () => {
    const write = deferred<string>();
    writeContainerFileMock.mockImplementationOnce(() => write.promise);
    useFileDirtyStore.getState().setOriginalContent("tab", "original");
    useFileDirtyStore.getState().setContent("tab", "captured-for-save");
    const { result } = renderHook(() =>
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
      useFileDirtyStore.getState().setContent("tab", "typed-during-save");
    });
    write.resolve("/workspace/README.md");
    await act(async () => {
      await expect(firstSave).resolves.toBe(true);
    });

    expect(writeContainerFileMock).toHaveBeenCalledTimes(1);
    expect(useFileDirtyStore.getState().getContent("tab")).toBe("typed-during-save");
    expect(useFileDirtyStore.getState().isDirty("tab")).toBe(true);
    expect(result.current.isSaving).toBe(false);
  });

  test("does not recreate dirty state when a tab unmounts during save", async () => {
    const write = deferred<string>();
    writeContainerFileMock.mockImplementationOnce(() => write.promise);
    useFileDirtyStore.getState().setOriginalContent("tab", "original");
    useFileDirtyStore.getState().setContent("tab", "saving");
    const { result, unmount } = renderHook(() =>
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
    useFileDirtyStore.getState().clearDirty("tab");
    write.resolve("/workspace/README.md");
    await expect(save).resolves.toBe(true);

    expect(useFileDirtyStore.getState().getContent("tab")).toBeNull();
  });
});
