import { describe, expect, test } from "bun:test";
import {
  compareValidationWorktree,
  hasValidationBaseline,
  validationWorktreeError,
  validationWorktreeRefusal,
} from "./build-pipeline-validation-worktree.js";

const HEAD = "1".repeat(40);
const MOVED = "2".repeat(40);

describe("compareValidationWorktree", () => {
  const started = {
    validationHeadAtStart: HEAD,
    validationWorktreeStatusAtStart: "dirty" as const,
    validationUncommittedPathsAtStart: ["notes/scratch.md"],
  };

  test("keeps paths the stage started with", () => {
    expect(
      compareValidationWorktree(started, {
        status: "dirty",
        head: HEAD,
        paths: ["notes/scratch.md"],
      }),
    ).toEqual({ kind: "unchanged" });
  });

  test("reports what validation added or removed", () => {
    expect(
      compareValidationWorktree(started, {
        status: "dirty",
        head: HEAD,
        paths: ["notes/scratch.md", "packages/protocol/protocol"],
      }),
    ).toEqual({ kind: "added", paths: ["packages/protocol/protocol"] });
    expect(compareValidationWorktree(started, { status: "clean", head: HEAD })).toEqual({
      kind: "removed",
      paths: ["notes/scratch.md"],
    });
    expect(compareValidationWorktree(started, { status: "clean", head: MOVED })).toEqual({
      kind: "head",
      before: HEAD,
      after: MOVED,
    });
  });

  test("pins a legacy clean baseline to no paths and refuses a legacy dirty one", () => {
    const legacyClean = {
      validationHeadAtStart: HEAD,
      validationWorktreeStatusAtStart: "clean" as const,
    };
    expect(hasValidationBaseline(legacyClean)).toBe(true);
    expect(compareValidationWorktree(legacyClean, { status: "clean", head: HEAD })).toEqual({
      kind: "unchanged",
    });
    const legacyDirty = {
      validationHeadAtStart: HEAD,
      validationWorktreeStatusAtStart: "dirty" as const,
    };
    expect(hasValidationBaseline(legacyDirty)).toBe(false);
    expect(compareValidationWorktree(legacyDirty, { status: "clean", head: HEAD })).toEqual({
      kind: "unrecorded",
    });
  });
});

describe("validationWorktreeRefusal", () => {
  test("names each added path to the model, fenced as code", () => {
    const refusal = validationWorktreeRefusal({
      kind: "added",
      paths: ["packages/protocol/protocol", "odd`name"],
    });
    expect(refusal).toMatchObject({ code: "worktree_changed", nextAction: "correct" });
    expect(refusal?.message).toContain("- `packages/protocol/protocol`");
    expect(refusal?.message).toContain("- `odd'name`");
    expect(refusal?.message).toContain("Do not commit, stash, reset or delete");
  });

  test("leaves states the model cannot repair to the supervisor", () => {
    expect(validationWorktreeRefusal({ kind: "unchanged" })).toBeNull();
    expect(validationWorktreeRefusal({ kind: "unrecorded" })).toBeNull();
    expect(validationWorktreeRefusal({ kind: "unknown", reason: "probe failed" })).toBeNull();
  });
});

describe("validationWorktreeError", () => {
  test("is null for an unchanged worktree and names one path in the singular", () => {
    expect(validationWorktreeError("Verification", { kind: "unchanged" })).toBeNull();
    expect(validationWorktreeError("Review", { kind: "added", paths: ["a.txt"] })).toBe(
      "Review cannot be certified because validation left 1 uncommitted path that was not there when it started: a.txt",
    );
  });
});
