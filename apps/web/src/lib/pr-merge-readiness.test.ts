import { describe, expect, test } from "bun:test";
import { toNodeEnvironmentSummary } from "@orkestrator/protocol/node-summaries";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import {
  describeAutoMergeHold,
  isLocalEnvironmentReadyToMerge,
  isNodeEnvironmentReadyToMerge,
  localEnvironmentPrMergeState,
  nodeEnvironmentPrMergeState,
  type ReadyToMergeEnvironment,
} from "./pr-merge-readiness";

const PR = "https://github.com/acme/repo/pull/7";

function environment(overrides: Partial<ReadyToMergeEnvironment> = {}): ReadyToMergeEnvironment {
  return {
    prUrl: PR,
    prState: "open",
    hasMergeConflicts: false,
    prMergeability: "clean",
    environmentType: "local",
    status: "stopped",
    ...overrides,
  };
}

function monitor(overrides: Partial<PrMonitorEnvironmentState> = {}): PrMonitorEnvironmentState {
  return {
    environmentId: "env-1",
    mode: "normal",
    checkInProgress: false,
    consecutiveErrors: 0,
    lastCheckAt: "2026-10-28T10:00:00.000Z",
    lastSuccessfulCheckAt: "2026-10-28T10:00:00.000Z",
    prUrl: PR,
    prState: "open",
    hasMergeConflicts: false,
    checkSummary: { passed: 2, total: 2, pending: 0 },
    ...overrides,
  };
}

describe("isLocalEnvironmentReadyToMerge", () => {
  test("a current, answered reading of a clean PR is ready", () => {
    expect(isLocalEnvironmentReadyToMerge(environment(), monitor(), "current", true)).toBe(true);
    // A running container can be polled too.
    expect(
      isLocalEnvironmentReadyToMerge(
        environment({ environmentType: "containerized", status: "running" }),
        monitor(),
        "current",
        true,
      ),
    ).toBe(true);
  });

  test.each([
    ["the mirror is hydrating", {}, {}, "hydrating"],
    ["the mirror is stale", {}, {}, "stale"],
    ["the mirror is degraded", {}, {}, "degraded"],
    ["the last check failed", {}, { consecutiveErrors: 1 }, "current"],
    ["no check answered yet in this backend", {}, { lastSuccessfulCheckAt: null }, "current"],
    ["an older backend without the field", {}, { lastSuccessfulCheckAt: undefined }, "current"],
    ["the monitor is on another PR", {}, { prUrl: `${PR}0` }, "current"],
    ["the two mirrors disagree on state", {}, { prState: "merged" }, "current"],
    ["a stopped container", { environmentType: "containerized", status: "stopped" }, {}, "current"],
    ["a check is failing", {}, { checkSummary: { passed: 1, total: 2, pending: 0 } }, "current"],
    ["a check is pending", {}, { checkSummary: { passed: 1, total: 2, pending: 1 } }, "current"],
    ["GitHub blocks the merge", { prMergeability: "blocked" }, {}, "current"],
    ["an older backend without a merge state", { prMergeability: undefined }, {}, "current"],
    ["it was merged", { prState: "merged" }, { prState: "merged" }, "current"],
    ["it has conflicts", { hasMergeConflicts: true }, {}, "current"],
    ["a newer monitor reading has conflicts", {}, { hasMergeConflicts: true }, "current"],
    ["the monitor conflict reading is unknown", {}, { hasMergeConflicts: null }, "current"],
    ["the merging credential lacks push access", {}, { viewerCanMerge: false }, "current"],
  ] as const)("not ready when %s", (_label, environmentOverrides, monitorOverrides, sync) => {
    expect(
      isLocalEnvironmentReadyToMerge(
        environment(environmentOverrides as Partial<ReadyToMergeEnvironment>),
        monitor(monitorOverrides as Partial<PrMonitorEnvironmentState>),
        sync,
        true,
      ),
    ).toBe(false);
  });

  test("not ready without a monitor entry", () => {
    expect(isLocalEnvironmentReadyToMerge(environment(), null, "current", true)).toBe(false);
  });

  test("an unknown merge permission does not hide readiness", () => {
    for (const viewerCanMerge of [null, undefined, true]) {
      expect(
        isLocalEnvironmentReadyToMerge(environment(), monitor({ viewerCanMerge }), "current", true),
      ).toBe(true);
    }
  });

  describe("with auto-merge's Require checks to pass off", () => {
    test("checks GitHub does not require no longer hold the shimmer back", () => {
      for (const [environmentOverrides, monitorOverrides] of [
        // A non-required check failing or still running.
        [{ prMergeability: "unstable" }, { checkSummary: { passed: 13, total: 14, pending: 0 } }],
        [{ prMergeability: "unstable" }, { checkSummary: { passed: 1, total: 2, pending: 1 } }],
        [{}, { checkSummary: { passed: 1, total: 2, pending: 0 } }],
      ] as const) {
        const args = [
          environment(environmentOverrides as Partial<ReadyToMergeEnvironment>),
          monitor(monitorOverrides as Partial<PrMonitorEnvironmentState>),
          "current",
        ] as const;
        expect(isLocalEnvironmentReadyToMerge(...args, false)).toBe(true);
        // The default still waits for every check.
        expect(isLocalEnvironmentReadyToMerge(...args, true)).toBe(false);
      }
    });

    test.each([
      ["GitHub blocks the merge (a required check)", { prMergeability: "blocked" }, {}, "current"],
      ["it has conflicts", { hasMergeConflicts: true }, {}, "current"],
      ["a draft", { prMergeability: "unavailable" }, {}, "current"],
      ["the mirror is stale", { prMergeability: "unstable" }, {}, "stale"],
      ["the merging credential lacks push access", {}, { viewerCanMerge: false }, "current"],
    ] as const)(
      "still not ready when %s",
      (_label, environmentOverrides, monitorOverrides, sync) => {
        expect(
          isLocalEnvironmentReadyToMerge(
            environment(environmentOverrides as Partial<ReadyToMergeEnvironment>),
            monitor(monitorOverrides as Partial<PrMonitorEnvironmentState>),
            sync,
            false,
          ),
        ).toBe(false);
      },
    );
  });
});

