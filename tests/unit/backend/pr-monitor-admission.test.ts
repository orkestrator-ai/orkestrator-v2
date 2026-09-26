import { describe, expect, test } from "bun:test";
import type { PrDetection } from "../../../apps/backend/src/core/pr-monitor";
import { DEFAULT_PR_MONITOR_POLICY } from "../../../apps/backend/src/core/pr-monitor-policy";
import { deferred, type Deferred } from "../../../apps/backend/src/core/recurring-test-support";
import { PR1, createLifecycleHarness, localTarget } from "./pr-monitor-test-harness";

/**
 * Aggregate admission, fairness, startup staggering, rate-limit cooldown and
 * check-rollup independence of the backend PR monitor (step 05).
 */

function openDetection(url: string, overrides: Partial<PrDetection> = {}): PrDetection {
  return {
    url,
    state: "open",
    hasMergeConflicts: false,
    checkSummary: null,
    checkSummaryStatus: "skipped",
    ...overrides,
  };
}

/** Makes every detection of the listed environments wait for an explicit release. */
function holdDetections(harness: ReturnType<typeof createLifecycleHarness>, ids: string[]) {
  const pending: Array<{ environmentId: string; gate: Deferred<PrDetection | null> }> = [];
  for (const id of ids) {
    harness.detectors.set(id, () => {
      const gate = deferred<PrDetection | null>();
      pending.push({ environmentId: id, gate });
      return gate.promise;
    });
  }
  return {
    pending,
    /** Resolves every detection currently in flight with an open PR. */
    releaseAll: async () => {
      for (const item of pending.splice(0)) {
        item.gate.resolve(openDetection(`https://github.com/org/repo/pull/${item.environmentId}`));
      }
      await harness.flush();
    },
  };
}

function prUrlFor(id: string): string {
  return `https://github.com/org/repo/pull/${id}`;
}

