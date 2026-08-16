import { afterEach, describe, expect, test } from "bun:test";
import {
  deferredMergeCleanupCountForTesting,
  requestMergeCleanupRecovery,
  resetMergeCleanupSchedulerForTesting,
  setMergeCleanupScheduler,
} from "@/../../backend/src/core/commands-pr-monitor";
import type { CommandContext } from "@/../../backend/src/core/commands-context";

/**
 * `commands-pr-monitor` observes a merged PR; `commands-servers` owns the
 * cleanup that follows. The scheduler is registered rather than imported so the
 * two modules stay acyclic (see `module-import-cycles.test.ts`). Inversions like
 * this are only safe if an unregistered request is deferred rather than dropped,
 * which is what these tests hold in place.
 */
// `getEnvironment` resolving to null is the real scheduler's first exit: it has
// nothing to clean up. That keeps the registration test below on a quiet path
// while still proving the production scheduler, not a stub, was invoked.
const context = {
  storage: { getEnvironment: async () => null },
  emit: () => undefined,
} as unknown as CommandContext;

afterEach(() => {
  resetMergeCleanupSchedulerForTesting();
});

describe("merge cleanup scheduler registration", () => {
  test("forwards straight through once a scheduler is registered", () => {
    const calls: Array<[string, CommandContext]> = [];
    setMergeCleanupScheduler((environmentId, ctx) => calls.push([environmentId, ctx]));

    requestMergeCleanupRecovery("env-1", context);

    expect(calls).toEqual([["env-1", context]]);
    expect(deferredMergeCleanupCountForTesting()).toBe(0);
  });

  test("defers a request made before registration and replays it", () => {
    requestMergeCleanupRecovery("env-early", context);
    expect(deferredMergeCleanupCountForTesting()).toBe(1);

    const calls: string[] = [];
    setMergeCleanupScheduler((environmentId) => calls.push(environmentId));

    // The whole point of the inversion: a merge observed before
    // `commands-servers` finished evaluating still gets cleaned up.
    expect(calls).toEqual(["env-early"]);
    expect(deferredMergeCleanupCountForTesting()).toBe(0);
  });

  test("collapses repeated deferred requests for one environment", () => {
    requestMergeCleanupRecovery("env-dupe", context);
    requestMergeCleanupRecovery("env-dupe", context);
    requestMergeCleanupRecovery("env-dupe", context);

    expect(deferredMergeCleanupCountForTesting()).toBe(1);

    const calls: string[] = [];
    setMergeCleanupScheduler((environmentId) => calls.push(environmentId));
    expect(calls).toEqual(["env-dupe"]);
  });

  test("bounds the deferred set instead of growing without limit", () => {
    for (let index = 0; index < 300; index += 1) {
      requestMergeCleanupRecovery(`env-${index}`, context);
    }

    expect(deferredMergeCleanupCountForTesting()).toBe(256);
  });

  test("loading the command surface registers the real scheduler", async () => {
    // The structural guarantee behind the inversion: `commands-servers`
    // registers at its own module scope, and every path that can reach the PR
    // monitor goes through this barrel, so nothing observable can run with the
    // scheduler still unset.
    resetMergeCleanupSchedulerForTesting();
    await import("@/../../backend/src/core/commands-helpers");

    const monitor = await import("@/../../backend/src/core/commands-pr-monitor");
    monitor.requestMergeCleanupRecovery("env-registered", context);

    // Forwarded, not deferred - a deferred request would leave a count of 1.
    expect(monitor.deferredMergeCleanupCountForTesting()).toBe(0);
  });

  test("a later registration replaces the previous scheduler", () => {
    const first: string[] = [];
    const second: string[] = [];
    setMergeCleanupScheduler((environmentId) => first.push(environmentId));
    setMergeCleanupScheduler((environmentId) => second.push(environmentId));

    requestMergeCleanupRecovery("env-2", context);

    expect(first).toEqual([]);
    expect(second).toEqual(["env-2"]);
  });
});
