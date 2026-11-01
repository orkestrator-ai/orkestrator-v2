import { describe, expect, test } from "bun:test";
import {
  coordinatorPrFields,
  prKeyTag,
  prReadingFrom,
  pullRequestStatus,
  resolveFinishedStatus,
  summaryPrHealth,
  type CoordinatorPrReading,
} from "./coordinator-pr-status.js";

const URL = "https://github.com/org/repo/pull/7";

function reading(change: Partial<CoordinatorPrReading> = {}): CoordinatorPrReading {
  return {
    prUrl: URL,
    prState: "open",
    hasMergeConflicts: false,
    mergeability: "clean",
    checkSummary: { passed: 3, total: 3, pending: 0 },
    viewerCanMerge: true,
    confirmed: true,
    recheckArmed: false,
    ...change,
  };
}

/** Feed readings through the reducer as the observer does: a key is sent once. */
function run(readings: CoordinatorPrReading[]): string[] {
  let previous: string | undefined;
  const sent: string[] = [];
  for (const next of readings) {
    const result = pullRequestStatus(next, "env-1", previous);
    if (!result || result.status.key === previous) continue;
    if (result.wake) sent.push(result.status.state);
    previous = result.status.key;
  }
  return sent;
}

describe("pull request status", () => {
  test("wakes once per state change, never for an unknown reading in between", () => {
    const pending = reading({
      mergeability: "blocked",
      checkSummary: { passed: 1, total: 3, pending: 2 },
    });
    expect(
      run([
        reading({ prUrl: null, prState: null }),
        reading({ hasMergeConflicts: null, mergeability: null, confirmed: false }),
        reading({ hasMergeConflicts: null, mergeability: null, confirmed: false }),
        reading({ hasMergeConflicts: true, mergeability: "dirty" }),
        reading({ hasMergeConflicts: true, mergeability: "dirty" }),
        pending,
        reading({ mergeability: "unstable", checkSummary: { passed: 1, total: 3, pending: 1 } }),
        pending,
        reading({ mergeability: "unstable", checkSummary: { passed: 2, total: 3, pending: 0 } }),
        // GitHub recomputing after a push is not a change.
        reading({ hasMergeConflicts: null, mergeability: "unknown", confirmed: false }),
        reading(),
        reading({ hasMergeConflicts: null, mergeability: "unknown" }),
        reading(),
        reading({ prState: "merged" }),
      ]),
    ).toEqual([
      "pr-opened",
      "pr-conflicts",
      "pr-checks-failed",
      "pr-checks-failed",
      "pr-ready",
      "pr-merged",
    ]);
  });

  test("only a required check failing wakes; GitHub not saying which counts every failure", () => {
    const optional = reading({
      mergeability: "unstable",
      checkSummary: { passed: 2, total: 3, pending: 0, requiredFailed: 0 },
    });
    const required = reading({
      mergeability: "blocked",
      checkSummary: { passed: 1, total: 3, pending: 0, requiredFailed: 1 },
    });
    expect(run([reading({ mergeability: "blocked", checkSummary: null }), optional])).toEqual([
      "pr-opened",
    ]);
    const quiet = pullRequestStatus(optional, "env-1", `opened:${prKeyTag(URL)}`)!;
    expect(quiet).toMatchObject({ wake: false, status: { state: "pr-open" } });
    expect(quiet.status.details.join("\n")).toContain("1 failed (0 required)");

    const failed = pullRequestStatus(required, "env-1", quiet.status.key)!;
    expect(failed).toMatchObject({
      wake: true,
      status: { state: "pr-checks-failed", headline: "has failing required checks" },
    });
    expect(failed.status.details.join("\n")).toContain("2 failed (1 required)");
    expect(failed.status.details.join("\n")).not.toContain("may not be required");

    // An older node, or GitHub not answering: every failing check counts.
    const unknown = pullRequestStatus(
      reading({ mergeability: "unstable", checkSummary: { passed: 2, total: 3, pending: 0 } }),
      "env-1",
      quiet.status.key,
    )!;
    expect(unknown.status).toMatchObject({
      state: "pr-checks-failed",
      headline: "has failing checks",
    });
    expect(unknown.status.details.join("\n")).toContain("1 failed (required unknown)");
    expect(unknown.status.details.join("\n")).toContain("A check failed (it may not be required)");
  });

  test("a first reading that already needs action carries the URL instead of opened", () => {
    const conflicts = pullRequestStatus(reading({ hasMergeConflicts: true }), "env-1", undefined)!;
    expect(conflicts.status.state).toBe("pr-conflicts");
    expect(conflicts.status.details[0]).toBe(`Pull request: ${URL}`);
    expect(conflicts.status.tools).toEqual([
      'get_environment { "environmentId": "env-1" }',
      'resolve_conflicts { "environmentId": "env-1" }',
    ]);
    expect(pullRequestStatus(reading(), "env-1", undefined)!.status.state).toBe("pr-ready");
  });

  test("closed and merged end the follow; every key names the PR", () => {
    const closed = pullRequestStatus(reading({ prState: "closed" }), "env-1", undefined)!;
    expect(closed.status).toMatchObject({ state: "pr-closed", terminal: true, tone: "info" });
    const merged = pullRequestStatus(reading({ prState: "merged" }), "env-1", undefined)!;
    expect(merged.status).toMatchObject({ state: "pr-merged", terminal: true, tone: "success" });
    const other = pullRequestStatus(
      reading({ prState: "merged", prUrl: `${URL}0` }),
      "env-1",
      undefined,
    )!;
    expect(other.status.key).not.toBe(merged.status.key);
  });

  test("ready needs the monitor's confirmation and the merge permission", () => {
    expect(
      pullRequestStatus(reading({ confirmed: false }), "env-1", `opened:${prKeyTag(URL)}`)?.status
        .state,
    ).toBeUndefined();
    expect(
      pullRequestStatus(reading({ viewerCanMerge: false }), "env-1", undefined)?.status.state,
    ).toBe("pr-opened");
  });

  test("a finished Resolve tab reports the state it left the PR in", () => {
    const resolve = { tabId: "agent-job-1", requestedAt: "2026-10-31T10:00:00Z" };
    const cleared = resolveFinishedStatus(reading(), "env-1", resolve, true);
    expect(cleared).toMatchObject({ state: "resolve-finished", tone: "success" });
    expect(cleared.headline).toContain("ready to merge");
    const still = resolveFinishedStatus(
      reading({ hasMergeConflicts: true, recheckArmed: true }),
      "env-1",
      resolve,
      false,
    );
    expect(still.headline).toContain("still conflicts");
    expect(still.tools).toContain('resolve_conflicts { "environmentId": "env-1" }');
    expect(still.details.join("\n")).toContain("had not rechecked");
    expect(still.key).toBe(cleared.key);
  });
});

