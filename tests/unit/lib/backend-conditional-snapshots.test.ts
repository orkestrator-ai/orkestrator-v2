import { beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  getFileTreeSnapshot,
  getBuildPipelineConditional,
  getBuildPipelineControl,
  getGitStatusSnapshot,
  getLocalFileTreeSnapshot,
  getLocalGitStatusSnapshot,
  listBuildPipelinesConditional,
  type ConditionalBuildPipeline,
} from "../../../apps/web/src/lib/backend";
import type { PersistedBuildPipeline } from "../../../apps/web/src/types";
import type { WorktreeReadStamp } from "@orkestrator/protocol/worktree-snapshots";

const invokeMock = invoke as ReturnType<typeof mock>;

function pipelineRecord(id: string): PersistedBuildPipeline {
  return {
    version: 1,
    id,
    projectId: "project-1",
    environmentId: "env-1",
    snapshot: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
  };
}

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
      [
        "get_git_status",
        {
          containerId: "container-1",
          targetBranch: "main",
          includeUncommitted: true,
          knownDigest: "known-git",
        },
      ],
      [
        "get_file_tree",
        {
          containerId: "container-1",
          knownDigest: "",
        },
      ],
      [
        "get_local_git_status",
        {
          worktreePath: "/worktree",
          targetBranch: "develop",
          includeUncommitted: true,
          knownDigest: "",
        },
      ],
      [
        "get_local_file_tree",
        {
          worktreePath: "/worktree",
          knownDigest: "known-tree",
        },
      ],
    ]);
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
      // A bare array is what a backend that ignored knownDigest sent; none
      // in the support window does, so it is malformed.
      [{ name: "src", path: "src", isDirectory: true }],
    ];

    for (const response of malformed) {
      invokeMock.mockResolvedValueOnce(response);
      await expect(getFileTreeSnapshot("container-1")).rejects.toThrow(
        "Invalid get_file_tree response",
      );
    }
  });

  test("normalizes and validates conditional build-pipeline lists", async () => {
    const first = pipelineRecord("pipeline-1");
    const second = pipelineRecord("pipeline-2");
    invokeMock
      .mockResolvedValueOnce({ ids: ["pipeline-1", "pipeline-2"], records: [first, second] })
      .mockResolvedValueOnce({ ids: ["pipeline-1"], records: [first] })
      .mockResolvedValueOnce({ ids: [42], records: [] })
      .mockResolvedValueOnce([first, second]);

    await expect(listBuildPipelinesConditional("project-1", {})).resolves.toEqual({
      ids: ["pipeline-1", "pipeline-2"],
      records: [first, second],
    });
    await expect(listBuildPipelinesConditional("project-1", { "pipeline-1": 2 })).resolves.toEqual({
      ids: ["pipeline-1"],
      records: [first],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "list_build_pipelines", {
      projectId: "project-1",
      knownRevisions: { "pipeline-1": 2 },
    });
    await expect(listBuildPipelinesConditional("project-1", {})).rejects.toThrow(
      "Invalid list_build_pipelines response",
    );
    await expect(listBuildPipelinesConditional("project-1", {})).rejects.toThrow(
      "Invalid list_build_pipelines response",
    );
  });

  test("validates conditional build-pipeline point-read envelopes", async () => {
    const legacy = pipelineRecord("pipeline-1");
    const changed: ConditionalBuildPipeline<unknown> = {
      unchanged: false,
      record: legacy,
      messagePatches: [
        {
          sessionKey: "session-1",
          baseRevision: 2,
          baseCount: 3,
          startIndex: 2,
          revision: 3,
          messages: [{ id: "message-3" }],
        },
      ],
    };
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacy)
      .mockResolvedValueOnce({ unchanged: true, revision: 4 })
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce({ unchanged: false, record: legacy, messagePatches: [{}] });

    await expect(getBuildPipelineConditional("missing")).resolves.toBeNull();
    await expect(getBuildPipelineConditional("pipeline-1")).resolves.toBe(legacy);
    await expect(getBuildPipelineConditional("pipeline-1", 4)).resolves.toEqual({
      unchanged: true,
      revision: 4,
    });
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
    await expect(getBuildPipelineConditional("pipeline-1")).rejects.toThrow(
      "Invalid get_build_pipeline response",
    );
  });

  test("validates the detail fields of a fingerprinted point read", async () => {
    const record = pipelineRecord("pipeline-1");
    const omitted = {
      unchanged: false,
      record,
      messagePatches: [],
      detailFingerprint: "d1-held",
      detailOmitted: true,
    };
    const full = { unchanged: false, record, messagePatches: [], detailFingerprint: "d1-new" };
    const malformed = [
      // Detail left out with no fingerprint naming what the caller must hold.
      { unchanged: false, record, messagePatches: [], detailOmitted: true },
      // An empty fingerprint names nothing.
      { unchanged: false, record, messagePatches: [], detailFingerprint: "" },
      {
        unchanged: false,
        record,
        messagePatches: [],
        detailFingerprint: "",
        detailOmitted: true,
      },
      { unchanged: false, record, messagePatches: [], detailFingerprint: 42 },
      {
        unchanged: false,
        record,
        messagePatches: [],
        detailFingerprint: "d1-held",
        detailOmitted: false,
      },
    ];

    // Both point-read wrappers accept the well-formed shapes and forward the fingerprint.
    invokeMock.mockResolvedValueOnce(omitted).mockResolvedValueOnce(full);
    await expect(
      getBuildPipelineConditional("pipeline-1", 3, {}, undefined, "d1-held"),
    ).resolves.toBe(omitted);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_build_pipeline", {
      pipelineId: "pipeline-1",
      knownRevision: 3,
      knownSessions: {},
      knownDetailFingerprint: "d1-held",
    });
    await expect(getBuildPipelineControl("pipeline-1", 3, "d1-held")).resolves.toBe(full);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_build_pipeline", {
      pipelineId: "pipeline-1",
      knownRevision: 3,
      knownDetailFingerprint: "d1-held",
    });

    for (const response of malformed) {
      invokeMock.mockResolvedValueOnce(response).mockResolvedValueOnce(response);
      await expect(
        getBuildPipelineConditional("pipeline-1", 3, {}, undefined, "d1-held"),
      ).rejects.toThrow("Invalid get_build_pipeline response");
      await expect(getBuildPipelineControl("pipeline-1", 3, "d1-held")).rejects.toThrow(
        "Invalid get_build_pipeline response",
      );
    }
  });

  test("forwards a refresh request and validates the additive owner stamp", async () => {
    const view: WorktreeReadStamp = {
      generation: "gen-1",
      environmentId: "env-1",
      targetGeneration: 2,
      revision: 5,
      freshness: "current",
      watched: true,
    };
    invokeMock
      .mockResolvedValueOnce({ unchanged: false, digest: "d", value: [], view })
      .mockResolvedValueOnce({ unchanged: true, digest: "d", view: { ...view, revision: -1 } });

    await expect(
      getLocalGitStatusSnapshot("/worktree", "main", "known", { refresh: true }),
    ).resolves.toEqual({ unchanged: false, digest: "d", value: [], view });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_local_git_status", {
      worktreePath: "/worktree",
      targetBranch: "main",
      includeUncommitted: true,
      knownDigest: "known",
      refresh: true,
    });
    // A malformed stamp is an invalid response, never a legacy one.
    await expect(getLocalFileTreeSnapshot("/worktree", "d")).rejects.toThrow(
      "Invalid get_local_file_tree response",
    );
  });
});
