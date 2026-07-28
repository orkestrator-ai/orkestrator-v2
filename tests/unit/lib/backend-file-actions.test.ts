import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  browseForDirectory,
  deleteContainerFile,
  deleteLocalFile,
  getEnvironmentDiffStats,
  refreshEnvironmentDiffStats,
  revertContainerFile,
  revertLocalFile,
} from "../../../apps/web/src/lib/backend";

const invokeMock = invoke as ReturnType<typeof mock>;

describe("file action backend wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("src/App.tsx");
  });

  afterEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    delete window.orkestrator;
    delete window.orkestratorGateway;
  });

  test("binds container mutations to an environment id", async () => {
    await expect(revertContainerFile("env-container", "src/App.tsx", "main")).resolves.toBe(
      "src/App.tsx",
    );
    await expect(deleteContainerFile("env-container", "src/App.tsx")).resolves.toBe(
      "src/App.tsx",
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "revert_container_file", {
      environmentId: "env-container",
      filePath: "src/App.tsx",
      targetBranch: "main",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "delete_container_file", {
      environmentId: "env-container",
      filePath: "src/App.tsx",
    });
  });

  test("binds local mutations to an environment id", async () => {
    await expect(revertLocalFile("env-local", "src/App.tsx", "feature-base")).resolves.toBe(
      "src/App.tsx",
    );
    await expect(deleteLocalFile("env-local", "src/App.tsx")).resolves.toBe("src/App.tsx");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "revert_local_file", {
      environmentId: "env-local",
      filePath: "src/App.tsx",
      targetBranch: "feature-base",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "delete_local_file", {
      environmentId: "env-local",
      filePath: "src/App.tsx",
    });
  });

  test("uses the exact diff-stat snapshot and refresh command contracts", async () => {
    const snapshot = {
      entries: [{
        environmentId: "env-local",
        comparisonRef: "trunk",
        stats: { additions: 2, deletions: 1, filesChanged: 1, truncated: false },
        computedAt: "2026-07-28T12:00:00.000Z",
      }],
    };
    invokeMock.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(undefined);

    await expect(getEnvironmentDiffStats()).resolves.toEqual(snapshot);
    await expect(refreshEnvironmentDiffStats("env-local")).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_environment_diff_stats");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "refresh_environment_diff_stats", {
      environmentId: "env-local",
    });
  });

  test("uses the native directory picker and normalizes cancelled or multi-select results", async () => {
    const open = mock()
      .mockResolvedValueOnce("/workspaces/project")
      .mockResolvedValueOnce(["/workspaces/one", "/workspaces/two"]);
    window.orkestrator = { dialog: { open } } as unknown as Window["orkestrator"];
    delete window.orkestratorGateway;

    await expect(browseForDirectory()).resolves.toBe("/workspaces/project");
    await expect(browseForDirectory()).resolves.toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith({ directory: true });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
