import { describe, expect, test } from "bun:test";
import type { ProjectGitStatus } from "./coordinator.js";
import {
  behindFastForwardBlocker,
  canFastForwardUpstream,
  decideUpstreamMergeOffer,
  parseCoordinatorUpstreamAutoMerge,
  parseCoordinatorUpstreamMergeCheck,
} from "./coordinator-upstream-merge.js";

const tip = "b".repeat(40);
const behind: ProjectGitStatus = {
  projectId: "project-1",
  repositoryRoot: "/checkout",
  revision: 1,
  branch: "main",
  detached: false,
  unborn: false,
  headCommit: "a".repeat(40),
  upstream: "origin/main",
  upstreamCommit: tip,
  remote: "origin",
  ahead: 0,
  behind: 2,
  remoteState: "fresh",
  fetchedAt: new Date(0).toISOString(),
  trackedChanges: 0,
  untrackedChanges: 0,
  conflicts: 0,
  mergeInProgress: false,
  rebaseInProgress: false,
  sequencerInProgress: false,
  operationState: "idle",
  repositoryOperationBlockedReason: null,
  branches: [],
  lastError: null,
};

describe("canFastForwardUpstream", () => {
  test("is true when the checkout can fast-forward to unmerged upstream commits", () => {
    expect(canFastForwardUpstream(behind)).toBe(true);
  });

  test.each([
    ["no status", null],
    ["no upstream", { ...behind, upstream: null, behind: null }],
    ["up to date", { ...behind, behind: 0 }],
    ["unknown distance", { ...behind, behind: null }],
  ])("is false with %s", (_label, status) => {
    expect(canFastForwardUpstream(status)).toBe(false);
  });

  test.each([
    ["local commits", { ...behind, ahead: 1 }, "the branches have diverged"],
    ["tracked changes", { ...behind, trackedChanges: 1 }, "uncommitted changes"],
    ["untracked files", { ...behind, untrackedChanges: 3 }, "uncommitted changes"],
    [
      "an unfinished operation",
      { ...behind, mergeInProgress: true, repositoryOperationBlockedReason: "Finish the merge." },
      "Finish the merge.",
    ],
  ])("is false when %s block the fast-forward", (_label, status, reason) => {
    expect(behindFastForwardBlocker(status)).toContain(reason);
    expect(canFastForwardUpstream(status)).toBe(false);
  });
});

describe("decideUpstreamMergeOffer", () => {
  test("always merges a checkout that can fast-forward, without asking", () => {
    expect(decideUpstreamMergeOffer(behind)).toEqual({
      offer: true,
      status: behind,
      automatic: true,
    });
  });

  test("names why it does not merge", () => {
    expect(decideUpstreamMergeOffer(null)).toMatchObject({ reason: "no-status" });
    expect(decideUpstreamMergeOffer({ ...behind, behind: 0 })).toMatchObject({
      offer: false,
      reason: "not-behind",
    });
    expect(decideUpstreamMergeOffer({ ...behind, ahead: 1 })).toMatchObject({
      offer: false,
      reason: "blocked",
    });
    expect(decideUpstreamMergeOffer({ ...behind, trackedChanges: 2 })).toMatchObject({
      offer: false,
      reason: "blocked",
    });
  });

  test("answers parse back, and malformed ones are refused", () => {
    expect(
      parseCoordinatorUpstreamMergeCheck({ offer: true, status: behind, automatic: true }),
    ).toEqual({ offer: true, status: behind, automatic: true });
    expect(
      parseCoordinatorUpstreamMergeCheck({ offer: true, status: behind, automatic: "yes" }),
    ).toEqual({ offer: true, status: behind });
    expect(parseCoordinatorUpstreamAutoMerge({ enabled: true })).toEqual({ enabled: true });
    expect(parseCoordinatorUpstreamAutoMerge({ enabled: "true" })).toBeNull();
    expect(parseCoordinatorUpstreamAutoMerge(null)).toBeNull();
    expect(parseCoordinatorUpstreamMergeCheck({ offer: true, status: behind })).toEqual({
      offer: true,
      status: behind,
    });
    expect(
      parseCoordinatorUpstreamMergeCheck({ offer: false, reason: "turn-running", status: null }),
    ).toEqual({ offer: false, reason: "turn-running", status: null });
    expect(parseCoordinatorUpstreamMergeCheck({ offer: true })).toBeNull();
    expect(parseCoordinatorUpstreamMergeCheck({ offer: false, reason: "other" })).toBeNull();
    expect(parseCoordinatorUpstreamMergeCheck(undefined)).toBeNull();
  });
});
