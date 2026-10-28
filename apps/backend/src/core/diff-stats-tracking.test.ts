import { afterEach, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Environment } from "./models.js";
import { createEnvironment } from "./storage.js";
import { runCommand } from "./shell.js";
import * as baselineGit from "./diff-baseline.js";
import * as remoteGit from "./git-noninteractive-env.js";
import * as containerExec from "./commands-container-exec.js";
import { createPublicApiHarness, type PublicApiHarness } from "./public-api/test-support.js";

// This slow-tier file creates real repositories/worktrees and waits for
// subprocess cleanup. Give that fixture work its own bounded host budget;
// explicit operation deadlines and shorter test budgets remain unchanged.
setDefaultTimeout(30_000);

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

test("git-status scanners stay statically imported without a dynamic import cycle workaround", async () => {
  const source = await fs.readFile(new URL("./diff-stats-tracking.ts", import.meta.url), "utf8");
  expect(source).toMatch(/^\s*import\s[^;]*from\s+["']\.\/commands-files\.js["'];/m);
  expect(source).not.toMatch(/\bimport\s*\(\s*["']\.\/commands-files(?:\.js)?["']/);
});

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

test("a worker that takes in newer target history is retargeted to where its branch now leaves it", async () => {
  const { h, tracking } = await harness();
  const { projectPath } = await h.createRepository("baseline");
  const run = (cwd: string, args: string[]) =>
    runCommand("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@e.invalid",
      ...args,
    ]).then(({ stdout }) => stdout.trim());
  const created = await run(projectPath, ["rev-parse", "HEAD"]);
  const worktreePath = path.join(path.dirname(projectPath), "baseline-worker");
  await run(projectPath, ["worktree", "add", "--no-track", "-b", "worker", worktreePath, created]);
  const environment = {
    ...createEnvironment("project", { environmentType: "local" }),
    id: "worker",
    worktreePath,
    createdFromCommit: created,
  };
  await h.storage.addEnvironment(environment);
  await tracking.sync(h.context);

  // The target moves on, and the worker merges it.
  await fs.writeFile(path.join(projectPath, "upstream.txt"), "upstream\n");
  await run(projectPath, ["add", "upstream.txt"]);
  await run(projectPath, ["commit", "-m", "upstream"]);
  await run(projectPath, ["push", "origin", "main"]);
  const tip = await run(projectPath, ["rev-parse", "HEAD"]);
  await run(worktreePath, ["fetch", "origin"]);
  await run(worktreePath, ["merge", "--ff-only", "origin/main"]);

  const retargeted = deferred<void>();
  const sync = tracking.sync.bind(tracking);
  const spy = spyOn(tracking, "sync").mockImplementation(async (context) => {
    await sync(context);
    retargeted.resolve();
  });
  try {
    // Measured from the creation commit, the merged upstream reads as the worker's own.
    const before = await tracking.service.readFileList({
      lookup: { worktreePath },
      comparisonRef: created,
      includeUncommitted: true,
      refresh: true,
    });
    expect(before.changes).toEqual([expect.objectContaining({ path: "upstream.txt" })]);
    await retargeted.promise;
  } finally {
    spy.mockRestore();
  }

  expect((await h.storage.getEnvironment("worker"))?.diffBaseline).toEqual({
    createdFromCommit: created,
    commit: tip,
  });
  const result = await tracking.service.readFileList({
    lookup: { worktreePath },
    comparisonRef: tip,
    includeUncommitted: true,
    refresh: true,
  });
  expect(result.changes).toEqual([]);
});

// Suppress automatic watcher scans so each race has a deterministic admission
// point; drive the baseline owner and wait for its coalesced work to settle.
function baselineOwner(tracking: Awaited<ReturnType<typeof harness>>["tracking"]) {
  return tracking as unknown as {
    checkBaseline(id: string): void;
    baselineChecks: Map<string, unknown>;
  };
}

async function idleBaseline(tracking: Awaited<ReturnType<typeof harness>>["tracking"]) {
  const owner = baselineOwner(tracking);
  const deadline = Date.now() + 5000;
  while (owner.baselineChecks.size && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(owner.baselineChecks.size).toBe(0);
}

async function baselineFixture(options: Partial<Environment> = {}) {
  const { h, tracking } = await harness();
  const { projectPath } = await h.createRepository("baseline-races");
  const git = (cwd: string, ...args: string[]) =>
    runCommand("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@e.invalid",
      ...args,
    ]).then(({ stdout }) => stdout.trim());
  const created = await git(projectPath, "rev-parse", "HEAD");
  const worktreePath = path.join(path.dirname(projectPath), "worker");
  await git(projectPath, "worktree", "add", "--no-track", "-b", "worker", worktreePath, created);
  await fs.writeFile(path.join(projectPath, "upstream.txt"), "imported\n");
  await git(projectPath, "add", ".");
  await git(projectPath, "commit", "-m", "upstream");
  await git(projectPath, "push", "origin", "main");
  const tip = await git(projectPath, "rev-parse", "HEAD");
  await git(worktreePath, "merge", "--ff-only", "origin/main");
  await fs.writeFile(path.join(worktreePath, "own.txt"), "worker\n");
  await git(worktreePath, "add", ".");
  await git(worktreePath, "commit", "-m", "own work");
  const baseline = { createdFromCommit: created, commit: tip };
  const environment = {
    ...createEnvironment("project", { environmentType: "local" }),
    id: "worker",
    worktreePath,
    createdFromCommit: created,
    diffBaseline: baseline,
    prState: "open" as const,
    ...options,
  };
  await h.storage.addEnvironment(environment);
  const track = spyOn(tracking.service, "track").mockImplementation(() => undefined);
  try {
    await tracking.sync(h.context);
  } finally {
    track.mockRestore();
  }
  return { h, tracking, git, projectPath, worktreePath, created, tip, baseline };
}

for (const failure of ["merge-base", "ancestry", "missing-ref"] as const) {
  test(`an advanced baseline survives an inconclusive ${failure} probe`, async () => {
    const f = await baselineFixture();
    if (failure === "merge-base") {
      // The local main can lag the remote. It must not become authoritative
      // merely because probing the remote fails.
      await f.git(f.worktreePath, "update-ref", "refs/heads/main", f.created);
    }
    if (failure === "missing-ref") {
      await f.git(f.worktreePath, "update-ref", "-d", "refs/remotes/origin/main");
      await f.git(f.worktreePath, "update-ref", "-d", "refs/heads/main");
    }
    const realGit = baselineGit.localBaselineGit(f.worktreePath);
    const probe = spyOn(baselineGit, "localBaselineGit").mockReturnValue(async (args) => {
      if (failure === "merge-base" && args[2] === "refs/remotes/origin/main") return null;
      if (failure === "ancestry" && args[0] === "merge-base" && args[1] !== "HEAD") return null;
      return realGit(args);
    });
    const update = spyOn(f.h.storage, "updateEnvironment");
    try {
      baselineOwner(f.tracking).checkBaseline("worker");
      await idleBaseline(f.tracking);
      expect(update).not.toHaveBeenCalled();
      expect((await f.h.storage.getEnvironment("worker"))?.diffBaseline).toEqual(f.baseline);
    } finally {
      probe.mockRestore();
      update.mockRestore();
    }
  });
}

test("a successful reset to creation clears the advanced baseline and retargets scans", async () => {
  const f = await baselineFixture();
  await f.git(f.worktreePath, "reset", "--hard", f.created);
  baselineOwner(f.tracking).checkBaseline("worker");
  await idleBaseline(f.tracking);
  expect((await f.h.storage.getEnvironment("worker"))?.diffBaseline).toBeNull();
  const snapshot = await f.tracking.service.readFileList({
    lookup: { worktreePath: f.worktreePath },
    comparisonRef: f.created,
    includeUncommitted: true,
    refresh: true,
  });
  expect(snapshot.changes).toEqual([]);
});

for (const timing of ["cached", "in-flight", "queued-write"] as const) {
  test(`a ${timing} candidate cannot consume the worker commits after its PR merges`, async () => {
    const f = await baselineFixture();
    await f.git(f.projectPath, "merge", "--ff-only", "worker");
    await f.git(f.projectPath, "push", "origin", "main");
    const started = deferred<void>();
    const release = deferred<void>();
    const realGit = baselineGit.localBaselineGit(f.worktreePath);
    const probe = spyOn(baselineGit, "localBaselineGit").mockReturnValue(async (args) => {
      const result = await realGit(args);
      if (timing === "in-flight") {
        started.resolve();
        await release.promise;
      }
      return result;
    });
    const originalUpdate = f.h.storage.updateEnvironment.bind(f.h.storage);
    const update = spyOn(f.h.storage, "updateEnvironment").mockImplementation(
      async (id, updates, guard) => {
        if (timing === "queued-write" && "diffBaseline" in updates) {
          started.resolve();
          await release.promise;
        }
        return originalUpdate(id, updates, guard);
      },
    );
    try {
      if (timing === "cached") await originalUpdate("worker", { prState: "merged" });
      baselineOwner(f.tracking).checkBaseline("worker");
      if (timing !== "cached") {
        await started.promise;
        await originalUpdate("worker", { prState: "merged" });
      }
      release.resolve();
      await idleBaseline(f.tracking);
      expect((await f.h.storage.getEnvironment("worker"))?.diffBaseline).toEqual(f.baseline);
      const files = await f.tracking.service.readFileList({
        lookup: { worktreePath: f.worktreePath },
        comparisonRef: f.tip,
        includeUncommitted: true,
        refresh: true,
      });
      expect(files.changes).toEqual([expect.objectContaining({ path: "own.txt" })]);
    } finally {
      release.resolve();
      probe.mockRestore();
      update.mockRestore();
    }
  });
}

for (const change of [
  { prBaseBranch: "release" },
  { worktreePath: "/another-checkout" },
  { createdFromCommit: "c".repeat(40) },
] as const) {
  test(`an in-flight baseline is fenced after ${Object.keys(change)[0]} changes`, async () => {
    const f = await baselineFixture();
    await f.git(f.worktreePath, "reset", "--hard", f.created);
    const started = deferred<void>();
    const release = deferred<void>();
    const realGit = baselineGit.localBaselineGit(f.worktreePath);
    const probe = spyOn(baselineGit, "localBaselineGit").mockReturnValue(async (args) => {
      const result = await realGit(args);
      started.resolve();
      await release.promise;
      return result;
    });
    const track = spyOn(f.tracking.service, "track").mockImplementation(() => undefined);
    try {
      baselineOwner(f.tracking).checkBaseline("worker");
      await started.promise;
      await f.h.storage.updateEnvironment("worker", change);
      release.resolve();
      await idleBaseline(f.tracking);
      expect((await f.h.storage.getEnvironment("worker"))?.diffBaseline).toEqual(f.baseline);
    } finally {
      release.resolve();
      probe.mockRestore();
      track.mockRestore();
    }
  });
}

test("scan bursts coalesce into a rerun that observes the final reset", async () => {
  const f = await baselineFixture();
  const started = deferred<void>();
  const release = deferred<void>();
  const realGit = baselineGit.localBaselineGit(f.worktreePath);
  let calls = 0;
  const probe = spyOn(baselineGit, "localBaselineGit").mockImplementation(() => {
    calls += 1;
    if (calls === 1)
      return async (args) => {
        const result = await realGit(args);
        if (args[0] === "merge-base" && args[1] !== "HEAD") {
          started.resolve();
          await release.promise;
        }
        return result;
      };
    return realGit;
  });
  const track = spyOn(f.tracking.service, "track").mockImplementation(() => undefined);
  try {
    const owner = baselineOwner(f.tracking);
    owner.checkBaseline("worker");
    await started.promise;
    owner.checkBaseline("worker");
    owner.checkBaseline("worker");
    await f.git(f.worktreePath, "reset", "--hard", f.created);
    release.resolve();
    await idleBaseline(f.tracking);
    expect((await f.h.storage.getEnvironment("worker"))?.diffBaseline).toBeNull();
    expect(calls).toBe(2);
  } finally {
    release.resolve();
    probe.mockRestore();
    track.mockRestore();
  }
});

for (const options of [{ prState: "merged" as const }, { projectHome: true }]) {
  test(`sync skips baseline checks for ${Object.keys(options)[0]}`, async () => {
    const f = await baselineFixture(options);
    const probe = spyOn(baselineGit, "localBaselineGit");
    try {
      baselineOwner(f.tracking).checkBaseline("worker");
      await idleBaseline(f.tracking);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
    }
  });
}

test("a storage failure releases the check and a later scan can retry", async () => {
  const f = await baselineFixture();
  await f.git(f.worktreePath, "reset", "--hard", f.created);
  const update = spyOn(f.h.storage, "updateEnvironment").mockRejectedValue(
    new Error("write failed"),
  );
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    baselineOwner(f.tracking).checkBaseline("worker");
    await idleBaseline(f.tracking);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("diff baseline"), "write failed");
    expect((await f.h.storage.getEnvironment("worker"))?.diffBaseline).toEqual(f.baseline);
  } finally {
    update.mockRestore();
    warning.mockRestore();
  }
  baselineOwner(f.tracking).checkBaseline("worker");
  await idleBaseline(f.tracking);
  expect((await f.h.storage.getEnvironment("worker"))?.diffBaseline).toBeNull();
});

test("a repository target change fences a baseline write waiting for storage admission", async () => {
  const f = await baselineFixture();
  await f.git(f.worktreePath, "reset", "--hard", f.created);
  const started = deferred<void>();
  const release = deferred<void>();
  const original = f.h.storage.updateEnvironment.bind(f.h.storage);
  const update = spyOn(f.h.storage, "updateEnvironment").mockImplementation(
    async (id, updates, guard) => {
      started.resolve();
      await release.promise;
      return original(id, updates, guard);
    },
  );
  const track = spyOn(f.tracking.service, "track").mockImplementation(() => undefined);
  try {
    baselineOwner(f.tracking).checkBaseline("worker");
    await started.promise;
    await f.h.storage.patchRepositoryConfig("project", { prBaseBranch: "release" });
    release.resolve();
    await idleBaseline(f.tracking);
    expect((await f.h.storage.getEnvironment("worker"))?.diffBaseline).toEqual(f.baseline);
  } finally {
    release.resolve();
    update.mockRestore();
    track.mockRestore();
  }
});
