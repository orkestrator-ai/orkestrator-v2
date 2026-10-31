import { describe, expect, test } from "bun:test";
import {
  evaluatePrMergeReadiness,
  isPrMergeability,
  isPrMonitorPolled,
  isPrReadingConfirmedByMonitor,
  isPrReadyToMerge,
  mergeabilityFromMergeStateStatus,
  PR_MERGEABILITY_VALUES,
  type PrMergeReadinessSignals,
} from "./pr-merge-readiness.js";
import type { PrMonitorEnvironmentState } from "./pr-monitor.js";

function ready(overrides: Partial<PrMergeReadinessSignals> = {}): PrMergeReadinessSignals {
  return {
    prState: "open",
    hasMergeConflicts: false,
    mergeability: "clean",
    checkSummary: { passed: 3, total: 3, pending: 0 },
    fresh: true,
    ...overrides,
  };
}

describe("evaluatePrMergeReadiness", () => {
  test("an open, clean, conflict-free PR with passing checks is ready", () => {
    expect(evaluatePrMergeReadiness(ready())).toEqual({ ready: true });
    expect(isPrReadyToMerge(ready())).toBe(true);
  });

  test("a missing rollup does not veto a clean merge state", () => {
    // GitHub's merge state already accounts for required checks; the rollup is
    // fetched separately and some tokens cannot read it.
    expect(isPrReadyToMerge(ready({ checkSummary: null }))).toBe(true);
    expect(isPrReadyToMerge(ready({ checkSummary: undefined }))).toBe(true);
    expect(isPrReadyToMerge(ready({ checkSummary: { passed: 0, total: 0, pending: 0 } }))).toBe(
      true,
    );
  });

  test.each([
    ["stale mirror", { fresh: false }, "stale"],
    ["no pull request", { prState: null }, "no-pull-request"],
    ["unknown pull request", { prState: undefined }, "no-pull-request"],
    ["merged", { prState: "merged" }, "not-open"],
    ["closed", { prState: "closed" }, "not-open"],
    ["conflicting", { hasMergeConflicts: true }, "conflicts"],
    ["mergeable not yet computed", { hasMergeConflicts: null }, "mergeability-unknown"],
    ["older backend without the field", { hasMergeConflicts: undefined }, "mergeability-unknown"],
    ["merge state dirty", { mergeability: "dirty" }, "conflicts"],
    ["draft", { mergeability: "unavailable" }, "draft"],
    ["review or required check outstanding", { mergeability: "blocked" }, "blocked"],
    ["behind a base that must be up to date", { mergeability: "behind" }, "behind"],
    ["a non-required check failing or running", { mergeability: "unstable" }, "checks-not-passing"],
    ["merge state still computing", { mergeability: "unknown" }, "mergeability-unknown"],
    ["no merge state recorded", { mergeability: null }, "mergeability-unknown"],
    ["older backend without a merge state", { mergeability: undefined }, "mergeability-unknown"],
    [
      "a failing check in the rollup",
      { checkSummary: { passed: 2, total: 3, pending: 0 } },
      "checks-failing",
    ],
    [
      "a pending check in the rollup",
      { checkSummary: { passed: 2, total: 3, pending: 1 } },
      "checks-pending",
    ],
  ] as const)("%s is not ready", (_label, overrides, reason) => {
    const signals = ready(overrides as Partial<PrMergeReadinessSignals>);
    expect(evaluatePrMergeReadiness(signals)).toEqual({ ready: false, reason });
    expect(isPrReadyToMerge(signals)).toBe(false);
  });

  test("staleness wins over every other signal", () => {
    expect(
      evaluatePrMergeReadiness(ready({ fresh: false, prState: "merged", mergeability: "dirty" })),
    ).toEqual({ ready: false, reason: "stale" });
  });

  test("a credential without push, maintain or admin is not ready", () => {
    expect(evaluatePrMergeReadiness(ready({ viewerCanMerge: false }))).toEqual({
      ready: false,
      reason: "no-merge-permission",
    });
  });

  test("an unknown merge permission does not veto", () => {
    // A cold cache or an older backend must not hide every shimmer.
    expect(isPrReadyToMerge(ready({ viewerCanMerge: null }))).toBe(true);
    expect(isPrReadyToMerge(ready({ viewerCanMerge: undefined }))).toBe(true);
    expect(isPrReadyToMerge(ready({ viewerCanMerge: true }))).toBe(true);
  });

  test("conflicts and failing checks still read as such without merge permission", () => {
    expect(
      evaluatePrMergeReadiness(ready({ viewerCanMerge: false, hasMergeConflicts: true })),
    ).toEqual({ ready: false, reason: "conflicts" });
    expect(
      evaluatePrMergeReadiness(
        ready({ viewerCanMerge: false, checkSummary: { passed: 1, total: 2, pending: 0 } }),
      ),
    ).toEqual({ ready: false, reason: "checks-failing" });
  });

  test("a failing check is reported before a pending one", () => {
    expect(
      evaluatePrMergeReadiness(ready({ checkSummary: { passed: 1, total: 3, pending: 1 } })),
    ).toEqual({ ready: false, reason: "checks-failing" });
  });
});

