import { describe, expect, test } from "bun:test";
import { DEFAULT_PR_MONITOR_POLICY } from "../../../apps/backend/src/core/pr-monitor-policy";
import {
  PR1,
  PR2,
  createLifecycleHarness,
  inProgressTask,
  terminalComment,
  type LifecycleHarness,
} from "./pr-monitor-test-harness";

/**
 * Lifecycle-aware PR monitoring (recurring-processes step 05): terminal
 * cadence, local repair, restart reconstruction, replacement discovery, wakes,
 * deletion races and comment de-duplication. Cadence behaviour for open and
 * pending entries is covered by pr-monitor-service.test.ts; admission,
 * jitter and rate limits by pr-monitor-admission.test.ts.
 */

const DISCOVERY = DEFAULT_PR_MONITOR_POLICY.terminalDiscoveryIntervalMs;

/** Tracks env-1 with an open PR and lets GitHub report it merged at t+40 s. */
async function mergeWhileTracked(harness: LifecycleHarness, state: "merged" | "closed" = "merged") {
  harness.tasks.set("env-1", inProgressTask());
  harness.github.set("env-1", { url: PR1, state: "open" });
  const target = harness.addEnvironment("env-1", { prUrl: PR1, prState: "open" });
  harness.service.sync([target]);
  await harness.advance(20_000);
  expect(harness.detections()).toBe(1);
  harness.github.set("env-1", { url: PR1, state });
  await harness.advance(20_000);
  expect(harness.detections()).toBe(2);
}