describe("localEnvironmentPrMergeState", () => {
  const conflicted = environment({ hasMergeConflicts: true, prMergeability: "dirty" });

  test("a current reading of a conflicted PR has conflicts", () => {
    expect(localEnvironmentPrMergeState(environment(), monitor(), "current", true)).toBe("ready");
    expect(
      localEnvironmentPrMergeState(
        conflicted,
        monitor({ hasMergeConflicts: true }),
        "current",
        true,
      ),
    ).toBe("conflicts");
  });

  test.each([
    ["the mirror is stale", {}, "stale"],
    ["the last check failed", { consecutiveErrors: 1 }, "current"],
    ["the monitor has not seen the conflict yet", { hasMergeConflicts: false }, "current"],
    ["the monitor is on another PR", { prUrl: `${PR}0` }, "current"],
  ] as const)("no conflicts signal when %s", (_label, monitorOverrides, sync) => {
    expect(
      localEnvironmentPrMergeState(
        conflicted,
        monitor({ hasMergeConflicts: true, ...monitorOverrides }),
        sync,
        true,
      ),
    ).toBeNull();
  });

  test("a merged or blocked PR has neither signal", () => {
    expect(
      localEnvironmentPrMergeState(
        environment({ prState: "merged" }),
        monitor({ prState: "merged" }),
        "current",
        true,
      ),
    ).toBeNull();
    expect(
      localEnvironmentPrMergeState(
        environment({ prMergeability: "blocked" }),
        monitor(),
        "current",
        true,
      ),
    ).toBeNull();
  });
});

describe("isNodeEnvironmentReadyToMerge", () => {
  const live = { transport: "connected", freshness: "current" } as const;

  function remote(overrides: Partial<FederatedEnvironment> = {}): FederatedEnvironment {
    return {
      ref: { backendId: "bk_leaf", environmentId: "env-1" },
      key: "bk_leaf:env-1",
      projectId: "p",
      name: "feature",
      order: 0,
      status: "running",
      activity: "idle",
      hasUnreadWork: false,
      environmentType: "containerized",
      deleting: false,
      isProjectHome: false,
      prState: "open",
      prHasMergeConflicts: false,
      prMergeability: "clean",
      ...overrides,
    } as FederatedEnvironment;
  }

  test("a current clean reading the leaf's monitor vouches for is ready", () => {
    expect(isNodeEnvironmentReadyToMerge(remote({ prMonitorConfirmed: true }), live, true)).toBe(
      true,
    );
    expect(nodeEnvironmentPrMergeState(remote({ prMonitorConfirmed: true }), live, true)).toBe(
      "ready",
    );
  });

  test("an unconfirmed reading is never ready, even when current and clean", () => {
    // Identical persisted summaries can follow a failed detection, expired
    // credentials, or a restart before the first successful detection. A leaf
    // that predates the relay never sends the flag.
    expect(isNodeEnvironmentReadyToMerge(remote(), live, true)).toBe(false);
  });

  test("confirmed conflicts show as conflicts; unconfirmed ones show nothing", () => {
    const conflicted = { prHasMergeConflicts: true } as const;
    expect(
      nodeEnvironmentPrMergeState(remote({ ...conflicted, prMonitorConfirmed: true }), live, true),
    ).toBe("conflicts");
    expect(nodeEnvironmentPrMergeState(remote(conflicted), live, true)).toBeNull();
  });

  test.each([
    ["the machine is unreachable", {}, { transport: "unreachable", freshness: "current" }],
    ["its summaries are stale", {}, { transport: "connected", freshness: "stale" }],
    ["its summaries are catching up", {}, { transport: "connected", freshness: "catching-up" }],
    ["the environment is being deleted", { deleting: true }, live],
    ["a stopped container", { status: "stopped" }, live],
    ["a leaf that predates the fields", { prMergeability: undefined }, live],
    ["no PR", { prState: undefined, prHasMergeConflicts: undefined }, live],
    ["a draft", { prMergeability: "unavailable" }, live],
    ["conflicts", { prHasMergeConflicts: true }, live],
    ["the leaf's credential lacks push access", { prViewerCanMerge: false }, live],
  ] as const)("not ready when %s", (_label, overrides, machine) => {
    expect(
      isNodeEnvironmentReadyToMerge(
        remote({ prMonitorConfirmed: true, ...(overrides as Partial<FederatedEnvironment>) }),
        machine as Parameters<typeof isNodeEnvironmentReadyToMerge>[1],
        true,
      ),
    ).toBe(false);
  });

  test("with Require checks to pass off, a failing optional check still shimmers", () => {
    const failing = remote({
      prMonitorConfirmed: true,
      prMergeability: "unstable",
      prCheckSummary: { passed: 13, total: 14, pending: 0 },
    });
    expect(nodeEnvironmentPrMergeState(failing, live, false)).toBe("ready");
    expect(nodeEnvironmentPrMergeState(failing, live, true)).toBeNull();
    expect(
      nodeEnvironmentPrMergeState(
        remote({ prMonitorConfirmed: true, prMergeability: "blocked" }),
        live,
        false,
      ),
    ).toBeNull();
  });
});

