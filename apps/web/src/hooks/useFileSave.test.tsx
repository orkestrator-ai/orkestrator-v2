import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useFileDirtyStore } from "@/stores/fileDirtyStore";
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };
const writeContainerFileMock = mock(
  async (_containerId: string, _filePath: string, _base64Data: string) => "/workspace/file.md",
);
const writeLocalFileMock = mock(
  async (_worktreePath: string, _filePath: string, _base64Data: string) => "/repo/file.md",
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

beforeEach(() => {
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  writeContainerFileMock.mockClear();
  writeLocalFileMock.mockClear();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("useFileSave", () => {
  test("writes current container content and marks it saved", async () => {
    useFileDirtyStore.getState().setOriginalContent("tab", "original");
    useFileDirtyStore.getState().setContent("tab", "updated");
    const { result } = renderHook(() => useFileSave({
      tabId: "tab",
      filePath: "README.md",
      containerId: "container-1",
      isLocalEnvironment: false,
    }));

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
    expect(useFileDirtyStore.getState().isDirty("tab")).toBe(false);
  });

  test("flushes a Unicode override through the local save path", async () => {
    useFileDirtyStore.getState().setOriginalContent("tab", "original");
    const { result } = renderHook(() => useFileSave({
      tabId: "tab",
      filePath: "notes.md",
      worktreePath: "/repo",
      isLocalEnvironment: true,
    }));

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
});