describe("coordinator environment PR fields", () => {
  test("states and counts from the record and the monitor, nothing for a worker without a PR", () => {
    expect(coordinatorPrFields(prReadingFrom({ prUrl: null, prState: null }))).toEqual({});
    const fields = coordinatorPrFields(
      prReadingFrom(
        { prUrl: URL, prState: "open", hasMergeConflicts: false, prMergeability: "clean" },
        { prMonitorConfirmed: true, prCheckSummary: { passed: 2, total: 4, pending: 1 } },
      ),
    );
    expect(fields).toEqual({
      prHasMergeConflicts: false,
      prMergeability: "clean",
      prChecks: { passed: 2, failed: 1, requiredFailed: null, pending: 1, total: 4 },
      prReadyToMerge: false,
      prNotReadyReason: "checks-failing",
    });
    expect(
      coordinatorPrFields(
        prReadingFrom(
          { prUrl: URL, prState: "open", hasMergeConflicts: false, prMergeability: "clean" },
          { prMonitorConfirmed: true },
        ),
      ),
    ).toMatchObject({ prReadyToMerge: true, prChecks: null });
    // The relayed count survives the reading, clamped to the failing checks.
    expect(
      coordinatorPrFields(
        prReadingFrom(
          { prUrl: URL, prState: "open", hasMergeConflicts: false, prMergeability: "unstable" },
          {
            prMonitorConfirmed: true,
            prCheckSummary: { passed: 1, total: 3, pending: 0, requiredFailed: 5 },
          },
        ),
      ).prChecks,
    ).toEqual({ passed: 1, failed: 2, requiredFailed: 2, pending: 0, total: 3 });
  });

  test("another node's row vouches only while that node is connected and current", () => {
    const row = {
      prState: "open",
      prHasMergeConflicts: false,
      prMergeability: "clean",
      prMonitorConfirmed: true,
    };
    const ready = (node: Record<string, unknown>) =>
      coordinatorPrFields(prReadingFrom(row, summaryPrHealth(node, row))).prReadyToMerge;
    expect(ready({ available: true, freshness: "current" })).toBe(true);
    expect(ready({ available: false, freshness: "current" })).toBe(false);
    expect(ready({ available: true, freshness: "stale" })).toBe(false);
  });
});
