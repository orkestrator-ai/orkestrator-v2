import { beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  getFileTreeSnapshot,
  getBuildPipelineConditional,
  getGitStatusSnapshot,
  getLocalFileTreeSnapshot,
  getLocalGitStatusSnapshot,
  listBuildPipelinesConditional,
} from "../../../apps/web/src/lib/backend";

const invokeMock = invoke as ReturnType<typeof mock>;

describe("conditional backend wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("passes snapshot cursors and defaults omitted digests to an empty string", async () => {
    invokeMock
      .mockResolvedValueOnce({ unchanged: true, digest: "git-digest" })
      .mockResolvedValueOnce({ unchanged: true, digest: "tree-digest" })
      .mockResolvedValueOnce({ unchanged: true, digest: "local-git-digest" })
      .mockResolvedValueOnce({ unchanged: true, digest: "local-tree-digest" });

    await getGitStatusSnapshot("container-1", "main", "known-git");
    await getFileTreeSnapshot("container-1");
    await getLocalGitStatusSnapshot("/worktree", "develop");
    await getLocalFileTreeSnapshot("/worktree", "known-tree");

    expect(invokeMock.mock.calls).toEqual([
      ["get_git_status", {
        containerId: "container-1",
        targetBranch: "main",
        includeUncommitted: true,
        knownDigest: "known-git",
      }],
      ["get_file_tree", {
        containerId: "container-1",
        knownDigest: "",
      }],
      ["get_local_git_status", {
        worktreePath: "/worktree",
        targetBranch: "develop",
        includeUncommitted: true,
        knownDigest: "",
      }],
      ["get_local_file_tree", {
        worktreePath: "/worktree",
        knownDigest: "known-tree",
      }],
    ]);
  });

  test("normalizes legacy raw arrays for every snapshot wrapper", async () => {
    const changes = [{
      path: "src/App.tsx",
      filename: "App.tsx",
      directory: "src",
      additions: 1,
      deletions: 0,
      status: "M",
    }];
    const tree = [{ name: "src", path: "src", isDirectory: true }];
    invokeMock
      .mockResolvedValueOnce(changes)
      .mockResolvedValueOnce(tree)
      .mockResolvedValueOnce(changes)
      .mockResolvedValueOnce(tree);

    await expect(getGitStatusSnapshot("container-1", "main")).resolves.toEqual({
      unchanged: false,
      digest: "",
      value: changes,
    });
    await expect(getFileTreeSnapshot("container-1")).resolves.toEqual({
      unchanged: false,
      digest: "",
      value: tree,
    });
    await expect(getLocalGitStatusSnapshot("/worktree", "main")).resolves.toEqual({
      unchanged: false,
      digest: "",
      value: changes,
    });
    await expect(getLocalFileTreeSnapshot("/worktree")).resolves.toEqual({
      unchanged: false,
      digest: "",
      value: tree,
    });
  });

  test("rejects malformed conditional snapshot envelopes", async () => {
    const malformed = [
      null,
      {},
      { unchanged: "yes", digest: "digest" },
      { unchanged: true, digest: 42 },
      { unchanged: true, digest: "digest", value: [] },
      { unchanged: false, digest: "digest" },
      { unchanged: false, digest: "digest", value: {} },
    ];

    for (const response of malformed) {
      invokeMock.mockResolvedValueOnce(response);
      await expect(getFileTreeSnapshot("container-1")).rejects.toThrow(
        "Invalid get_file_tree response",
      );
    }
  });

  test("normalizes and validates conditional build-pipeline lists", async () => {
    const first = { id: "pipeline-1" };
    const second = { id: "pipeline-2" };
    invokeMock
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce({ ids: ["pipeline-1"], records: [first] })
      .mockResolvedValueOnce({ ids: [42], records: [] })
      .mockResolvedValueOnce([{ missingId: true }]);

    await expect(
      listBuildPipelinesConditional("project-1", {}),
    ).resolves.toEqual({
      ids: ["pipeline-1", "pipeline-2"],
      records: [first, second],
    });
    await expect(
      listBuildPipelinesConditional("project-1", { "pipeline-1": 2 }),
    ).resolves.toEqual({
      ids: ["pipeline-1"],
      records: [first],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "list_build_pipelines", {
      projectId: "project-1",
      knownRevisions: { "pipeline-1": 2 },
    });
    await expect(
      listBuildPipelinesConditional("project-1", {}),
    ).rejects.toThrow("Invalid list_build_pipelines response");
    await expect(
      listBuildPipelinesConditional("project-1", {}),
    ).rejects.toThrow("Invalid list_build_pipelines response");
  });

  test("validates conditional build-pipeline point-read envelopes", async () => {
    const legacy = { id: "pipeline-1" };
    const changed = {
      unchanged: false,
      record: legacy,
      messagePatches: [{
        sessionKey: "session-1",
        baseRevision: 2,
        baseCount: 3,
        startIndex: 2,
        revision: 3,
        messages: [{ id: "message-3" }],
      }],
    };
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacy)
      .mockResolvedValueOnce({ unchanged: true, revision: 4 })
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce({ unchanged: false, record: legacy, messagePatches: [{}] });

    await expect(
      getBuildPipelineConditional("missing"),
    ).resolves.toBeNull();
    await expect(
      getBuildPipelineConditional("pipeline-1"),
    ).resolves.toBe(legacy);
    await expect(
      getBuildPipelineConditional("pipeline-1", 4),
    ).resolves.toEqual({ unchanged: true, revision: 4 });
    await expect(
      getBuildPipelineConditional("pipeline-1", 3, {
        "session-1": { revision: 2, count: 3 },
      }),
    ).resolves.toBe(changed);
    expect(invokeMock).toHaveBeenNthCalledWith(4, "get_build_pipeline", {
      pipelineId: "pipeline-1",
      knownRevision: 3,
      knownSessions: {
        "session-1": { revision: 2, count: 3 },
      },
    });
    await expect(
      getBuildPipelineConditional("pipeline-1"),
    ).rejects.toThrow("Invalid get_build_pipeline response");
  });
});
