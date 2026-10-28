import { describe, expect, test } from "bun:test";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import {
  isLocalEnvironmentReadyToMerge,
  isNodeEnvironmentReadyToMerge,
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
    expect(isLocalEnvironmentReadyToMerge(environment(), monitor(), "current")).toBe(true);
    // A running container can be polled too.
    expect(
      isLocalEnvironmentReadyToMerge(
        environment({ environmentType: "containerized", status: "running" }),
        monitor(),
        "current",
      ),
    ).toBe(true);
  });

  test.each([
    ["the mirror is hydrating", {}, {}, "hydrating"],
    ["the mirror is stale", {}, {}, "stale"],
    ["the peer has no monitor snapshot", {}, {}, "unsupported"],
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
  ] as const)("not ready when %s", (_label, environmentOverrides, monitorOverrides, sync) => {
    expect(
      isLocalEnvironmentReadyToMerge(
        environment(environmentOverrides as Partial<ReadyToMergeEnvironment>),
        monitor(monitorOverrides as Partial<PrMonitorEnvironmentState>),
        sync,
      ),
    ).toBe(false);
  });

  test("not ready without a monitor entry", () => {
    expect(isLocalEnvironmentReadyToMerge(environment(), null, "current")).toBe(false);
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

  test("even a current clean snapshot cannot confirm leaf monitor health", () => {
    // Identical persisted summaries can follow a failed detection, expired
    // credentials, or a restart before the first successful detection.
    expect(isNodeEnvironmentReadyToMerge(remote(), live)).toBe(false);
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
  ] as const)("not ready when %s", (_label, overrides, machine) => {
    expect(
      isNodeEnvironmentReadyToMerge(
        remote(overrides as Partial<FederatedEnvironment>),
        machine as Parameters<typeof isNodeEnvironmentReadyToMerge>[1],
      ),
    ).toBe(false);
  });
});