describe("PR monitor admission and policy", () => {
  test("pausing a queued detection clears its announced progress", async () => {
    const harness = createLifecycleHarness();
    const ids = ["busy-1", "busy-2", "queued"];
    const held = holdDetections(harness, ids);
    harness.service.sync(
      ids.map((id) => harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" })),
    );
    await harness.advance(20_000);
    expect(harness.admission.status().waiting).toBe(1);
    harness.service.sync(harness.targets(ids, { ready: false }));
    await harness.flush();
    expect(
      harness.service.revisionedSnapshot().entries.find((entry) => entry.environmentId === "queued")
        ?.checkInProgress,
    ).toBe(false);
    await held.releaseAll();
  });
  test("aggregate concurrency bound: at most two detections run at once, all eventually run", async () => {
    const harness = createLifecycleHarness();
    const ids = ["a", "b", "c", "d", "e", "f"];
    const held = holdDetections(harness, ids);
    harness.service.sync(
      ids.map((id) => harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" })),
    );

    await harness.advance(20_000);
    expect(harness.inFlight()).toBe(2);
    expect(harness.admission.status()).toMatchObject({ active: 2, waiting: 4 });

    // One pending check per environment: waking a queued environment neither
    // queues a second request nor schedules an extra detection afterwards.
    harness.service.requestCheck("f");
    harness.service.requestCheck("f");
    await harness.advance(0);
    expect(harness.admission.status().waiting).toBe(4);

    for (let round = 0; round < 3; round += 1) await held.releaseAll();
    expect(harness.maxInFlight()).toBe(2);
    expect(new Set(harness.calls.detect.map((call) => call.environmentId))).toEqual(new Set(ids));
    expect(harness.detections("f")).toBe(1);
    expect(harness.admission.status()).toMatchObject({ active: 0, waiting: 0 });
  });

  test("user intent is admitted before quiet discovery, and a queued wake is upgraded in place", async () => {
    const harness = createLifecycleHarness();
    const ids = ["busy-1", "busy-2", "quiet", "user"];
    const held = holdDetections(harness, ids);
    harness.service.sync(
      ids.map((id) => harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" })),
    );
    await harness.advance(20_000);
    expect(harness.inFlight()).toBe(2);
    expect(harness.admission.status().waitingByPriority).toEqual({ discovery: 2 });

    // "user" queued after "quiet" but a user refresh raises its priority.
    harness.service.requestCheck("user");
    await harness.advance(0);
    expect(harness.admission.status().waitingByPriority).toEqual({
      discovery: 1,
      interactive: 1,
    });

    held.pending.shift()!.gate.resolve(openDetection(prUrlFor("busy-1")));
    await harness.flush();
    expect(harness.calls.detect.at(-1)?.environmentId).toBe("user");
    await held.releaseAll();
    await held.releaseAll();
    expect(harness.detections("user")).toBe(1);
    expect(harness.detections("quiet")).toBe(1);
  });

  test("fairness under merge bursts: a continuous stream of fast checks cannot hide another PR", async () => {
    const harness = createLifecycleHarness();
    const merging = ["m1", "m2", "m3", "m4"];
    const held = holdDetections(harness, [...merging, "quiet"]);
    const targets = [...merging, "quiet"].map((id) =>
      harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" }),
    );
    harness.service.sync(targets.filter((target) => target.environmentId === "quiet"));
    await harness.advance(20_000);
    // "quiet" was granted immediately; let it finish and fall due again under load.
    await held.releaseAll();
    expect(harness.detections("quiet")).toBe(1);

    let quietSecondDetectionRound = -1;
    for (let round = 0; round < 40; round += 1) {
      // Users keep pressing merge: every round re-requests merge-pending, so
      // four interactive checks are always waiting for the two slots.
      for (const target of targets.slice(0, 4)) {
        harness.service.requestMode(target, "merge-pending");
      }
      await harness.advance(1_000);
      await held.releaseAll();
      if (quietSecondDetectionRound < 0 && harness.detections("quiet") >= 2) {
        quietSecondDetectionRound = round;
      }
    }
    // Due at round ~19 (20 s after its first check); the starvation cap (8
    // bypasses) admits it within a few grants rather than never.
    expect(quietSecondDetectionRound).toBeGreaterThanOrEqual(0);
    expect(quietSecondDetectionRound).toBeLessThan(30);
    expect(harness.maxInFlight()).toBe(2);
    expect(harness.detections("m1")).toBeGreaterThan(10);
  });

  test("startup jitter: restored entries are staggered; explicit intents are not", async () => {
    const samples = [0.1, 0.9, 0.5, 0.3, 0.7, 0.2, 0.8, 0.6];
    let index = 0;
    const harness = createLifecycleHarness({
      random: () => samples[index++ % samples.length]!,
    });
    const open = ["o1", "o2", "o3", "o4"].map((id) =>
      harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" }),
    );
    const terminal = ["t1", "t2", "t3", "t4"].map((id) =>
      harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "merged" }),
    );
    harness.service.sync([...open, ...terminal]);

    const initial = harness.scheduled.map((entry) => entry.delayMs);
    expect(initial).toHaveLength(8);
    for (const delay of initial) {
      expect(delay).toBeGreaterThanOrEqual(20_000);
      expect(delay).toBeLessThan(40_000);
    }
    expect(new Set(initial).size).toBe(8);

    // Terminal entries repair locally, then spread their first discovery over
    // one whole period rather than aligning a period later.
    harness.scheduled.length = 0;
    await harness.advance(40_000);
    // Open entries re-arm at exactly 20 s; everything else is a discovery.
    const firstDiscoveries = harness.scheduled
      .map((entry) => entry.delayMs)
      .filter((delay) => delay !== 20_000);
    expect(firstDiscoveries.length).toBe(4);
    expect(new Set(firstDiscoveries).size).toBe(4);
    for (const delay of firstDiscoveries) {
      expect(delay).toBeLessThan(DEFAULT_PR_MONITOR_POLICY.terminalDiscoveryIntervalMs);
    }
    // No terminal entry asked GitHub during its repair.
    expect(harness.calls.detect.some((call) => call.environmentId.startsWith("t"))).toBe(false);

    // A user's merge/create feedback never inherits background jitter.
    harness.scheduled.length = 0;
    harness.service.requestMode(localTarget("fresh"), "create-pending");
    harness.service.requestMode(open[0]!, "merge-pending");
    expect(harness.scheduled.map((entry) => entry.delayMs)).toEqual([0, 0]);
  });

  test("error backoff keeps its exponential shape with bounded jitter", async () => {
    const harness = createLifecycleHarness({ random: () => 0.99 });
    harness.detectors.set("env-1", async () => {
      throw new Error("gh unavailable");
    });
    harness.service.requestMode(
      harness.addEnvironment("env-1", { prUrl: PR1, prState: "open" }),
      "normal",
    );
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      harness.scheduled.length = 0;
      await harness.advance(10 * 60_000);
      delays.push(...harness.scheduled.map((entry) => entry.delayMs));
    }
    const bases = [40_000, 80_000, 160_000, 300_000, 300_000, 300_000];
    const firstSix = delays.slice(0, 6);
    firstSix.forEach((delay, attempt) => {
      const base = bases[attempt]!;
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThanOrEqual(base + Math.min(base * 0.1, 30_000));
    });
  });

  test("rate-limit cooldown is shared inside a proven scope and never across scopes", async () => {
    const harness = createLifecycleHarness({
      cooldownScope: (target) => (target.kind === "local" ? "local-gh:github.com" : null),
    });
    let rateLimited = true;
    harness.detectors.set("a", async () => {
      if (rateLimited) throw new Error("GraphQL: API rate limit exceeded for user ID 1.");
      return openDetection(prUrlFor("a"));
    });
    const a = harness.addEnvironment("a", { prUrl: prUrlFor("a"), prState: "open" });
    const b = harness.addEnvironment("b", { prUrl: prUrlFor("b"), prState: "open" });
    const c = harness.addEnvironment(
      "c",
      { prUrl: prUrlFor("c"), prState: "open" },
      { kind: "container", containerId: "container-c", worktreePath: undefined },
    );
    harness.github.set("b", { url: prUrlFor("b"), state: "open" });
    harness.github.set("c", { url: prUrlFor("c"), state: "open" });
    harness.service.sync([a]);
    await harness.advance(20_000);
    expect(harness.detections("a")).toBe(1);

    // b shares a's host/auth scope; c is a container with no provable scope.
    harness.service.sync([a, b, c]);
    await harness.advance(60_000);
    expect(harness.detections("b")).toBe(0);
    expect(harness.detections("c")).toBe(3);
    expect(harness.detections("a")).toBe(1);

    // A completion edge in scope waits too; an explicit refresh does not.
    harness.service.requestCheck("b", "completion");
    await harness.advance(0);
    expect(harness.detections("b")).toBe(0);
    harness.service.requestCheck("b");
    await harness.advance(0);
    expect(harness.detections("b")).toBe(1);

    // The default cooldown (2 min from the failure at t=20 s) ends at t=140 s;
    // the whole scope resumes exactly then, not one backoff step later.
    rateLimited = false;
    expect(DEFAULT_PR_MONITOR_POLICY.rateLimitCooldownMs).toBe(120_000);
    await harness.advance(59_999);
    expect(harness.detections("a")).toBe(1);
    expect(harness.detections("b")).toBe(1);
    await harness.advance(1);
    expect(harness.detections("a")).toBe(2);
    expect(harness.detections("b")).toBe(2);
  });

  test("reliable retry timing from the boundary is honoured, bounded", async () => {
    const harness = createLifecycleHarness();
    let attempts = 0;
    harness.detectors.set("a", async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("secondary rate limit"), { retryAfterMs: 7 * 60_000 });
      }
      return openDetection(prUrlFor("a"));
    });
    harness.service.sync([harness.addEnvironment("a", { prUrl: prUrlFor("a"), prState: "open" })]);
    await harness.advance(20_000);
    expect(attempts).toBe(1);
    await harness.advance(7 * 60_000 - 1);
    expect(attempts).toBe(1);
    await harness.advance(1);
    expect(attempts).toBe(2);
  });

  test("a failed check rollup never suppresses the PR state it accompanies", async () => {
    const harness = createLifecycleHarness();
    harness.tasks.set("env-1", {
      taskId: "task-1",
      status: "in-progress",
      prUrl: null,
      prState: null,
      prMergeCommented: false,
      comments: [],
    });
    harness.github.set("env-1", {
      url: PR1,
      state: "open",
      hasMergeConflicts: true,
      checkSummaryStatus: "failed",
    });
    harness.service.sync([harness.addEnvironment("env-1", { prUrl: PR1, prState: "open" })]);
    await harness.advance(20_000);

    expect(harness.calls.detect[0]?.options.includeCheckSummary).toBe(true);
    expect(harness.calls.persist.at(-1)?.detection).toMatchObject({
      url: PR1,
      state: "open",
      hasMergeConflicts: true,
    });
    const state = harness.service.snapshot()[0]!;
    expect(state).toMatchObject({ consecutiveErrors: 0, checkSummary: null });
    expect(state.lastSuccessfulCheckAt).toBe(state.lastCheckAt);

    // The rollup keeps its own 60 s budget even after a failure.
    await harness.advance(20_000);
    expect(harness.calls.detect[1]?.options.includeCheckSummary).toBe(false);
    await harness.advance(40_000);
    expect(harness.calls.detect.at(-1)?.options.includeCheckSummary).toBe(true);

    // Merge detection is unaffected by the permission failure.
    harness.github.set("env-1", { url: PR1, state: "merged", checkSummaryStatus: "skipped" });
    await harness.advance(20_000);
    expect(harness.durable.get("env-1")).toEqual({ prUrl: PR1, prState: "merged" });
    expect(harness.tasks.get("env-1")?.prMergeCommented).toBe(true);
  });

  test("lastSuccessfulCheckAt does not move on a failed attempt", async () => {
    const harness = createLifecycleHarness();
    let fail = false;
    harness.detectors.set("env-1", async () => {
      if (fail) throw new Error("gh unavailable");
      return openDetection(PR1);
    });
    harness.service.sync([harness.addEnvironment("env-1", { prUrl: PR1, prState: "open" })]);
    await harness.advance(20_000);
    const succeeded = harness.service.snapshot()[0]!.lastSuccessfulCheckAt;
    expect(succeeded).toBe(new Date(harness.time.now()).toISOString());

    fail = true;
    await harness.advance(20_000);
    const state = harness.service.snapshot()[0]!;
    expect(state.lastCheckAt).not.toBe(succeeded);
    expect(state.lastSuccessfulCheckAt).toBe(succeeded);
    expect(state.consecutiveErrors).toBe(1);
  });

  test("a branch rename while queued is included in that check, without an extra detection", async () => {
    const harness = createLifecycleHarness();
    const held = holdDetections(harness, ["busy-1", "busy-2"]);
    const branches: string[] = [];
    harness.detectors.set("renamed", async (target) => {
      branches.push(target.branch);
      return openDetection(prUrlFor("renamed"));
    });
    const targets = ["busy-1", "busy-2", "renamed"].map((id) =>
      harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" }),
    );
    harness.service.sync(targets);
    await harness.advance(20_000);
    expect(harness.admission.status().waiting).toBe(1);

    harness.service.sync([
      targets[0]!,
      targets[1]!,
      { ...targets[2]!, branch: "feature/renamed-by-prompt" },
    ]);
    await held.releaseAll();
    await harness.advance(0);
    expect(branches).toEqual(["feature/renamed-by-prompt"]);
    await harness.advance(19_999);
    expect(branches).toHaveLength(1);
  });

  test("pausing or deleting a queued environment withdraws its admission request", async () => {
    const harness = createLifecycleHarness();
    const held = holdDetections(harness, ["busy-1", "busy-2"]);
    const targets = ["busy-1", "busy-2", "paused", "deleted"].map((id) =>
      harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" }),
    );
    harness.service.sync(targets);
    await harness.advance(20_000);
    expect(harness.admission.status().waiting).toBe(2);

    harness.service.pause("paused");
    harness.service.untrack("deleted");
    await harness.flush();
    expect(harness.admission.status().waiting).toBe(0);
    await held.releaseAll();
    await harness.advance(60_000);
    expect(harness.detections("paused")).toBe(0);
    expect(harness.detections("deleted")).toBe(0);
    expect(harness.service.trackedIds()).not.toContain("deleted");
  });
});
