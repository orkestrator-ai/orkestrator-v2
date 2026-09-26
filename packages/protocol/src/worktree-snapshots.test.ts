import { describe, expect, test } from "bun:test";
import { classifyViewSnapshotResponse, isViewSnapshotOutcome } from "./view-sync.js";
import {
  isWorktreeReadStamp,
  isWorktreeSnapshotEvent,
  isWorktreeSnapshotRevisionsSnapshot,
  isWorktreeSnapshotState,
  type WorktreeSnapshotState,
} from "./worktree-snapshots.js";

const state: WorktreeSnapshotState = {
  environmentId: "env-1",
  targetGeneration: 3,
  comparisonRef: "main",
  fileListRevision: 2,
  treeRevision: 0,
  freshness: "current",
  watched: true,
};

describe("worktree snapshot contract", () => {
  test("accepts a state, a stamped change and a stamped removal", () => {
    expect(isWorktreeSnapshotState(state)).toBe(true);
    expect(isWorktreeSnapshotEvent({ ...state, generation: "gen-1", revision: 4 })).toBe(true);
    expect(
      isWorktreeSnapshotEvent({
        environmentId: "env-1",
        removed: true,
        generation: "g",
        revision: 5,
      }),
    ).toBe(true);
  });

  test.each([
    ["target generation zero", { ...state, targetGeneration: 0 }],
    ["negative revision", { ...state, fileListRevision: -1 }],
    ["unknown freshness", { ...state, freshness: "fresh" }],
    ["missing watched", { ...state, watched: undefined }],
    ["blank environment", { ...state, environmentId: " " }],
  ])("rejects %s", (_label, value) => {
    expect(isWorktreeSnapshotState(value)).toBe(false);
  });

  test("a partial stamp is invalid, never legacy", () => {
    expect(isWorktreeSnapshotEvent({ ...state, generation: "gen-1" })).toBe(false);
    expect(isWorktreeSnapshotEvent({ ...state, generation: "gen-1", revision: 0 })).toBe(false);
  });

  test("snapshots classify as revisioned, legacy or conditional outcomes", () => {
    expect(
      classifyViewSnapshotResponse(
        { entries: [state], generation: "gen-1", revision: 7 },
        isWorktreeSnapshotRevisionsSnapshot,
      ),
    ).toMatchObject({ kind: "stamped", stamp: { generation: "gen-1", revision: 7 } });
    expect(
      classifyViewSnapshotResponse({ entries: [] }, isWorktreeSnapshotRevisionsSnapshot).kind,
    ).toBe("legacy");
    expect(
      isViewSnapshotOutcome(
        { status: "unchanged", generation: "gen-1", revision: 7 },
        isWorktreeSnapshotRevisionsSnapshot,
      ),
    ).toBe(true);
    expect(
      classifyViewSnapshotResponse(
        { entries: [{ ...state, freshness: "?" }] },
        isWorktreeSnapshotRevisionsSnapshot,
      ).kind,
    ).toBe("invalid");
  });

  test("read stamps name the owner generation, lineage and body revision", () => {
    const stamp = {
      generation: "gen-1",
      environmentId: "env-1",
      targetGeneration: 3,
      revision: 2,
      freshness: "stale",
      watched: false,
    };
    expect(isWorktreeReadStamp(stamp)).toBe(true);
    expect(isWorktreeReadStamp({ ...stamp, generation: "bad generation" })).toBe(false);
    expect(isWorktreeReadStamp({ ...stamp, targetGeneration: 0 })).toBe(false);
  });
});
