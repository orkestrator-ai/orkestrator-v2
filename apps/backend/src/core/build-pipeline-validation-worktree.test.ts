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

  test("reports added paths first when paths were also removed", () => {
    expect(
      compareValidationWorktree(started, {
        status: "dirty",
        head: HEAD,
        paths: ["new.txt"],
      }),
    ).toEqual({ kind: "added", paths: ["new.txt"] });
    // Once additions are repaired, the missing baseline paths remain a violation.
    expect(compareValidationWorktree(started, { status: "clean", head: HEAD })).toEqual({
      kind: "removed",
      paths: ["notes/scratch.md"],
    });
  });

  test("preserves an unknown probe reason when a baseline exists", () => {
    expect(
      compareValidationWorktree(started, { status: "unknown", reason: "probe failed" }),
    ).toEqual({
      kind: "unknown",
      reason: "probe failed",
    });
    expect(compareValidationWorktree({}, { status: "unknown", reason: "probe failed" })).toEqual({
      kind: "unrecorded",
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

  test("explains how to restore HEAD and removed baseline paths", () => {
    const head = validationWorktreeRefusal({ kind: "head", before: HEAD, after: MOVED });
    expect(head).toMatchObject({ code: "worktree_changed", nextAction: "correct" });
    expect(head?.message).toContain(`HEAD moved from \`${HEAD}\` to \`${MOVED}\``);
    expect(head?.message).toContain(`Put HEAD back on \`${HEAD}\` without discarding any work`);
    for (const paths of [["leftover.txt"], ["leftover.txt", "odd`name"]]) {
      const removed = validationWorktreeRefusal({ kind: "removed", paths });
      expect(removed).toMatchObject({ code: "worktree_changed", nextAction: "correct" });
      expect(removed?.message).toContain("- `leftover.txt`");
      expect(removed?.message).toContain(
        paths.length === 1 ? "Restore it exactly as it was" : "Restore them exactly as they were",
      );
      if (paths.length > 1) expect(removed?.message).toContain("- `odd'name`");
    }
  });

  test("bounds added and removed refusal lists to fifty paths", () => {
    const paths = Array.from({ length: 52 }, (_, index) => `file-${index}.txt`);
    for (const kind of ["added", "removed"] as const) {
      const refusal = validationWorktreeRefusal({ kind, paths });
      expect(refusal?.message).toContain("52 uncommitted paths");
      expect(refusal?.message).toContain("- `file-49.txt`");
      expect(refusal?.message).not.toContain("file-50.txt");
      expect(refusal?.message).not.toContain("file-51.txt");
      expect(refusal?.message).toContain("- …and 2 more.");
    }
  });

  test("leaves states the model cannot repair to the supervisor", () => {
    expect(validationWorktreeRefusal({ kind: "unchanged" })).toBeNull();
    expect(validationWorktreeRefusal({ kind: "unrecorded" })).toBeNull();
    expect(validationWorktreeRefusal({ kind: "unknown", reason: "probe failed" })).toBeNull();
  });
});

describe("validationWorktreeError", () => {
  test("explains unknown, unrecorded, HEAD and removed-path failures", () => {
    expect(validationWorktreeError("Verification", { kind: "unrecorded" })).toContain(
      "starting Git state was not recorded",
    );
    expect(
      validationWorktreeError("Verification", { kind: "unknown", reason: "probe failed" }),
    ).toContain("could not verify Git state after validation: probe failed");
    expect(
      validationWorktreeError("Verification", { kind: "head", before: HEAD, after: MOVED }),
    ).toContain("validation changed the environment HEAD");
    expect(
      validationWorktreeError("Verification", { kind: "removed", paths: ["leftover.txt"] }),
    ).toBe(
      "Verification cannot be certified because validation removed 1 uncommitted path that was there when it started: leftover.txt",
    );
    const paths = Array.from({ length: 7 }, (_, index) => `file-${index}.txt`);
    for (const kind of ["added", "removed"] as const) {
      const error = validationWorktreeError("Verification", { kind, paths });
      expect(error).toContain("7 uncommitted paths");
      expect(error).toContain("file-4.txt and 2 more");
      expect(error).not.toContain("file-5.txt");
    }
  });

  test("is null for an unchanged worktree and names one path in the singular", () => {
    expect(validationWorktreeError("Verification", { kind: "unchanged" })).toBeNull();
    expect(validationWorktreeError("Review", { kind: "added", paths: ["a.txt"] })).toBe(
      "Review cannot be certified because validation left 1 uncommitted path that was not there when it started: a.txt",
    );
  });
});
