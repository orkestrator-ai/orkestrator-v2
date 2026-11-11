import { afterEach, expect, test } from "bun:test";
import type { WatchHandle } from "./watch-host.js";
import {
  WATCH_PLAN_MAX_IGNORED_TREE_DIRECTORIES,
  type IgnoredTrees,
  type WorktreeWatchPlanIo,
} from "./worktree-watch-plan.js";
import { startWorktreeWatcher, type StartWatch, type WorktreeWatcher } from "./worktree-watcher.js";

/**
 * On Linux Bun walks a recursive watch's whole tree on the event loop, so a large
 * ignored tree other than `node_modules` is left out, and coverage is withdrawn
 * while it is (to-do 7560 task 1).
 */

const ROOT = "/wt";

function fixture(options: { others: string[]; large: string[] }) {
  const directories = new Map<string, string[]>([
    ["", ["dist", "node_modules", "output", "src"]],
    ["dist", []],
    ["node_modules", []],
    ["output", ["disposable-docker"]],
    ["src", []],
  ]);
  const identities = new Map<string, number>();
  const state = {
    trees: { dependencies: ["node_modules"], others: options.others } as IgnoredTrees | undefined,
    large: new Set(options.large),
    measured: [] as string[],
    listExcludedCalls: 0,
  };
  const live = new Map<string, { emit: (type: string, name: string | null) => void }>();
  const start: StartWatch = (target, listener, { recursive }) => {
    const key = `${recursive ? "recursive" : "direct"} ${target}`;
    live.set(key, { emit: listener });
    const handle: WatchHandle = {
      on: () => handle,
      close: () => void live.delete(key),
    };
    return handle;
  };
  const io: WorktreeWatchPlanIo = {
    listExcluded: async () => {
      state.listExcludedCalls += 1;
      return state.trees?.dependencies;
    },
    listIgnoredTrees: async () => state.trees,
    exceedsDirectories: async (_root, relative, limit) => {
      expect(limit).toBe(WATCH_PLAN_MAX_IGNORED_TREE_DIRECTORIES);
      state.measured.push(relative);
      return state.large.has(relative);
    },
    childDirectories: async (_root, relative) => {
      const children = directories.get(relative);
      if (!children) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return children;
    },
    directoryIdentity: async (_root, relative) =>
      directories.has(relative) ? `id-${identities.get(relative) ?? 0}` : null,
  };
  const watches = () => [...live.keys()].sort();
  const replace = (relative: string) =>
    identities.set(relative, (identities.get(relative) ?? 0) + 1);
  return { state, start, io, watches, live, replace };
}

const opened: WorktreeWatcher[] = [];
afterEach(() => {
  for (const watcher of opened.splice(0)) watcher.close();
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

function open(context: ReturnType<typeof fixture>, perDirectoryWatches = true) {
  let coverage = 0;
  let settled = 0;
  const watcher = startWorktreeWatcher({
    worktreePath: ROOT,
    settleMs: 1,
    startWatch: context.start,
    plan: context.io,
    perDirectoryWatches,
    resolveGitPaths: async () => ({ gitDir: "/wt/.git", commonDir: "/wt/.git", linked: false }),
    onChange: () => {
      settled += 1;
    },
    onCoverageChange: () => {
      coverage += 1;
    },
  });
  opened.push(watcher);
  /** A `.gitignore` edit makes the watcher ask Git again once the burst settles. */
  const replan = () => context.live.get("direct /wt")!.emit("change", ".gitignore");
  return { watcher, coverage: () => coverage, settled: () => settled, replan };
}

test("a large ignored tree is not watched and the watcher never reports qualified", async () => {
  const context = fixture({ others: ["dist", "output"], large: ["output"] });
  const { watcher, coverage } = open(context);
  await until(() => context.watches().includes("recursive /wt/dist"));
  await until(() => context.state.measured.length === 2);
  expect(context.watches()).toEqual(["direct /wt", "recursive /wt/dist", "recursive /wt/src"]);
  expect(watcher.watching).toBe(true);
  expect(watcher.qualified).toBe(false);
  expect(coverage()).toBe(0);
  // The Linux path reads both kinds from one Git listing.
  expect(context.state.listExcludedCalls).toBe(0);
});

test("leaving a tree out withdraws coverage, and putting it back reports it again", async () => {
  const context = fixture({ others: ["dist", "output"], large: [] });
  const { watcher, coverage, replan } = open(context);
  await until(() => watcher.qualified === true);
  expect(coverage()).toBe(1);
  expect(context.watches()).toContain("recursive /wt/output");

  // The tree grew and was made again: the next plan measures it afresh.
  context.state.large.add("output");
  context.replace("output");
  replan();
  await until(() => watcher.qualified === false);
  expect(coverage()).toBe(2);
  await until(() => !context.watches().includes("recursive /wt/output"));

  // It no longer counts as ignored (or is gone): watched again, qualified again.
  context.state.trees = { dependencies: ["node_modules"], others: ["dist"] };
  replan();
  await until(() => watcher.qualified === true);
  expect(coverage()).toBe(3);
  expect(context.watches()).toContain("recursive /wt/output");
});

test("each tree is counted once per directory identity", async () => {
  const context = fixture({ others: ["dist", "output"], large: ["output"] });
  const { replan, settled } = open(context);
  await until(() => context.state.measured.length === 2);
  replan();
  await until(() => settled() > 0);
  // A later replan that reached the plan again: the counts were reused.
  replan();
  await until(() => settled() > 1);
  context.replace("output");
  replan();
  await until(() => context.state.measured.length === 3);
  expect(context.state.measured.sort()).toEqual(["dist", "output", "output"]);
});

test("without Git's answer the last measurement stands, rather than walking the tree", async () => {
  const context = fixture({ others: ["output"], large: ["output"] });
  const { watcher, replan, settled } = open(context);
  await until(() => context.state.measured.length === 1);
  context.state.trees = undefined;
  replan();
  await until(() => settled() > 0);
  // The dependency proof is gone, so node_modules sits under the root watch now…
  await until(() => context.watches().includes("recursive /wt/node_modules"));
  // …but the large tree is still left out.
  expect(context.watches()).not.toContain("recursive /wt/output");
  expect(watcher.qualified).toBe(false);
});

test("macOS keeps one recursive root and measures nothing", async () => {
  const context = fixture({ others: ["output"], large: ["output"] });
  const { watcher } = open(context, false);
  await until(() => context.state.listExcludedCalls === 1);
  await until(() => watcher.qualified === true);
  expect(context.watches()).toEqual(["recursive /wt"]);
  expect(context.state.measured).toEqual([]);
});
