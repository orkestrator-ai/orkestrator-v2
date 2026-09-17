import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEnvironmentStore, useFilesPanelStore, useUIStore } from "@/stores";
import type { Environment } from "@/types";
import * as realBackend from "@/lib/backend";
import { mockToastError, mockToastSuccess } from "../../../../tests/mocks/sonner";

const realBackendSnapshot = { ...realBackend };
const copyExternalFileMock = mock(
  async (_environmentId: string, directory: string, fileName: string, _base64Data: string) =>
    directory === "." ? fileName : `${directory}/${fileName}`,
);
const getLocalFileTreeSnapshotMock = mock(async () => ({
  unchanged: false,
  digest: "tree",
  value: [],
}));
const getLocalGitStatusSnapshotMock = mock(async () => ({
  unchanged: false,
  digest: "changes",
  value: [],
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  copyExternalFile: copyExternalFileMock,
  getLocalFileTreeSnapshot: getLocalFileTreeSnapshotMock,
  getLocalGitStatusSnapshot: getLocalGitStatusSnapshotMock,
}));

const { MAX_EXTERNAL_FILE_DROP_BYTES, MAX_EXTERNAL_FILE_DROP_COUNT, useFilesPanel } =
  await import("./useFilesPanel");

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
  useUIStore.setState({ selectedEnvironmentId: "environment-1" });
  useEnvironmentStore.setState({
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
  useFilesPanelStore.setState({
    isOpen: false,
    activeTab: "all-files",
    changes: [],
    fileTree: [],
  });
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("useFilesPanel external file copies", () => {
  test("encodes dropped bytes, targets the selected environment, and refreshes the tree", async () => {
    const { result } = renderHook(() => useFilesPanel());
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
    const { result } = renderHook(() => useFilesPanel());
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
    const { result } = renderHook(() => useFilesPanel());

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
    const { result } = renderHook(() => useFilesPanel());

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
    const { result } = renderHook(() => useFilesPanel());

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
    useUIStore.setState({ selectedEnvironmentId: null });
    const { result } = renderHook(() => useFilesPanel());

    await expect(
      result.current.copyExternalFiles([droppedFile("notes.txt", [1])], "."),
    ).rejects.toThrow("The selected environment is not available");
    expect(mockToastError).toHaveBeenCalledWith("Failed to copy file", {
      description: "The selected environment is not available",
    });
    expect(copyExternalFileMock).not.toHaveBeenCalled();
  });
});
