import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_GIT_BASELINE_MAX_PATHS,
  isWorkspaceGitBaseline,
} from "@orkestrator/protocol/workspace-guard";
import type { ReviewWorktreeSnapshot } from "./build-pipeline-prompts.js";
import {
  WorkspaceBaselineUnavailableError,
  WorkspaceReadOnlyGuard,
  WorkspaceReadOnlyViolationError,
  commandWorkspaceProbe,
  compareWorkspace,
  readOnlyAcceptanceCheck,
  readOnlyViolationMessage,
  readOnlyViolationRefusal,
} from "./workspace-read-only-guard.js";

const HEAD = "1".repeat(40);
const MOVED = "2".repeat(40);
const SUBJECT = { stage: "Review", activity: "review" };

function guardOver(state: { snapshot: ReviewWorktreeSnapshot; probes: string[] }) {
  return new WorkspaceReadOnlyGuard(async (environmentId) => {
    state.probes.push(environmentId);
    return state.snapshot;
  });
}

describe("WorkspaceReadOnlyGuard", () => {
  test("captures HEAD and the uncommitted paths as a valid persisted baseline", async () => {
    const state = {
      snapshot: { status: "dirty", head: HEAD, paths: ["notes/a.md"] } as ReviewWorktreeSnapshot,
      probes: [] as string[],
    };
    const { baseline, snapshot } = await guardOver(state).capture("env-1", SUBJECT);
    expect(baseline).toMatchObject({ head: HEAD, paths: ["notes/a.md"] });
    expect(isWorkspaceGitBaseline(baseline)).toBe(true);
    expect(snapshot).toBe(state.snapshot as never);
    expect(state.probes).toEqual(["env-1"]);
  });

  test("fails closed before dispatch when the state cannot be observed or recorded", async () => {
    const unknown = guardOver({
      snapshot: { status: "unknown", reason: "probe failed (timeout)" },
      probes: [],
    });
    const error = await unknown.capture("env-1", SUBJECT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceBaselineUnavailableError);
    expect((error as Error).message).toBe(
      "Review cannot start because the backend could not establish the environment Git state: probe failed (timeout)",
    );

    const tooMany = guardOver({
      snapshot: {
        status: "dirty",
        head: HEAD,
        paths: Array.from({ length: WORKSPACE_GIT_BASELINE_MAX_PATHS + 1 }, (_, i) => `f${i}`),
      },
      probes: [],
    });
    expect(
      await tooMany.capture("env-1", SUBJECT).catch((caught: unknown) => caught),
    ).toBeInstanceOf(WorkspaceBaselineUnavailableError);
  });

  test("refuses a change at submit time and accepts once it is repaired", async () => {
    const state = {
      snapshot: { status: "clean", head: HEAD } as ReviewWorktreeSnapshot,
      probes: [] as string[],
    };
    const guard = guardOver(state);
    const { baseline } = await guard.capture("env-1", SUBJECT);

    state.snapshot = { status: "clean", head: MOVED };
    const refusal = await guard.refusal("env-1", baseline, SUBJECT);
    expect(refusal).toMatchObject({ code: "worktree_changed", nextAction: "correct" });
    expect(refusal?.message).toContain(`HEAD moved from \`${HEAD}\` to \`${MOVED}\` during review`);
    expect(refusal?.message).toContain("Review must not commit, check out or reset.");

    state.snapshot = { status: "clean", head: HEAD };
    expect(await guard.refusal("env-1", baseline, SUBJECT)).toBeNull();
  });

  test("certifies on consumption, keeping the change as the error's evidence", async () => {
    const state = {
      snapshot: {
        status: "dirty",
        head: HEAD,
        paths: ["kept.md", "new.md"],
      } as ReviewWorktreeSnapshot,
      probes: [] as string[],
    };
    const guard = guardOver(state);
    const baseline = { head: HEAD, paths: ["kept.md"] };
    const error = await guard
      .certify("env-1", baseline, SUBJECT)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceReadOnlyViolationError);
    expect((error as WorkspaceReadOnlyViolationError).change).toEqual({
      kind: "added",
      paths: ["new.md"],
    });
    expect((error as Error).message).toBe(
      "Review cannot be certified because review left 1 uncommitted path that was not there when it started: new.md",
    );

    state.snapshot = { status: "dirty", head: HEAD, paths: ["kept.md"] };
    await guard.certify("env-1", baseline, SUBJECT);
  });

  test("repairableOnly ignores states the model could not have fixed", async () => {
    const state = {
      snapshot: { status: "unknown", reason: "probe failed" } as ReviewWorktreeSnapshot,
      probes: [] as string[],
    };
    const guard = guardOver(state);
    await guard.certify("env-1", { head: HEAD, paths: [] }, SUBJECT, { repairableOnly: true });
    expect(
      await guard.certify("env-1", { head: HEAD, paths: [] }, SUBJECT).catch((e: unknown) => e),
    ).toBeInstanceOf(WorkspaceReadOnlyViolationError);
    // Without a baseline nothing is probed: there is nothing to compare.
    const probes = state.probes.length;
    await expect(guard.certify("env-1", null, SUBJECT)).rejects.toThrow(
      "Review cannot be certified because its starting Git state was not recorded",
    );
    expect(await guard.refusal("env-1", null, SUBJECT)).toBeNull();
    expect(state.probes).toHaveLength(probes);
  });

  test("probes through the backend command with bounded retries", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    let failures = 2;
    const probe = commandWorkspaceProbe(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (failures-- > 0) throw new Error("busy");
        return { head: HEAD, paths: [] } as T;
      },
      3,
    );
    expect(await probe("env-1")).toEqual({ status: "clean", head: HEAD });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      command: "get_environment_uncommitted_paths",
      args: { environmentId: "env-1" },
    });
  });
});

