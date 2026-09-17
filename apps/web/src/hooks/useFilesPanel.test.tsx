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
  copyExternalFileMock.mockClear();
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
});
