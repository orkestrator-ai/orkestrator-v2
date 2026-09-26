import { describe, expect, test } from "bun:test";
import {
  WORKTREE_SNAPSHOT_CHANGED_EVENT,
  isWorktreeSnapshotState,
} from "@orkestrator/protocol/worktree-snapshots";
import {
  CONTAINER_FETCH_COOLDOWN_MS,
  CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS,
  ContainerGitFetchPolicy,
  classifyFetchFailure,
  containerRepoId,
  formatContainerFetchResponse,
  parseContainerFetchResponse,
  type ContainerFetchChange,
  type ContainerFetchScope,
} from "./container-git-fetch.js";
import { DiffStatsService } from "./diff-stats-service.js";
import { ManualTime, deferred, flushMicrotasks, type Deferred } from "./recurring-test-support.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { WorkAdmissionPool } from "./work-admission.js";

/**
 * The container fetch policy through its command seam (`runFetch`): fetch
 * attempts follow the policy, not the scan cadence. A manual clock and
 * deferred fetches; no container, Git or network. The real fetch/status
 * scripts run against a local bare remote in `container-git-fetch-git.test.ts`.
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPO = "/workspace\t/workspace/.git\t64:1001";

type FetchCall = { containerId: string; ref: string; gate: Deferred<string> };

function createPolicy(
  options: { admission?: WorkAdmissionPool; auto?: (call: FetchCall) => string | Error } = {},
) {
  const time = new ManualTime(1_000_000);
  const metrics = new RecurringWorkMetrics({ now: time.now });
  const calls: FetchCall[] = [];
  const changes: ContainerFetchChange[] = [];
  let auto = options.auto;
  const policy = new ContainerGitFetchPolicy({
    metrics,
    now: time.now,
    wallNow: () => new Date(time.now()).toISOString(),
    admission: options.admission ?? null,
    onChange: (change) => changes.push(change),
    runFetch: (containerId, ref) => {
      const call: FetchCall = { containerId, ref, gate: deferred<string>() };
      calls.push(call);
      if (auto) {
        const value = auto(call);
        if (value instanceof Error) call.gate.reject(value);
        else call.gate.resolve(value);
      }
      return call.gate.promise;
    },
  });
  return {
    time,
    metrics,
    policy,
    calls,
    changes,
    setAuto(next: typeof auto) {
      auto = next;
    },
    fetchKind: () => metrics.snapshot().kinds["git-fetch-container"],
  };
}

function scope(containerId = "container-1", ref = "main", repo = REPO): ContainerFetchScope {
  return { containerId, repoId: containerRepoId(repo), ref };
}

const ok = (before = SHA_A, after = SHA_A, repo = REPO) =>
  formatContainerFetchResponse({ repo, before, after });
const failed = (stderr: string, status = 128) =>
  formatContainerFetchResponse({ repo: REPO, status, stderr });

describe("ContainerGitFetchPolicy", () => {
  test("repeated scans within the cooldown fetch once; the next window fetches again", async () => {
    const owner = createPolicy({ auto: () => ok() });

    // A 5 s Files-panel read cadence for ten minutes.
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 5_000) {
      owner.policy.observe(scope(), "tracking-ref");
      await owner.time.advance(5_000);
    }

    // 120 consultations, one attempt per 5 min window (t=0, t=5 min).
    expect(owner.calls).toHaveLength(2);
    expect(owner.fetchKind()).toMatchObject({
      requested: 120,
      started: 2,
      completed: 2,
      cacheMisses: 2,
      cacheHits: 118,
    });
    expect(owner.policy.freshness("container-1", "main")).toMatchObject({ state: "current" });
  });

  test("concurrent scans join one running fetch", async () => {
    const owner = createPolicy();
    const first = owner.policy.observe(scope(), "tracking-ref");
    owner.policy.observe(scope(), "tracking-ref");
    owner.policy.observe(scope(), "tracking-ref");
    await flushMicrotasks();

    expect(owner.calls).toHaveLength(1);
    expect(first).toEqual({ state: "unknown" });
    expect(owner.fetchKind()).toMatchObject({ requested: 3, coalesced: 2, started: 1 });

    owner.calls[0]!.gate.resolve(ok());
    await owner.policy.idle();
    expect(owner.policy.observe(scope(), "tracking-ref")).toMatchObject({ state: "current" });
    expect(owner.calls).toHaveLength(1);
  });

  test("unrelated containers, re-cloned workspaces and other refs never share", async () => {
    const owner = createPolicy({ auto: () => ok() });
    owner.policy.observe(scope("container-1"), "tracking-ref");
    owner.policy.observe(scope("container-2"), "tracking-ref");
    // The same container with a re-cloned workspace (new inode) is a new clone.
    owner.policy.observe(
      scope("container-1", "main", "/workspace\t/workspace/.git\t64:2002"),
      "tracking-ref",
    );
    // A branch change is a different ref.
    owner.policy.observe(scope("container-1", "release"), "tracking-ref");
    await owner.policy.idle();

    expect(owner.calls.map((call) => `${call.containerId}:${call.ref}`)).toEqual([
      "container-1:main",
      "container-2:main",
      "container-1:main",
      "container-1:release",
    ]);
  });

  test("an immutable commit present in the clone never fetches", async () => {
    const owner = createPolicy({ auto: () => ok() });
    for (let index = 0; index < 20; index += 1) {
      expect(owner.policy.observe(scope("container-1", SHA_A), "commit")).toEqual({
        state: "not-required",
      });
      await owner.time.advance(CONTAINER_FETCH_COOLDOWN_MS);
    }
    expect(owner.calls).toHaveLength(0);
    expect(owner.fetchKind()?.requested ?? 0).toBe(0);
    expect(owner.policy.freshness("container-1", SHA_A)).toEqual({ state: "not-required" });
  });

  test("a missing baseline gets one bounded recovery per cooldown window", async () => {
    const owner = createPolicy({ auto: () => failed("fatal: couldn't find remote ref gone") });

    expect(await owner.policy.recover(scope("container-1", "gone"))).toBe(false);
    expect(owner.calls).toHaveLength(1);
    // Every further read inside the window answers "missing" without the network.
    for (let index = 0; index < 10; index += 1) {
      expect(await owner.policy.recover(scope("container-1", "gone"))).toBe(false);
      await owner.time.advance(5_000);
    }
    expect(owner.calls).toHaveLength(1);
    expect(owner.policy.freshness("container-1", "gone")).toBeUndefined();

    // A ref that appears on the remote later is recovered on the next window.
    owner.setAuto(() => ok("", SHA_B));
    await owner.time.advance(CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS);
    expect(await owner.policy.recover(scope("container-1", "gone"))).toBe(true);
    expect(owner.calls).toHaveLength(2);
    // Recovery re-reads inline, so it does not also ask for a baseline rescan.
    expect(owner.changes.at(-1)).toEqual({
      containerId: "container-1",
      ref: "gone",
      baselineMoved: false,
    });
  });

  test("an unavailable remote leaves the local answer usable with stale freshness", async () => {
    const owner = createPolicy({ auto: () => ok() });
    owner.policy.observe(scope(), "tracking-ref");
    await owner.policy.idle();
    const success = owner.policy.freshness("container-1", "main");
    expect(success).toMatchObject({ state: "current" });

    owner.setAuto(() => failed("fatal: unable to access 'https://x/': Could not resolve host: x"));
    await owner.time.advance(CONTAINER_FETCH_COOLDOWN_MS);
    owner.policy.observe(scope(), "tracking-ref");
    await owner.policy.idle();

    expect(owner.policy.freshness("container-1", "main")).toEqual({
      state: "stale",
      lastSuccessAt: success!.lastSuccessAt,
      failure: "network",
    });
    expect(owner.fetchKind()?.failed).toBe(1);
  });

  test("authentication and network failures back off to a bounded retry rate", async () => {
    const owner = createPolicy({ auto: () => failed("fatal: Authentication failed for 'x'") });
    const attemptsAt: number[] = [];
    const start = owner.time.now();
    // A panel reading every 5 s for four hours against a remote that rejects us.
    for (let elapsed = 0; elapsed < 4 * 60 * 60_000; elapsed += 5_000) {
      const before = owner.calls.length;
      owner.policy.observe(scope(), "tracking-ref");
      await flushMicrotasks();
      if (owner.calls.length > before) attemptsAt.push(owner.time.now() - start);
      await owner.time.advance(5_000);
    }
    const gaps = attemptsAt.slice(1).map((at, index) => at - attemptsAt[index]!);
    expect(gaps.slice(0, 3)).toEqual([5 * 60_000, 10 * 60_000, 20 * 60_000]);
    expect(Math.max(...gaps)).toBe(CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS);
    expect(attemptsAt.length).toBeLessThanOrEqual(12);
    expect(owner.policy.freshness("container-1", "main")).toEqual({
      state: "stale",
      failure: "auth",
    });
  });

  test("a merge invalidates at once; an explicit refresh is rate limited", async () => {
    const owner = createPolicy({ auto: () => ok() });
    owner.policy.observe(scope(), "tracking-ref");
    await owner.policy.idle();
    expect(owner.calls).toHaveLength(1);

    owner.policy.invalidate({ containerId: "container-1" }, "mutation");
    expect(owner.policy.freshness("container-1", "main")).toMatchObject({ state: "stale" });
    owner.policy.observe(scope(), "tracking-ref");
    await owner.policy.idle();
    expect(owner.calls).toHaveLength(2);

    // A click within 15 s of the last attempt joins it.
    await owner.time.advance(5_000);
    owner.policy.invalidate({ containerId: "container-1", ref: "main" }, "explicit");
    owner.policy.observe(scope(), "tracking-ref");
    await owner.policy.idle();
    expect(owner.calls).toHaveLength(2);

    await owner.time.advance(15_000);
    owner.policy.invalidate({ containerId: "container-1", ref: "main" }, "explicit");
    owner.policy.observe(scope(), "tracking-ref");
    await owner.policy.idle();
    expect(owner.calls).toHaveLength(3);
    expect(owner.policy.freshness("container-1", "main")).toMatchObject({ state: "current" });

    // Other containers are untouched.
    owner.policy.invalidate({ containerId: "container-2" }, "mutation");
    owner.policy.observe(scope(), "tracking-ref");
    await owner.policy.idle();
    expect(owner.calls).toHaveLength(3);
  });

  test("an invalidation during an in-flight fetch stays dirty and forces a follow-up", async () => {
    const owner = createPolicy();
    owner.policy.observe(scope(), "tracking-ref");
    await flushMicrotasks();
    expect(owner.calls).toHaveLength(1);

    owner.policy.invalidate({ containerId: "container-1" }, "mutation");
    owner.calls[0]!.gate.resolve(ok());
    await flushMicrotasks();

    // The finished fetch may have read the remote before the merge.
    expect(owner.policy.freshness("container-1", "main")).toMatchObject({ state: "stale" });
    expect(owner.calls).toHaveLength(2);
    owner.calls[1]!.gate.resolve(ok(SHA_A, SHA_B));
    await owner.policy.idle();
    expect(owner.policy.freshness("container-1", "main")).toMatchObject({ state: "current" });
    expect(owner.changes.at(-1)).toEqual({
      containerId: "container-1",
      ref: "main",
      baselineMoved: true,
    });
  });

  test("container recreation discards the old generation, even mid-fetch", async () => {
    const owner = createPolicy();
    owner.policy.observe(scope(), "tracking-ref");
    await flushMicrotasks();
    owner.policy.forgetContainer("container-1");

    // The new generation neither joins nor waits out the old attempt.
    owner.policy.observe(scope(), "tracking-ref");
    await flushMicrotasks();
    expect(owner.calls).toHaveLength(2);

    owner.calls[0]!.gate.resolve(ok(SHA_A, SHA_B));
    await flushMicrotasks();
    // The old attempt settles into nothing: no change, no stamp.
    expect(owner.changes).toHaveLength(0);
    expect(owner.policy.freshness("container-1", "main")).toEqual({ state: "unknown" });

    owner.calls[1]!.gate.resolve(ok());
    await owner.policy.idle();
    expect(owner.policy.freshness("container-1", "main")).toMatchObject({ state: "current" });

    // Lifecycle reconciliation forgets containers that are no longer running.
    owner.policy.retainContainers([]);
    expect(owner.policy.freshness("container-1", "main")).toBeUndefined();
    expect(owner.policy.status().records).toBe(0);
  });

  test("a fetch that moves origin/<ref> asks for one baseline rescan", async () => {
    const owner = createPolicy({ auto: () => ok(SHA_A, SHA_B) });
    owner.policy.observe(scope(), "tracking-ref");
    await owner.policy.idle();
    expect(owner.changes).toEqual([
      { containerId: "container-1", ref: "main", baselineMoved: true },
    ]);

    owner.setAuto(() => ok(SHA_B, SHA_B));
    await owner.time.advance(CONTAINER_FETCH_COOLDOWN_MS);
    owner.policy.observe(scope(), "tracking-ref");
    await owner.policy.idle();
    expect(owner.changes.at(-1)).toMatchObject({ baselineMoved: false });
  });

  test("a fetch reporting a different clone is superseded and stamps nothing", async () => {
    const owner = createPolicy({ auto: () => ok(SHA_A, SHA_B, "/workspace\t/other\t1:1") });
    owner.policy.observe(scope(), "tracking-ref");
    await owner.policy.idle();
    expect(owner.policy.freshness("container-1", "main")).toEqual({ state: "unknown" });
    expect(owner.changes.every((change) => !change.baselineMoved)).toBe(true);
  });
});

describe("ContainerGitFetchPolicy admission", () => {
  const target = "container:container-1";

  test("a fetch waits for the container's scan slot and never overlaps it", async () => {
    const time = new ManualTime(0);
    const pool = new WorkAdmissionPool({
      name: "git-docker-scan",
      now: time.now,
      diagnostics: null,
    });
    const owner = createPolicy({ admission: pool, auto: () => ok() });

    const scanLease = await pool.acquire({ kind: "diff-scan", priority: "interactive", target });
    owner.policy.observe(scope(), "tracking-ref");
    await flushMicrotasks();
    expect(owner.calls).toHaveLength(0);
    expect(pool.status().waiting).toBe(1);

    // Another container's scan is not held up by it.
    const other = await pool.acquire({
      kind: "diff-scan",
      priority: "interactive",
      target: "container:container-2",
    });
    other.release();

    scanLease.release();
    await owner.policy.idle();
    expect(owner.calls).toHaveLength(1);
    expect(pool.status()).toMatchObject({ active: 0, waiting: 0 });
  });

  test("recovery inside the scan slot takes over a queued fetch instead of deadlocking", async () => {
    const time = new ManualTime(0);
    const pool = new WorkAdmissionPool({
      name: "git-docker-scan",
      now: time.now,
      diagnostics: null,
    });
    const owner = createPolicy({ admission: pool });

    // The scan holds the container's slot; a background fetch queues behind it.
    const scanLease = await pool.acquire({ kind: "diff-scan", priority: "interactive", target });
    owner.policy.observe(scope(), "tracking-ref");
    await flushMicrotasks();
    expect(pool.status().waiting).toBe(1);
    expect(owner.calls).toHaveLength(0);

    // The same scan then finds its baseline missing and recovers in its slot.
    const recovering = owner.policy.recover(scope());
    await flushMicrotasks();
    expect(pool.status().waiting).toBe(0);
    expect(owner.calls).toHaveLength(1);
    owner.calls[0]!.gate.resolve(ok());
    expect(await recovering).toBe(true);
    scanLease.release();
    await owner.policy.idle();
    await flushMicrotasks();
    // Exactly one fetch: the queued attempt was performed inline, not twice.
    expect(owner.calls).toHaveLength(1);
    expect(owner.fetchKind()).toMatchObject({ started: 1, coalesced: 1 });
    expect(pool.status()).toMatchObject({ active: 0, waiting: 0 });
  });
});

describe("ContainerGitFetchPolicy bounds", () => {
  test("records are bounded by count and age; in-flight ownership is never evicted", async () => {
    const time = new ManualTime(0);
    const policy = new ContainerGitFetchPolicy({
      now: time.now,
      maxRecords: 3,
      recordIdleMs: 60_000,
      metrics: new RecurringWorkMetrics({ now: time.now }),
      runFetch: () => new Promise<string>(() => undefined),
    });
    for (let index = 0; index < 6; index += 1) {
      policy.observe(scope(`container-${index}`), "tracking-ref");
    }
    // Every record owns a running fetch: none may be dropped.
    expect(policy.status()).toMatchObject({ records: 6, inFlight: 6, evicted: 0 });
    expect(policy.observe(scope("container-0"), "tracking-ref")).toEqual({ state: "unknown" });
    expect(policy.status().inFlight).toBe(6);

    const settled = new ContainerGitFetchPolicy({
      now: time.now,
      maxRecords: 3,
      recordIdleMs: 60_000,
      metrics: new RecurringWorkMetrics({ now: time.now }),
      runFetch: async () => ok(),
    });
    for (let index = 0; index < 6; index += 1) {
      settled.observe(scope(`container-${index}`), "tracking-ref");
      await settled.idle();
    }
    expect(settled.status().records).toBeLessThanOrEqual(3);
    time.jump(120_000);
    settled.observe(scope("container-new"), "tracking-ref");
    await settled.idle();
    expect(settled.status().records).toBe(1);
  });
});

describe("container fetch responses", () => {
  test("parses framed output and classifies failures without retaining text", () => {
    expect(parseContainerFetchResponse(ok(SHA_A, SHA_B))).toEqual({
      kind: "fetched",
      repoId: containerRepoId(REPO),
      before: SHA_A,
      after: SHA_B,
    });
    const secret = "fatal: Authentication failed for 'https://token-123@github.com/x'";
    const parsed = parseContainerFetchResponse(failed(secret));
    expect(parsed).toEqual({ kind: "failed", failure: "auth" });
    expect(JSON.stringify(parsed)).not.toContain("token-123");

    expect(parseContainerFetchResponse("garbage")).toEqual({ kind: "failed", failure: "error" });
    expect(parseContainerFetchResponse(`x${ok()}`)).toEqual({ kind: "failed", failure: "error" });
    expect(parseContainerFetchResponse(`${ok()}x`)).toEqual({ kind: "failed", failure: "error" });
    expect(
      parseContainerFetchResponse(
        formatContainerFetchResponse({ repo: REPO, before: "not-a-sha" }),
      ),
    ).toEqual({ kind: "failed", failure: "error" });
  });

  test("maps exit status and stderr to finite categories", () => {
    expect(classifyFetchFailure(124, "")).toBe("timeout");
    expect(classifyFetchFailure(128, "fatal: could not read Username for 'https://x'")).toBe(
      "auth",
    );
    expect(classifyFetchFailure(128, "git@x: Permission denied (publickey).")).toBe("auth");
    expect(classifyFetchFailure(128, "fatal: couldn't find remote ref feature")).toBe(
      "missing-ref",
    );
    expect(
      classifyFetchFailure(128, "fatal: 'origin' does not appear to be a git repository"),
    ).toBe("no-remote");
    expect(classifyFetchFailure(128, "ssh: Could not resolve hostname x")).toBe("network");
    expect(classifyFetchFailure(128, "fatal: unable to access 'x': Failed to connect")).toBe(
      "network",
    );
    expect(classifyFetchFailure(1, "something else")).toBe("error");
  });
});

describe("remote freshness in worktree snapshots", () => {
  test("container snapshots carry and republish remote freshness", async () => {
    const time = new ManualTime(0);
    const events: any[] = [];
    let freshness: any = { state: "unknown" };
    const service = new DiffStatsService({
      monotonicNow: time.now,
      now: () => new Date(time.now()).toISOString(),
      schedule: (callback, intervalMs) => time.setInterval(callback, intervalMs),
      cancel: (timer) => time.clear(timer),
      delay: (callback, delayMs) => time.setTimeout(callback, delayMs),
      cancelDelay: (timer) => time.clear(timer),
      metrics: new RecurringWorkMetrics({ now: time.now }),
      emit: (event, payload) => {
        if (event === WORKTREE_SNAPSHOT_CHANGED_EVENT) events.push(payload);
      },
      remoteFreshness: (target) => (target.kind === "container" ? freshness : undefined),
      scan: async () => ({
        stats: { additions: 0, deletions: 0, filesChanged: 0, truncated: false },
        changes: [],
      }),
    });
    service.track({
      environmentId: "env-1",
      kind: "container",
      containerId: "container-1",
      comparisonRef: "main",
    });
    await flushMicrotasks();
    expect(events.at(-1)).toMatchObject({ remote: { state: "unknown" } });
    expect(isWorktreeSnapshotState(events.at(-1))).toBe(true);

    const published = events.length;
    freshness = { state: "current", lastSuccessAt: new Date(0).toISOString() };
    service.remoteFreshnessChanged({ containerId: "container-1" });
    expect(events).toHaveLength(published + 1);
    expect(events.at(-1)).toMatchObject({ remote: freshness, fileListRevision: 1 });
    // Unchanged freshness announces nothing.
    service.remoteFreshnessChanged({ containerId: "container-1" });
    expect(events).toHaveLength(published + 1);
    expect(service.worktreeSnapshotEntries()[0]?.remote).toEqual(freshness);
    service.shutdown();
  });
});