describe("mergeabilityFromMergeStateStatus", () => {
  test.each([
    ["CLEAN", "clean"],
    ["HAS_HOOKS", "clean"],
    ["BLOCKED", "blocked"],
    ["DIRTY", "dirty"],
    ["BEHIND", "behind"],
    ["UNSTABLE", "unstable"],
    ["DRAFT", "unavailable"],
    ["UNKNOWN", "unknown"],
    ["SOMETHING_NEW", "unknown"],
    ["clean", "clean"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(mergeabilityFromMergeStateStatus(status, false)).toBe(expected);
  });

  test("a draft is unavailable whatever the merge state says", () => {
    expect(mergeabilityFromMergeStateStatus("CLEAN", true)).toBe("unavailable");
    expect(mergeabilityFromMergeStateStatus(undefined, true)).toBe("unavailable");
  });

  test("no merge state is recorded as unobserved, not guessed", () => {
    expect(mergeabilityFromMergeStateStatus(undefined, undefined)).toBeNull();
    expect(mergeabilityFromMergeStateStatus(null, false)).toBeNull();
    expect(mergeabilityFromMergeStateStatus(42, false)).toBeNull();
  });
});

describe("isPrMergeability", () => {
  test("accepts every known value and rejects anything else", () => {
    for (const value of PR_MERGEABILITY_VALUES) expect(isPrMergeability(value)).toBe(true);
    expect(isPrMergeability("CLEAN")).toBe(false);
    expect(isPrMergeability("")).toBe(false);
    expect(isPrMergeability(null)).toBe(false);
    expect(isPrMergeability(1)).toBe(false);
  });
});

describe("isPrReadingConfirmedByMonitor", () => {
  const environment = {
    prUrl: "https://github.com/o/r/pull/1",
    prState: "open" as const,
    hasMergeConflicts: false,
    environmentType: "containerized",
    status: "running",
  };

  function monitor(overrides: Partial<PrMonitorEnvironmentState> = {}): PrMonitorEnvironmentState {
    return {
      environmentId: "env-1",
      mode: "normal",
      checkInProgress: false,
      consecutiveErrors: 0,
      lastCheckAt: "2026-10-30T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-10-30T00:00:00.000Z",
      prUrl: environment.prUrl,
      prState: "open",
      hasMergeConflicts: false,
      checkSummary: null,
      ...overrides,
    };
  }

  test("a current-lifetime answer that agrees with the persisted reading confirms it", () => {
    expect(isPrReadingConfirmedByMonitor(environment, monitor())).toBe(true);
  });

  test.each([
    ["no monitor entry", null],
    ["no answered check since start or resume", monitor({ lastSuccessfulCheckAt: null })],
    ["an older backend without the field", monitor({ lastSuccessfulCheckAt: undefined })],
    ["the latest check failed", monitor({ consecutiveErrors: 1 })],
    ["a different PR", monitor({ prUrl: "https://github.com/o/r/pull/2" })],
    ["a different state", monitor({ prState: "merged" })],
    ["different conflicts", monitor({ hasMergeConflicts: true })],
    ["no PR at all", monitor({ prUrl: null })],
  ] as const)("not confirmed with %s", (_label, state) => {
    expect(isPrReadingConfirmedByMonitor(environment, state)).toBe(false);
  });

  test("a stopped container cannot be polled, so it is never confirmed", () => {
    expect(isPrReadingConfirmedByMonitor({ ...environment, status: "stopped" }, monitor())).toBe(
      false,
    );
    expect(isPrMonitorPolled("local", "stopped")).toBe(true);
  });

  test("unknown conflicts are never confirmed", () => {
    expect(
      isPrReadingConfirmedByMonitor(
        { ...environment, hasMergeConflicts: null },
        monitor({ hasMergeConflicts: null }),
      ),
    ).toBe(false);
  });
});
