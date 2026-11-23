import { eventSink } from "../backend-emit.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createEnvironment } from "../storage/service.js";
import { recurringWorkDiagnostics } from "../recurring/diagnostics.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

const harnesses: PublicApiHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) await harness.cleanup();
});

async function trackedHarness() {
  const events: unknown[] = [];
  // Woken by every emitted event; `awaitQualifiedCoverage` re-reads the gauge on each.
  const emitted = new Set<() => void>();
  const harness = await createPublicApiHarness({
    context: {
      emit: (event, payload) => {
        events.push({ event, payload });
        for (const wake of Array.from(emitted)) wake();
      },
    },
  });
  harnesses.push(harness);
  const { projectPath } = await harness.createRepository("tracking");
  const environment = {
    ...createEnvironment("project", { environmentType: "local" }),
    id: "same-environment",
    worktreePath: projectPath,
    createdFromCommit: "origin/main",
  };
  await harness.storage.addEnvironment(environment);
  // Exercise a registry command that starts backend-owned tracking.
  await harness.commands.get("get_environments")!({ projectId: "project" }, harness.context);
  await harness.context.runtime.diffStats.sync(harness.context);
  await readTracking(harness);
  return {
    harness,
    events,
    projectPath,
    /**
     * `isWatching` is true as soon as the watcher is established, but the
     * `watched` gauge counts qualified coverage: the Git metadata locations
     * resolve asynchronously (a subprocess) after that. The service announces
     * the moment coverage is qualified with a snapshot event carrying
     * `watched`, so wait for that event instead of reading the gauge straight
     * after tracking starts, which a loaded host can win.
     */
    awaitQualifiedCoverage(): Promise<void> {
      const tracking = harness.context.runtime.diffStats;
      return new Promise<void>((resolve) => {
        const check = () => {
          if (tracking.service.status().watched < 1) return false;
          emitted.delete(check);
          resolve();
          return true;
        };
        if (!check()) emitted.add(check);
      });
    },
  };
}

async function readTracking(harness: PublicApiHarness) {
  return harness.context.runtime.diffStats.service.readFileList({
    lookup: { worktreePath: path.join(harness.root, "repos", "tracking") },
    comparisonRef: "origin/main",
    includeUncommitted: true,
    refresh: true,
  });
}

test("cleanup drains lifecycle work before releasing tracking and diagnostics", async () => {
  const { harness, events } = await trackedHarness();
  const tracking = harness.context.runtime.diffStats;
  expect(tracking.service.isWatching("same-environment")).toBe(true);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = harness.context.environmentLifecycleTasks.admit(async () => {
    await pending;
    await tracking.sync(harness.context);
  });
  const cleanup = harness.cleanup();
  try {
    await Promise.resolve();
    expect(tracking.service.trackedIds()).toEqual(["same-environment"]);
  } finally {
    release();
    await task;
    await cleanup;
  }
  expect(tracking.service.status()).toMatchObject({
    entries: 0,
    watched: 0,
    inFlight: 0,
    retryTimers: 0,
  });
  expect(recurringWorkDiagnostics().fetchPolicies).toEqual([]);
  const emitted = events.length;
  await tracking.sync(harness.context);
  tracking.service.refresh("same-environment");
  expect(tracking.service.trackedIds()).toEqual([]);
  expect(events).toHaveLength(emitted);
  expect(await fs.exists(harness.root)).toBe(false);
});

test("worktree cache gauges follow the tracked environment and leave diagnostics on cleanup", async () => {
  const cache = (name: string) =>
    recurringWorkDiagnostics().caches.find((entry) => entry.name === name);
  const sourcesBefore = {
    snapshots: cache("worktree-snapshots")?.sources ?? 0,
    scans: cache("local-git-scan")?.sources ?? 0,
  };
  const { harness, awaitQualifiedCoverage } = await trackedHarness();
  const tracking = harness.context.runtime.diffStats;
  await awaitQualifiedCoverage();
  expect(tracking.cacheGauges()).toMatchObject({
    entries: 1,
    watched: 1,
    treeTargets: 1,
    ownedWorktrees: 1,
    scanCacheWorktrees: 1,
    endedContainers: 0,
  });
  expect(cache("worktree-snapshots")?.sources).toBe(sourcesBefore.snapshots + 1);
  expect(cache("local-git-scan")?.sources).toBe(sourcesBefore.scans + 1);
  // Content-free: no environment id or worktree path reaches the gauges.
  const serialized = JSON.stringify(recurringWorkDiagnostics().caches);
  expect(serialized).not.toContain("same-environment");
  expect(serialized).not.toContain(harness.root);

  // Removing the environment empties every per-environment map.
  await harness.storage.removeEnvironment("same-environment");
  await tracking.sync(harness.context);
  expect(tracking.cacheGauges()).toMatchObject({
    entries: 0,
    active: 0,
    watched: 0,
    inFlight: 0,
    retryTimers: 0,
    treeTargets: 0,
    treeBodies: 0,
    treeBytes: 0,
    treeInFlight: 0,
    ownedWorktrees: 0,
    scanCacheWorktrees: 0,
    baselineCandidates: 0,
    baselineChecks: 0,
  });

  harnesses.splice(harnesses.indexOf(harness), 1);
  await harness.cleanup();
  expect(cache("worktree-snapshots")?.sources ?? 0).toBe(sourcesBefore.snapshots);
  expect(cache("local-git-scan")?.sources ?? 0).toBe(sourcesBefore.scans);
});

test("restart releases the old runtime while the replacement tracks and emits", async () => {
  const { harness, events, projectPath } = await trackedHarness();
  const previous = harness.context.runtime.diffStats;
  const restarted = await harness.restart();
  harnesses.push(restarted);
  const replacementEvents: unknown[] = [];
  restarted.context.emit = eventSink((event, payload) =>
    replacementEvents.push({ event, payload }),
  );
  const oldEvents = events.length;
  expect(restarted.context.runtime).not.toBe(harness.context.runtime);
  expect(previous.service.trackedIds()).toEqual([]);
  expect(previous.service.isWatching("same-environment")).toBe(false);
  await restarted.context.runtime.diffStats.sync(restarted.context);
  await readTracking(restarted);
  const revision = restarted.context.runtime.diffStats.service.currentRevision();
  const changedEvents = replacementEvents.length;
  await fs.writeFile(path.join(projectPath, "README.md"), "# changed\nsecond line\n");
  await readTracking(restarted);
  expect(replacementEvents.length).toBeGreaterThan(changedEvents);
  expect(events).toHaveLength(oldEvents);
  expect(restarted.context.runtime.diffStats.service.currentRevision().revision).toBeGreaterThan(
    revision.revision,
  );
  const snapshot = restarted.context.runtime.diffStats.service.revisionedSnapshot();
  harness.context.runtime.shutdown();
  previous.service.refresh("same-environment");
  expect(restarted.context.runtime.diffStats.service.revisionedSnapshot()).toEqual(snapshot);
});

test("failed lifecycle drain still shuts down tracking and removes the fixture", async () => {
  const { harness } = await trackedHarness();
  const drain = spyOn(harness.context.environmentLifecycleTasks, "beginShutdown").mockRejectedValue(
    new Error("drain failed"),
  );
  try {
    await expect(harness.cleanup()).rejects.toThrow("drain failed");
    expect(harness.context.runtime.diffStats.service.trackedIds()).toEqual([]);
    expect(recurringWorkDiagnostics().fetchPolicies).toEqual([]);
    expect(await fs.exists(harness.root)).toBe(false);
  } finally {
    drain.mockRestore();
    harnesses.splice(harnesses.indexOf(harness), 1);
  }
});
