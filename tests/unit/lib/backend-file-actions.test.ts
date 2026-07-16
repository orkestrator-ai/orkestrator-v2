import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  deleteContainerFile,
  deleteLocalFile,
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
});
