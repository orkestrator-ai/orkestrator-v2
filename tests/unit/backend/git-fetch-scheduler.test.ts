import { describe, expect, test } from "bun:test";
import { GitFetchScheduler } from "../../../apps/backend/src/core/git-fetch-scheduler";

interface Harness {
  scheduler: GitFetchScheduler;
  calls: string[][];
  fetches: string[][];
  clock: { value: number };
  /** Holds the next fetch open until released. */
  block: () => () => void;
  failFetches: (shouldFail: boolean) => void;
  /** Makes the common-dir resolve fail, as an old git or a non-repo would. */
  failResolve: (shouldFail: boolean) => void;
  setCommonDir: (worktreePath: string, commonDir: string) => void;
}

function createHarness(options: { ttlMs?: number } = {}): Harness {
  const calls: string[][] = [];
  const fetches: string[][] = [];
  const clock = { value: 0 };
  const commonDirs = new Map<string, string>();
  let pendingRelease: (() => void) | undefined;
  let blockNext = false;
  let fetchFails = false;
  let resolveFails = false;

  const scheduler = new GitFetchScheduler({
    ttlMs: options.ttlMs,
    now: () => clock.value,
    run: async (args) => {
      calls.push(args);
      if (args.includes("--git-common-dir")) {
        if (resolveFails) throw new Error("old git");
        const worktreePath = args[1]!;
        return { stdout: `${commonDirs.get(worktreePath) ?? "/repo/.git"}\n` };
      }
      fetches.push(args);
      if (blockNext) {
        blockNext = false;
        await new Promise<void>((resolve) => {
          pendingRelease = resolve;
        });
      }
      if (fetchFails) throw new Error("network down");
      return { stdout: "" };
    },
  });

  return {
    scheduler,
    calls,
    fetches,
    clock,
    block() {
      blockNext = true;
      return () => pendingRelease?.();
    },
    failFetches(shouldFail) {
      fetchFails = shouldFail;
    },
    failResolve(shouldFail) {
      resolveFails = shouldFail;
    },
    setCommonDir(worktreePath, commonDir) {
      commonDirs.set(worktreePath, commonDir);
    },
  };
}