describe("compareWorkspace", () => {
  const baseline = { head: HEAD, paths: ["left.md"] };

  test("judges against the baseline path set, not cleanliness", () => {
    expect(compareWorkspace(baseline, { status: "dirty", head: HEAD, paths: ["left.md"] })).toEqual(
      { kind: "unchanged" },
    );
    expect(compareWorkspace(baseline, { status: "clean", head: HEAD })).toEqual({
      kind: "removed",
      paths: ["left.md"],
    });
    expect(compareWorkspace(baseline, { status: "clean", head: MOVED })).toEqual({
      kind: "head",
      before: HEAD,
      after: MOVED,
    });
    expect(compareWorkspace(null, { status: "clean", head: HEAD })).toEqual({ kind: "unrecorded" });
    expect(compareWorkspace(baseline, { status: "unknown", reason: "x" })).toEqual({
      kind: "unknown",
      reason: "x",
    });
  });

  test("names the activity in person-facing and model-facing text", () => {
    const subject = { stage: "Review consolidation", activity: "consolidation" };
    expect(readOnlyViolationMessage(subject, { kind: "head", before: HEAD, after: MOVED })).toBe(
      "Review consolidation cannot be certified because consolidation changed the environment HEAD",
    );
    expect(
      readOnlyViolationRefusal(subject, { kind: "removed", paths: ["left.md"] })?.message,
    ).toContain("Consolidation removed 1 uncommitted path");
    expect(readOnlyViolationRefusal(subject, { kind: "unknown", reason: "x" })).toBeNull();
  });
});

describe("readOnlyAcceptanceCheck", () => {
  test("judges only the attempts its owner resolves", async () => {
    const state = {
      snapshot: { status: "clean", head: MOVED } as ReviewWorktreeSnapshot,
      probes: [] as string[],
    };
    const check = readOnlyAcceptanceCheck(guardOver(state), async (attempt) =>
      attempt.resultKey === "owned"
        ? {
            environmentId: attempt.environmentId,
            baseline: { head: HEAD, paths: [] },
            subject: SUBJECT,
          }
        : null,
    );
    const attempt = {
      kind: "review-report" as const,
      environmentId: "env-1",
      projectId: "project-1",
    };
    expect(await check({ ...attempt, resultKey: "owned" })).toMatchObject({
      code: "worktree_changed",
    });
    expect(await check({ ...attempt, resultKey: "someone-else" })).toBeNull();
    expect(state.probes).toEqual(["env-1"]);
  });
});
