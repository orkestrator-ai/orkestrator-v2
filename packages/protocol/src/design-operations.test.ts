import { describe, expect, test } from "bun:test";
import {
  designIntentLane,
  rebaseOverOwnCommits,
  type DesignOperationDescriptor,
  type DesignOperationStatus,
} from "./design-operations.js";

const commit = (
  clientId: string,
  canvasRevision: number,
  frames: Array<{ frameId: string; revision: number; structureId?: string }>,
  actor: DesignOperationStatus["actor"] = "user",
): DesignOperationStatus => ({
  token: `op-${canvasRevision}`,
  canvasId: "c",
  kind: "update_frame",
  state: "committed",
  actor,
  base: {},
  clientId,
  preparedAt: "",
  updatedAt: "",
  result: {
    canvasRevision,
    frames: frames.map(({ frameId, revision, structureId }) => ({
      frameId,
      revision,
      ...(structureId ? { identity: { structureId, contentId: "c", viewportId: "v" } } : {}),
    })),
  },
});

const move = (frameRevision: number, extra: Partial<DesignOperationDescriptor> = {}) =>
  ({
    input: { kind: "update_frame", frameId: "f", patch: { x: 1 } },
    preconditions: { frameRevision },
    clientId: "a",
    ...extra,
  }) as DesignOperationDescriptor;

describe("rebaseOverOwnCommits", () => {
  test("advances a frame base only along the same client's committed chain", () => {
    const commits = [
      commit("a", 5, [{ frameId: "f", revision: 2 }]),
      commit("a", 6, [{ frameId: "f", revision: 3 }]),
    ];
    expect(rebaseOverOwnCommits(move(1), commits).preconditions.frameRevision).toBe(3);
    expect(
      rebaseOverOwnCommits(move(1, { clientId: "b" }), commits).preconditions.frameRevision,
    ).toBe(1);
    expect(rebaseOverOwnCommits(move(1, { clientId: undefined }), commits)).toEqual(
      move(1, { clientId: undefined }),
    );
    const agent = [commit("a", 5, [{ frameId: "f", revision: 2 }], "agent")];
    expect(rebaseOverOwnCommits(move(1), agent).preconditions.frameRevision).toBe(1);
  });

  test("a structure change in the chain stops a selector edit's rebase", () => {
    const commits = [
      commit("a", 5, [{ frameId: "f", revision: 2, structureId: "s1" }]),
      commit("a", 6, [{ frameId: "f", revision: 3, structureId: "s2" }]),
    ];
    const rebased = rebaseOverOwnCommits(
      move(1, { preconditions: { frameRevision: 1, structureId: "s1" } }),
      commits,
    );
    expect(rebased.preconditions.frameRevision).toBe(2);
  });

  test("with the current state, a chain that does not land on it is not used", () => {
    const commits = [commit("a", 5, [{ frameId: "f", revision: 2 }])];
    const current = (revision: number, canvasRevision = 5) => ({
      canvasRevision,
      frames: new Map([["f", { revision }]]),
    });
    expect(rebaseOverOwnCommits(move(1), commits, current(2)).preconditions.frameRevision).toBe(2);
    // Another writer moved the frame on after the own commit: keep the declared base.
    expect(rebaseOverOwnCommits(move(1), commits, current(3)).preconditions.frameRevision).toBe(1);
    const canvasOp = {
      input: { kind: "undo" },
      preconditions: { canvasRevision: 4 },
      clientId: "a",
    } as DesignOperationDescriptor;
    expect(
      rebaseOverOwnCommits(canvasOp, commits, current(2, 5)).preconditions.canvasRevision,
    ).toBe(5);
    expect(
      rebaseOverOwnCommits(canvasOp, commits, current(2, 6)).preconditions.canvasRevision,
    ).toBe(4);
  });

  test("lanes: frame work queues per frame, canvas-wide work in the canvas lane", () => {
    expect(designIntentLane({ kind: "update_frame", frameId: "f", patch: {} })).toBe("f");
    expect(designIntentLane({ kind: "delete_frame", frameId: "f" })).toBe("canvas");
    expect(designIntentLane({ kind: "undo" })).toBe("canvas");
  });
});