describe("GitFetchScheduler", () => {
  test("fetches on first request", async () => {
    const harness = createHarness();

    await harness.scheduler.ensureFetched("/wt/a", "main");

    expect(harness.fetches).toEqual([["-C", "/wt/a", "fetch", "origin", "main"]]);
  });

  test("does not fetch again within the ttl", async () => {
    const harness = createHarness({ ttlMs: 60_000 });
    await harness.scheduler.ensureFetched("/wt/a", "main");

    harness.clock.value += 30_000;
    await harness.scheduler.ensureFetched("/wt/a", "main");

    expect(harness.fetches).toHaveLength(1);
  });

  test("fetches again once the ttl expires", async () => {
    const harness = createHarness({ ttlMs: 60_000 });
    await harness.scheduler.ensureFetched("/wt/a", "main");

    harness.clock.value += 60_001;
    await harness.scheduler.ensureFetched("/wt/a", "main");

    expect(harness.fetches).toHaveLength(2);
  });

  // The point of the whole module: worktrees of one repository share an origin,
  // so N environments must not open N round trips for the same refs.
  test("shares one fetch across every worktree of a repository", async () => {
    const harness = createHarness({ ttlMs: 60_000 });
    harness.setCommonDir("/wt/a", "/repo/.git");
    harness.setCommonDir("/wt/b", "/repo/.git");
    harness.setCommonDir("/wt/c", "/repo/.git");

    await harness.scheduler.ensureFetched("/wt/a", "main");
    await harness.scheduler.ensureFetched("/wt/b", "main");
    await harness.scheduler.ensureFetched("/wt/c", "main");

    expect(harness.fetches).toHaveLength(1);
  });

  test("does not share a fetch between different repositories", async () => {
    const harness = createHarness({ ttlMs: 60_000 });
    harness.setCommonDir("/wt/a", "/repo-one/.git");
    harness.setCommonDir("/wt/b", "/repo-two/.git");

    await harness.scheduler.ensureFetched("/wt/a", "main");
    await harness.scheduler.ensureFetched("/wt/b", "main");

    expect(harness.fetches).toHaveLength(2);
  });

  test("does not share a fetch between different refs", async () => {
    const harness = createHarness({ ttlMs: 60_000 });

    await harness.scheduler.ensureFetched("/wt/a", "main");
    await harness.scheduler.ensureFetched("/wt/a", "develop");

    expect(harness.fetches).toHaveLength(2);
  });

  test("concurrent callers await the one in-flight fetch", async () => {
    const harness = createHarness({ ttlMs: 60_000 });
    const release = harness.block();

    const first = harness.scheduler.ensureFetched("/wt/a", "main");
    const second = harness.scheduler.ensureFetched("/wt/a", "main");
    const third = harness.scheduler.ensureFetched("/wt/b", "main");

    // The common-dir resolve is awaited before the fetch starts, so the fetch
    // does not exist to release until the microtask queue has drained.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second, third]);

    expect(harness.fetches).toHaveLength(1);
  });

  // A failed fetch degrades to reading whatever refs are already local, which is
  // exactly what the inline fetch it replaced did.
  test("never rejects when the fetch fails", async () => {
    const harness = createHarness();
    harness.failFetches(true);

    await expect(harness.scheduler.ensureFetched("/wt/a", "main")).resolves.toBeUndefined();
  });

  test("a failed fetch still counts against the ttl", async () => {
    const harness = createHarness({ ttlMs: 60_000 });
    harness.failFetches(true);
    await harness.scheduler.ensureFetched("/wt/a", "main");

    await harness.scheduler.ensureFetched("/wt/a", "main");

    // Otherwise an unreachable remote would be retried on every single read.
    expect(harness.fetches).toHaveLength(1);
  });

  test("resolves the common dir once per worktree", async () => {
    const harness = createHarness({ ttlMs: 0 });

    await harness.scheduler.ensureFetched("/wt/a", "main");
    await harness.scheduler.ensureFetched("/wt/a", "main");
    await harness.scheduler.ensureFetched("/wt/a", "develop");

    const resolves = harness.calls.filter((args) => args.includes("--git-common-dir"));
    expect(resolves).toHaveLength(1);
  });

  // Losing the sharing is acceptable; fetching the wrong repository is not, and
  // the fetch itself still runs with -C worktreePath.
  test("degrades to per-worktree keying when the common dir cannot be resolved", async () => {
    const harness = createHarness({ ttlMs: 60_000 });
    harness.failResolve(true);

    await harness.scheduler.ensureFetched("/wt/a", "main");
    await harness.scheduler.ensureFetched("/wt/b", "main");

    expect(harness.fetches).toEqual([
      ["-C", "/wt/a", "fetch", "origin", "main"],
      ["-C", "/wt/b", "fetch", "origin", "main"],
    ]);
  });

  test("invalidate forces the next request to fetch", async () => {
    const harness = createHarness({ ttlMs: 60_000 });
    await harness.scheduler.ensureFetched("/wt/a", "main");

    harness.scheduler.invalidate("/wt/a", "main");
    await Promise.resolve();
    await harness.scheduler.ensureFetched("/wt/a", "main");

    expect(harness.fetches).toHaveLength(2);
  });

  test("invalidate without a ref clears every ref for the repository", async () => {
    const harness = createHarness({ ttlMs: 60_000 });
    await harness.scheduler.ensureFetched("/wt/a", "main");
    await harness.scheduler.ensureFetched("/wt/a", "develop");

    harness.scheduler.invalidate("/wt/a");
    await Promise.resolve();
    await harness.scheduler.ensureFetched("/wt/a", "main");
    await harness.scheduler.ensureFetched("/wt/a", "develop");

    expect(harness.fetches).toHaveLength(4);
  });

  test("invalidate is safe for a worktree that was never fetched", () => {
    const harness = createHarness();
    expect(() => harness.scheduler.invalidate("/wt/unknown")).not.toThrow();
  });

  test("forget makes a recreated worktree resolve its common dir again", async () => {
    const harness = createHarness({ ttlMs: 60_000 });
    await harness.scheduler.ensureFetched("/wt/a", "main");

    harness.scheduler.forget("/wt/a");
    await harness.scheduler.ensureFetched("/wt/a", "main");

    const resolves = harness.calls.filter((args) => args.includes("--git-common-dir"));
    expect(resolves).toHaveLength(2);
  });
});
