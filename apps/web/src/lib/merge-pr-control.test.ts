import { describe, expect, test } from "bun:test";
import { mergePrControl, type MergePrControlEnvironment } from "./merge-pr-control";

function environment(
  overrides: Partial<MergePrControlEnvironment> = {},
): MergePrControlEnvironment {
  return {
    prUrl: "https://github.com/acme/repo/pull/7",
    prState: "open",
    hasMergeConflicts: false,
    environmentType: "containerized",
    status: "running",
    ...overrides,
  };
}

describe("mergePrControl", () => {
  test("is pressable for an open, conflict-free PR on a running container", () => {
    expect(mergePrControl(environment(), { dockerAvailable: true })).toEqual({ disabled: false });
  });

  test("is hidden without a PR, once it is finished, or until GitHub confirms no conflicts", () => {
    const options = { dockerAvailable: true };
    expect(mergePrControl(environment({ prUrl: null }), options)).toBeNull();
    expect(mergePrControl(environment({ prState: "merged" }), options)).toBeNull();
    expect(mergePrControl(environment({ prState: "closed" }), options)).toBeNull();
    expect(mergePrControl(environment({ hasMergeConflicts: true }), options)).toBeNull();
    expect(mergePrControl(environment({ hasMergeConflicts: null }), options)).toBeNull();
  });

  test("is disabled while the environment is not ready", () => {
    expect(mergePrControl(environment({ status: "stopped" }), { dockerAvailable: true })).toEqual({
      disabled: true,
    });
    expect(mergePrControl(environment(), { dockerAvailable: false })).toEqual({ disabled: true });
    const local = environment({ environmentType: "local", status: "stopped" });
    expect(mergePrControl(local, { dockerAvailable: false })).toEqual({ disabled: true });
    expect(
      mergePrControl({ ...local, worktreePath: "/tmp/worktree" }, { dockerAvailable: false }),
    ).toEqual({ disabled: false });
  });

  test("is disabled while a merge is in flight", () => {
    expect(mergePrControl(environment(), { dockerAvailable: true, merging: true })).toEqual({
      disabled: true,
    });
    expect(
      mergePrControl(environment({ lifecycleOperation: "merging" }), { dockerAvailable: true }),
    ).toEqual({ disabled: true });
  });
});