describe("PR monitor terminal lifecycle", () => {
  test("terminal cadence: a settled merged PR is rediscovered every five minutes, not every 20 s", async () => {
    const harness = createLifecycleHarness();
    await mergeWhileTracked(harness);

    expect(harness.durable.get("env-1")).toEqual({ prUrl: PR1, prState: "merged" });
    expect(harness.calls.comments).toEqual([{ taskId: "task-1", text: terminalComment("merged") }]);
    expect(harness.calls.resume).toEqual([{ environmentId: "env-1", url: PR1, state: "merged" }]);
    expect(harness.service.observationPolicy("env-1")).toBe("terminal-discovery");

    const before = harness.detections();
    await harness.advance(DISCOVERY - 1);
    expect(harness.detections()).toBe(before);
    await harness.advance(1);
    expect(harness.detections()).toBe(before + 1);

    // Thirty quiet minutes: six discoveries where the old cadence spent 90.
    await harness.advance(30 * 60_000 - 1);
    expect(harness.detections()).toBe(before + 6);
    // Nothing repeats: one comment, one terminal-effects request, one transition.
    expect(harness.calls.comments).toHaveLength(1);
    expect(harness.calls.resume).toHaveLength(1);
    expect(harness.transitions().map((t: { state: string }) => t.state)).toEqual(["merged"]);
  });

  test("terminal cadence also applies to closed PRs, which still reopen", async () => {
    const harness = createLifecycleHarness();
    await mergeWhileTracked(harness, "closed");
    expect(harness.service.observationPolicy("env-1")).toBe("terminal-discovery");

    harness.github.set("env-1", { url: PR1, state: "open" });
    await harness.advance(DISCOVERY);
    expect(harness.durable.get("env-1")).toEqual({ prUrl: PR1, prState: "open" });
    expect(harness.service.observationPolicy("env-1")).toBe("open");
    const reopened = harness.detections();
    await harness.advance(20_000);
    expect(harness.detections()).toBe(reopened + 1);
  });

  test("unfinished repair stays due and retries locally without another gh call", async () => {
    const harness = createLifecycleHarness();
    harness.failures.comment = 2;
    await mergeWhileTracked(harness);

    // Detection confirmed and persisted the merge, but the comment failed.
    expect(harness.calls.comments).toEqual([]);
    expect(harness.calls.resume).toEqual([]);
    expect(harness.service.observationPolicy("env-1")).toBe("terminal-repair");
    const detections = harness.detections();

    // First repair 20 s later: revalidates durable state, fails again.
    await harness.advance(20_000);
    expect(harness.calls.readTarget).toEqual(["env-1"]);
    expect(harness.calls.comments).toEqual([]);
    expect(harness.detections()).toBe(detections);
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBe(0);

    // Repair failures back off on their own counter (40 s), then succeed.
    await harness.advance(39_999);
    expect(harness.calls.readTarget).toHaveLength(1);
    await harness.advance(1);
    expect(harness.calls.comments).toEqual([{ taskId: "task-1", text: terminalComment("merged") }]);
    expect(harness.tasks.get("env-1")?.prMergeCommented).toBe(true);
    expect(harness.calls.resume).toHaveLength(1);
    expect(harness.detections()).toBe(detections);
    expect(harness.service.observationPolicy("env-1")).toBe("terminal-discovery");

    await harness.advance(DISCOVERY);
    expect(harness.detections()).toBe(detections + 1);
    expect(harness.calls.comments).toHaveLength(1);
  });

  test("a permanently failing repair never starves replacement discovery", async () => {
    const harness = createLifecycleHarness();
    harness.failures.comment = Number.MAX_SAFE_INTEGER;
    await mergeWhileTracked(harness);
    const detections = harness.detections();

    harness.github.set("env-1", { url: PR2, state: "open" });
    // Repairs back off to five minutes; a detection is forced once the last
    // one is a discovery period old.
    await harness.advance(DISCOVERY + 5 * 60_000);
    expect(harness.detections()).toBeGreaterThan(detections);
    expect(harness.durable.get("env-1")).toEqual({ prUrl: PR2, prState: "open" });
    expect(harness.service.observationPolicy("env-1")).toBe("open");
  });

  test("a repair whose observation no longer matches storage detects instead of applying old effects", async () => {
    const harness = createLifecycleHarness();
    harness.failures.comment = 1;
    await mergeWhileTracked(harness);

    // Storage moved on (e.g. another path already stored a replacement PR).
    harness.durable.set("env-1", { prUrl: PR2, prState: "open" });
    harness.github.set("env-1", { url: PR2, state: "open" });
    const detections = harness.detections();
    await harness.advance(20_000);
    expect(harness.calls.readTarget).toEqual(["env-1"]);
    expect(harness.calls.comments).toEqual([]);

    await harness.advance(20_000);
    expect(harness.detections()).toBe(detections + 1);
    expect(harness.calls.comments).toEqual([]);
    expect(harness.tasks.get("env-1")).toMatchObject({ prUrl: PR2, prState: "open" });
  });

  test("repair after restart completes durable obligations without a gh call, then goes quiet", async () => {
    const harness = createLifecycleHarness({ random: () => 0.5 });
    // A previous process pre-linked the merged PR and died before commenting.
    harness.tasks.set("env-1", inProgressTask({ status: "review", prUrl: PR1, prState: "merged" }));
    harness.github.set("env-1", { url: PR1, state: "merged" });
    const target = harness.addEnvironment("env-1", { prUrl: PR1, prState: "merged" });
    harness.service.sync([target]);

    // Restored entries are staggered: 20 s + 0.5 × 20 s.
    await harness.advance(29_999);
    expect(harness.calls.comments).toEqual([]);
    await harness.advance(1);
    expect(harness.detections()).toBe(0);
    expect(harness.calls.comments).toEqual([{ taskId: "task-1", text: terminalComment("merged") }]);
    expect(harness.tasks.get("env-1")?.prMergeCommented).toBe(true);
    expect(harness.calls.review).toEqual([]);
    expect(harness.calls.resume).toEqual([{ environmentId: "env-1", url: PR1, state: "merged" }]);
    expect(harness.transitions()).toEqual([]);

    // The first discovery after a restart is spread over one period
    // (0.5 × 5 min), then the ordinary period applies.
    await harness.advance(DISCOVERY / 2 - 1);
    expect(harness.detections()).toBe(0);
    await harness.advance(1);
    expect(harness.detections()).toBe(1);
    await harness.advance(DISCOVERY + DEFAULT_PR_MONITOR_POLICY.terminalDiscoveryJitterMs / 2);
    expect(harness.detections()).toBe(2);
    expect(harness.calls.comments).toHaveLength(1);
  });

  test("a new open PR on a terminal branch is discovered, linked and tracked at the open cadence", async () => {
    const harness = createLifecycleHarness();
    await mergeWhileTracked(harness);
    expect(harness.service.observationPolicy("env-1")).toBe("terminal-discovery");

    harness.github.set("env-1", { url: PR2, state: "open" });
    await harness.advance(DISCOVERY);

    expect(harness.durable.get("env-1")).toEqual({ prUrl: PR2, prState: "open" });
    expect(harness.tasks.get("env-1")).toMatchObject({
      prUrl: PR2,
      prState: "open",
      prMergeCommented: false,
    });
    expect(harness.transitions().at(-1)).toEqual({
      url: PR2,
      state: "open",
      previousState: "merged",
    });
    expect(harness.service.observationPolicy("env-1")).toBe("open");
    const discovered = harness.detections();
    await harness.advance(20_000);
    expect(harness.detections()).toBe(discovered + 1);

    // The replacement's own merge is reconciled independently.
    harness.github.set("env-1", { url: PR2, state: "merged" });
    await harness.advance(20_000);
    expect(harness.calls.comments.map((call) => call.text)).toEqual([
      terminalComment("merged", PR1),
      terminalComment("merged", PR2),
    ]);
  });

  test("explicit refresh, completion edges and new intents bypass the quiet terminal delay", async () => {
    const harness = createLifecycleHarness();
    await mergeWhileTracked(harness);
    const quiet = harness.detections();

    harness.service.requestCheck("env-1");
    await harness.advance(0);
    expect(harness.detections()).toBe(quiet + 1);

    harness.service.wakeForCompletion(harness.targets(["env-1"])[0]!);
    await harness.advance(0);
    expect(harness.detections()).toBe(quiet + 2);

    harness.service.requestCheck("env-1", "completion");
    await harness.advance(0);
    expect(harness.detections()).toBe(quiet + 3);

    // Back to quiet discovery afterwards.
    await harness.advance(DISCOVERY - 1);
    expect(harness.detections()).toBe(quiet + 3);

    harness.github.set("env-1", { url: PR2, state: "open" });
    harness.service.requestMode(harness.targets(["env-1"])[0]!, "create-pending");
    await harness.advance(0);
    expect(harness.detections()).toBe(quiet + 4);
    expect(harness.durable.get("env-1")).toEqual({ prUrl: PR2, prState: "open" });
  });

  test("simultaneous merge cleanup deletion stops the entry without resurrection or repeats", async () => {
    const harness = createLifecycleHarness();
    // Merge cleanup (scheduled by the terminal effects) deletes the environment.
    harness.setResumeHook(async (environmentId) => {
      await Promise.resolve();
      harness.service.untrack(environmentId);
    });
    await mergeWhileTracked(harness);

    expect(harness.service.trackedIds()).toEqual([]);
    expect(harness.calls.comments).toHaveLength(1);
    expect(harness.tasks.get("env-1")?.prMergeCommented).toBe(true);
    const removals = harness.events().filter((event: { removed?: boolean }) => event.removed);
    expect(removals).toHaveLength(1);
    // The removal is the last word: no state event after it, no timer left.
    expect(harness.events().at(-1)).toMatchObject({ environmentId: "env-1", removed: true });
    expect(harness.time.pendingTimers).toBe(0);

    await harness.advance(30 * 60_000);
    expect(harness.detections()).toBe(2);
    expect(harness.calls.resume).toHaveLength(1);
    expect(harness.reconciliationOperations()).toBe(0);
  });

  test("deletion during an in-flight terminal reconciliation fences every later effect", async () => {
    const harness = createLifecycleHarness();
    const release = harness.gateNextComment();
    harness.tasks.set("env-1", inProgressTask());
    harness.github.set("env-1", { url: PR1, state: "merged" });
    const target = harness.addEnvironment("env-1", { prUrl: PR1, prState: "open" });
    harness.service.sync([target]);
    await harness.advance(20_000);

    // Explicit merge confirmation and deletion race the background reconcile.
    const explicit = harness.service.reconcileTerminal(target, {
      url: PR1,
      state: "merged",
      hasMergeConflicts: false,
      checkSummary: null,
      checkSummaryStatus: "skipped",
    });
    harness.service.untrack("env-1");
    const eventsAtRemoval = harness.events().length;
    release();
    await explicit;
    await harness.advance(30 * 60_000);

    expect(harness.calls.comments).toHaveLength(1);
    expect(harness.calls.resume).toEqual([]);
    expect(harness.service.trackedIds()).toEqual([]);
    expect(harness.events()).toHaveLength(eventsAtRemoval);
    expect(harness.detections()).toBe(1);
    expect(harness.time.pendingTimers).toBe(0);
  });

  test("a stale open reading that raced an explicit merge confirmation cannot undo it", async () => {
    const harness = createLifecycleHarness();
    let resolveStale!: (value: null | { url: string; state: "open" }) => void;
    harness.detectors.set(
      "env-1",
      () =>
        new Promise((resolve) => {
          resolveStale = (value) =>
            resolve(
              value && {
                ...value,
                hasMergeConflicts: false,
                checkSummary: null,
                checkSummaryStatus: "skipped",
              },
            );
        }),
    );
    const target = harness.addEnvironment("env-1", { prUrl: PR1, prState: "open" });
    harness.service.sync([target]);
    await harness.advance(20_000);
    expect(harness.detections()).toBe(1);

    // The merge command persisted the merge and confirmed it explicitly.
    harness.durable.set("env-1", { prUrl: PR1, prState: "merged" });
    await harness.service.reconcileTerminal(target, {
      url: PR1,
      state: "merged",
      hasMergeConflicts: false,
      checkSummary: null,
      checkSummaryStatus: "skipped",
    });
    resolveStale({ url: PR1, state: "open" });
    await harness.flush();

    expect(harness.calls.persist).toEqual([]);
    expect(harness.service.snapshot()[0]).toMatchObject({ prUrl: PR1, prState: "merged" });

    // Even a fresh read that is stale is refused: a merged PR never reopens.
    harness.detectors.delete("env-1");
    harness.github.set("env-1", { url: PR1, state: "open" });
    harness.service.requestCheck("env-1");
    await harness.advance(0);
    expect(harness.calls.persist).toEqual([]);
    expect(harness.durable.get("env-1")).toEqual({ prUrl: PR1, prState: "merged" });
    expect(harness.warnings.some((warning) => warning.includes("stale"))).toBe(true);
  });

  test("task comments are not duplicated when timers, explicit commands and recovery converge", async () => {
    const harness = createLifecycleHarness();
    const release = harness.gateNextComment();
    harness.tasks.set("env-1", inProgressTask());
    harness.github.set("env-1", { url: PR1, state: "merged" });
    const target = harness.addEnvironment("env-1", { prUrl: PR1, prState: "open" });
    harness.service.sync([target]);
    await harness.advance(20_000);

    // While the timer-driven reconciliation is parked in the comment write:
    // an explicit refresh, an explicit merge confirmation and a reconciliation
    // sync (as a client snapshot request would) all arrive.
    harness.service.requestCheck("env-1");
    const explicit = harness.service.reconcileTerminal(target, {
      url: PR1,
      state: "merged",
      hasMergeConflicts: false,
      checkSummary: null,
      checkSummaryStatus: "skipped",
    });
    harness.service.sync(harness.targets(["env-1"]));
    await harness.advance(0);
    release();
    await explicit;
    await harness.advance(10 * 60_000);

    expect(harness.calls.comments).toEqual([{ taskId: "task-1", text: terminalComment("merged") }]);
    expect(harness.calls.review).toEqual(["task-1"]);
    expect(harness.tasks.get("env-1")?.prMergeCommented).toBe(true);
    expect(harness.transitions()).toHaveLength(1);

    // A restarted monitor reconstructs from storage and adds nothing.
    const restarted = createLifecycleHarness();
    restarted.tasks.set("env-1", harness.tasks.get("env-1")!);
    restarted.github.set("env-1", { url: PR1, state: "merged" });
    restarted.service.sync([restarted.addEnvironment("env-1", { prUrl: PR1, prState: "merged" })]);
    await restarted.advance(20 * 60_000);
    expect(restarted.calls.comments).toEqual([]);
    expect(restarted.calls.metadata).toEqual([]);
    expect(harness.tasks.get("env-1")?.comments).toEqual([terminalComment("merged")]);
  });

  test("reconciliation progress is bounded per entry and operations are released", async () => {
    const harness = createLifecycleHarness();
    harness.tasks.set("env-1", inProgressTask());
    const target = harness.addEnvironment("env-1", { prUrl: PR1, prState: "open" });
    harness.service.sync([target]);
    // Twelve replacement PRs, each closed in turn.
    for (let index = 0; index < 12; index += 1) {
      const url = `https://github.com/org/repo/pull/${100 + index}`;
      harness.github.set("env-1", { url, state: "open" });
      harness.service.requestCheck("env-1");
      await harness.advance(0);
      harness.github.set("env-1", { url, state: "closed" });
      harness.service.requestCheck("env-1");
      await harness.advance(0);
    }
    expect(harness.calls.comments).toHaveLength(12);
    expect(harness.internals("env-1")?.reconciliation.size).toBeLessThanOrEqual(
      DEFAULT_PR_MONITOR_POLICY.maxReconciliationKeys,
    );
    expect(harness.reconciliationOperations()).toBe(0);
  });

  test("without a durable reread effect a repair trusts the reconciled target", async () => {
    const harness = createLifecycleHarness({ withoutReadTarget: true });
    harness.failures.comment = 1;
    await mergeWhileTracked(harness);
    await harness.advance(20_000);
    expect(harness.calls.comments).toHaveLength(1);
    expect(harness.service.observationPolicy("env-1")).toBe("terminal-discovery");
  });

  test("a failed terminal-effects request keeps the entry in repair until it is accepted", async () => {
    const harness = createLifecycleHarness();
    harness.failures.resume = 1;
    await mergeWhileTracked(harness);
    expect(harness.service.observationPolicy("env-1")).toBe("terminal-repair");
    const detections = harness.detections();
    await harness.advance(20_000);
    expect(harness.calls.resume).toHaveLength(1);
    expect(harness.detections()).toBe(detections);
    expect(harness.calls.comments).toHaveLength(1);
    expect(harness.service.observationPolicy("env-1")).toBe("terminal-discovery");
  });
});
