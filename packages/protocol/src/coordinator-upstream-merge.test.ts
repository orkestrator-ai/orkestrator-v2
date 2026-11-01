import { describe, expect, test } from "bun:test";
import type { ProjectGitStatus } from "./coordinator.js";
import {
  behindFastForwardBlocker,
  decideUpstreamMergeOffer,
  parseCoordinatorUpstreamMergeCheck,
  shouldOfferUpstreamMerge,
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

describe("shouldOfferUpstreamMerge", () => {
  test("asks when the checkout can fast-forward to unmerged upstream commits", () => {
    expect(shouldOfferUpstreamMerge(behind, undefined)).toBe(true);
  });

  test.each([
    ["no status", null],
    ["no upstream", { ...behind, upstream: null, behind: null }],
    ["up to date", { ...behind, behind: 0 }],
    ["unknown distance", { ...behind, behind: null }],
  ])("does not ask with %s", (_label, status) => {
    expect(shouldOfferUpstreamMerge(status, undefined)).toBe(false);
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
  ])("does not ask when %s block the fast-forward", (_label, status, reason) => {
    expect(behindFastForwardBlocker(status)).toContain(reason);
    expect(shouldOfferUpstreamMerge(status, undefined)).toBe(false);
  });

  test("a decline holds while the upstream tip is unchanged", () => {
    expect(shouldOfferUpstreamMerge(behind, { upstream: "origin/main", upstreamCommit: tip })).toBe(
      false,
    );
    // More local catch-up does not change the answer for the same tip.
    expect(
      shouldOfferUpstreamMerge(
        { ...behind, behind: 1 },
        { upstream: "origin/main", upstreamCommit: tip },
      ),
    ).toBe(false);
  });

  test("asks again once a new upstream commit arrives", () => {
    const declined = { upstream: "origin/main", upstreamCommit: tip };
    expect(shouldOfferUpstreamMerge({ ...behind, upstreamCommit: "c".repeat(40) }, declined)).toBe(
      true,
    );
  });

  test("a decline for another upstream does not apply", () => {
    expect(
      shouldOfferUpstreamMerge(behind, { upstream: "origin/release", upstreamCommit: tip }),
    ).toBe(true);
  });

  test("a status without the upstream tip cannot match a decline, so it asks", () => {
    const { upstreamCommit: _omitted, ...legacy } = behind;
    expect(shouldOfferUpstreamMerge(legacy, { upstream: "origin/main", upstreamCommit: tip })).toBe(
      true,
    );
  });
});

describe("decideUpstreamMergeOffer", () => {
  test("names why it does not ask", () => {
    expect(decideUpstreamMergeOffer(behind, null)).toEqual({ offer: true, status: behind });
    expect(decideUpstreamMergeOffer(null, null)).toMatchObject({ reason: "no-status" });
    expect(decideUpstreamMergeOffer({ ...behind, behind: 0 }, null)).toMatchObject({
      reason: "not-behind",
    });
    expect(decideUpstreamMergeOffer({ ...behind, ahead: 1 }, null)).toMatchObject({
      reason: "blocked",
    });
    expect(
      decideUpstreamMergeOffer(behind, { upstream: "origin/main", upstreamCommit: tip }),
    ).toMatchObject({ offer: false, reason: "declined" });
  });

  test("answers parse back, and malformed ones are refused", () => {
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
