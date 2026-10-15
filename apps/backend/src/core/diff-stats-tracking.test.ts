import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Environment } from "./models.js";
import { createEnvironment } from "./storage.js";
import * as remoteGit from "./git-noninteractive-env.js";
import * as containerExec from "./commands-container-exec.js";
import { createPublicApiHarness, type PublicApiHarness } from "./public-api/test-support.js";

const harnesses: PublicApiHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function harness() {
  const events: unknown[] = [];
  const h = await createPublicApiHarness({
    context: { emit: (event, payload) => events.push({ event, payload }) },
  });
  harnesses.push(h);
  return { h, tracking: h.context.runtime.diffStats, events };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("runtimes isolate snapshots, revisions, emitters, fetch state and reconciliation queues for the same environment", async () => {
  const first = await harness();
  const second = await harness();
  const { projectPath } = await first.h.createRepository("shared");
  const { projectPath: secondPath } = await second.h.createRepository("shared");
  const environment = {
    ...createEnvironment("project", { environmentType: "local" }),
    id: "shared-id",
    worktreePath: projectPath,
    createdFromCommit: "origin/main",
  };
  await first.h.storage.addEnvironment(environment);
  await second.h.storage.addEnvironment({ ...environment, worktreePath: secondPath });
  const loaded = deferred<void>();
  const release = deferred<Environment[]>();
  const load = spyOn(first.h.storage, "loadEnvironments").mockImplementation(async () => {
    loaded.resolve();
    return release.promise;
  });
  const pending = first.tracking.sync(first.h.context);
  try {
    await loaded.promise;
    await second.tracking.sync(second.h.context);
    expect(second.tracking.service.trackedIds()).toEqual(["shared-id"]);
    expect(first.tracking.service.trackedIds()).toEqual([]);
    first.tracking.invalidatePendingSync();
  } finally {
    release.resolve([environment]);
    await pending;
    load.mockRestore();
  }
  expect(first.tracking.service.trackedIds()).toEqual([]);
  await first.tracking.sync(first.h.context);
  const read = (owner: typeof first) =>
    owner.tracking.service.readFileList({
      lookup: { worktreePath: owner === first ? projectPath : secondPath },
      comparisonRef: "origin/main",
      includeUncommitted: true,
      refresh: true,
    });
  await read(first);
  await read(second);
  const secondSnapshot = second.tracking.service.revisionedSnapshot();
  const secondWorktree = second.tracking.service.revisionedWorktreeSnapshot();
  const secondEmits = second.events.length;
  expect(first.tracking.service.currentRevision().generation).not.toBe(secondSnapshot.generation);
  await fs.writeFile(path.join(projectPath, "README.md"), "# changed\nnew line\n");
  await read(first);
  expect(first.tracking.service.revisionedSnapshot().entries[0]?.stats.additions).toBeGreaterThan(
    0,
  );
  expect(second.tracking.service.revisionedSnapshot()).toEqual(secondSnapshot);
  expect(second.tracking.service.revisionedWorktreeSnapshot()).toEqual(secondWorktree);
  expect(second.events).toHaveLength(secondEmits);

  const fetch = spyOn(remoteGit, "runRemoteGit").mockResolvedValue({ stdout: "", stderr: "" });
  try {
    await first.tracking.gitFetchScheduler.ensureFetched(projectPath, "isolated-ref");
    await first.tracking.gitFetchScheduler.ensureFetched(projectPath, "isolated-ref");
    expect(fetch).toHaveBeenCalledTimes(1);
    await second.tracking.gitFetchScheduler.ensureFetched(projectPath, "isolated-ref");
    expect(fetch).toHaveBeenCalledTimes(2);
    first.tracking.invalidateRemoteFreshness(environment);
    await first.tracking.gitFetchScheduler.ensureFetched(projectPath, "isolated-ref");
    expect(fetch).toHaveBeenCalledTimes(3);
    await second.tracking.gitFetchScheduler.ensureFetched(projectPath, "isolated-ref");
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    fetch.mockRestore();
  }
  const scope = { containerId: "shared-container", repoId: "repo", ref: "main" };
  first.tracking.containerGitFetchPolicy.observe(scope, "commit");
  expect(
    second.tracking.containerGitFetchPolicy.freshness(scope.containerId, scope.ref),
  ).toBeUndefined();
  second.tracking.containerGitFetchPolicy.observe(scope, "commit");
  first.tracking.containerGitFetchPolicy.forgetContainer(scope.containerId);
  expect(second.tracking.containerGitFetchPolicy.freshness(scope.containerId, scope.ref)).toEqual({
    state: "not-required",
  });

  first.h.context.runtime.shutdown();
  const firstEmits = first.events.length;
  await fs.writeFile(path.join(secondPath, "README.md"), "# replacement\nnew line\n");
  await read(second);
  expect(second.tracking.service.snapshot()[0]?.stats.additions).toBeGreaterThan(0);
  expect(second.tracking.service.currentRevision().revision).toBeGreaterThan(
    secondSnapshot.revision,
  );
  expect(first.events).toHaveLength(firstEmits);
  expect(first.tracking.service.trackedIds()).toEqual([]);
  expect(second.tracking.service.isWatching("shared-id")).toBe(true);
  expect(second.tracking.containerGitFetchPolicy.freshness(scope.containerId, scope.ref)).toEqual({
    state: "not-required",
  });
});

for (const action of ["invalidate", "shutdown"] as const) {
  test(`sync discards a storage snapshot and queued sync after ${action}`, async () => {
    const { h, tracking } = await harness();
    const loaded = deferred<void>();
    const release = deferred<Environment[]>();
    const environment = {
      ...createEnvironment("project"),
      id: "stale",
      status: "running" as const,
      containerId: "old-container",
    };
    const load = spyOn(h.storage, "loadEnvironments").mockImplementation(async () => {
      loaded.resolve();
      return release.promise;
    });
    const track = spyOn(tracking.service, "track").mockImplementation(() => undefined);
    const retain = spyOn(tracking.containerGitFetchPolicy, "retainContainers");
    const pending = tracking.sync(h.context);
    await loaded.promise;
    const queued = tracking.sync(h.context);
    try {
      if (action === "shutdown") h.context.runtime.shutdown();
      else tracking.invalidatePendingSync();
    } finally {
      release.resolve([environment]);
      await Promise.all([pending, queued]);
    }
    try {
      expect(track).not.toHaveBeenCalled();
      expect(retain).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledTimes(1);
      await tracking.sync(h.context);
      expect(track).toHaveBeenCalledTimes(action === "shutdown" ? 0 : 1);
    } finally {
      load.mockRestore();
      track.mockRestore();
      retain.mockRestore();
    }
  });
}

test("sync retains fetch state only for current running container generations", async () => {
  const { h, tracking } = await harness();
  const environments = [
    {
      ...createEnvironment("project"),
      id: "running",
      status: "running" as const,
      containerId: "live",
    },
    { ...createEnvironment("project"), id: "stopped", containerId: "stopped" },
    {
      ...createEnvironment("project"),
      id: "recreated",
      status: "running" as const,
      containerId: "replacement",
    },
  ];
  for (const environment of environments) await h.storage.addEnvironment(environment);
  const policy = tracking.containerGitFetchPolicy;
  // A failed fetch still owns a cooldown record that reconciliation must drop.
  const exec = spyOn(containerExec, "dockerExec").mockResolvedValue("");
  const track = spyOn(tracking.service, "track").mockImplementation(() => undefined);
  const retained = new Map<string, ReturnType<typeof policy.freshness>>();
  try {
    for (const containerId of ["live", "stopped", "old", "deleted", "replacement"]) {
      policy.observe({ containerId, repoId: "repo", ref: "main" }, "tracking-ref");
    }
    await policy.idle();
    expect(policy.status().records).toBe(5);
    for (const containerId of ["live", "replacement"]) {
      retained.set(containerId, policy.freshness(containerId, "main"));
    }
    await tracking.sync(h.context);
  } finally {
    await policy.idle();
    exec.mockRestore();
    track.mockRestore();
  }
  expect(policy.status().records).toBe(2);
  for (const containerId of ["stopped", "old", "deleted"])
    expect(policy.freshness(containerId, "main")).toBeUndefined();
  for (const containerId of ["live", "replacement"])
    expect(policy.freshness(containerId, "main")).toEqual(retained.get(containerId));
});