test("leaf check counts survive summary projection and match local readiness across rollup-only transitions", () => {
  const live = { transport: "connected", freshness: "current" } as const;
  for (const checkSummary of [
    { passed: 1, total: 2, pending: 0 },
    { passed: 2, total: 2, pending: 0 },
    { passed: 1, total: 2, pending: 1 },
    { passed: 2, total: 2, pending: 0 },
    { passed: 1, total: 2, pending: 0 },
  ]) {
    const summary = toNodeEnvironmentSummary("bk_leaf" as BackendId, {
      ...environment(),
      id: "env-1",
      projectId: "p",
      name: "feature",
      prMonitorConfirmed: true,
      prCheckSummary: checkSummary,
    });
    const remote = {
      ...summary,
      ref: { backendId: "bk_leaf", environmentId: "env-1" },
    } as FederatedEnvironment;
    expect(nodeEnvironmentPrMergeState(remote, live, true)).toBe(
      localEnvironmentPrMergeState(environment(), monitor({ checkSummary }), "current", true),
    );
    expect(isNodeEnvironmentReadyToMerge(remote, live, true)).toBe(
      checkSummary.passed === checkSummary.total,
    );
  }
});

describe("describeAutoMergeHold", () => {
  test("says nothing when the pull request would merge or there is none", () => {
    expect(describeAutoMergeHold(null, null)).toBeNull();
    expect(describeAutoMergeHold("not-open", null)).toBeNull();
    expect(describeAutoMergeHold("no-pull-request", null)).toBeNull();
  });

  test("failed checks need someone to act and point at the setting", () => {
    const hold = describeAutoMergeHold("checks-failing", { passed: 18, total: 20, pending: 0 });
    expect(hold?.transient).toBe(false);
    expect(hold?.message).toStartWith("2 checks failed, ");
    expect(hold?.message).toContain("Require checks to pass");
  });

  test("GitHub's unstable reading follows the rollup: failed, still running, or unknown", () => {
    expect(
      describeAutoMergeHold("checks-not-passing", { passed: 4, total: 5, pending: 0 }),
    ).toMatchObject({ transient: false, message: expect.stringMatching(/^1 check failed, /) });
    expect(
      describeAutoMergeHold("checks-not-passing", { passed: 3, total: 5, pending: 2 }),
    ).toEqual({ transient: true, message: "Waiting for 2 checks to finish." });
    expect(describeAutoMergeHold("checks-not-passing", null)?.transient).toBe(false);
  });

  test("waits that end by themselves are transient", () => {
    for (const reason of [
      "stale",
      "mergeability-unknown",
      "conflicts",
      "checks-pending",
    ] as const) {
      expect(describeAutoMergeHold(reason, { passed: 1, total: 2, pending: 1 })?.transient).toBe(
        true,
      );
    }
  });

  test("blocked, behind, draft and missing permission need someone to act", () => {
    for (const reason of ["blocked", "behind", "draft", "no-merge-permission"] as const) {
      expect(describeAutoMergeHold(reason, null)?.transient).toBe(false);
    }
  });
});
