import { afterEach, expect, test } from "bun:test";
import type { WorktreeWatchPlanIo } from "./worktree-watch-plan.js";
import type { WatchHandle } from "./watch-host.js";
import {
  startWorktreeWatcher,
  type StartWatch,
  type WorktreeChangeHint,
  type WorktreeWatcher,
} from "./worktree-watcher.js";

/**
 * A rebuilt macOS FSEvents stream loses events under every other watch
 * (`watch-host.ts`). The watcher turns the helper's flag into a pathless
 * rescan, and re-reads the plan's exclusion proof, which the lost events may
 * have invalidated, before it trusts it again.
 */

interface FakeWatch {
  target: string;
  emit: (eventType: string, filename: string | null) => void;
  lose: () => void;
}

function fakeWatches() {
  const watches: FakeWatch[] = [];
  const start: StartWatch = (target, listener) => {
    const lost: Array<() => void> = [];
    watches.push({ target, emit: listener, lose: () => lost.forEach((fire) => fire()) });
    const handle: WatchHandle = {
      on: () => handle,
      close: () => undefined,
      onEventsLost: (fire) => void lost.push(fire),
    };
    return handle;
  };
  const on = (target: string) => watches.find((watch) => watch.target === target)!;
  return { watches, start, on };
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

/** A linked worktree on macOS: one recursive root plus three metadata watches. */
function linkedWorktree(
  listExcluded: () => Promise<readonly string[] | undefined> = async () => ["node_modules"],
) {
  const fake = fakeWatches();
  let listCalls = 0;
  const plan: WorktreeWatchPlanIo = {
    listExcluded: () => {
      listCalls += 1;
      return listExcluded();
    },
    childDirectories: async () => [],
    directoryIdentity: async () => "id",
  };
  const hints: WorktreeChangeHint[] = [];
  const watcher = startWorktreeWatcher({
    worktreePath: "/wt",
    settleMs: 20,
    startWatch: fake.start,
    plan,
    perDirectoryWatches: false,
    comparisonRef: "origin/main",
    resolveGitPaths: async () => ({
      gitDir: "/repo/.git/worktrees/wt",
      commonDir: "/repo/.git",
      linked: true,
    }),
    onChange: (hint) => {
      if (hint) hints.push(hint);
    },
  });
  opened.push(watcher);
  return { ...fake, hints, listCalls: () => listCalls, watcher };
}

test("lost events rescan everything with unknown paths and re-read the proof once per burst", async () => {
  const context = linkedWorktree();
  await until(() => context.watches.length === 4 && context.listCalls() === 1);
  await Bun.sleep(40);
  context.hints.length = 0;

  context.on("/wt").emit("change", "src/a.ts");
  context.on("/wt").lose();
  context.on("/wt").lose();
  context.on("/repo/.git/worktrees/wt").lose();
  await until(() => context.hints.length === 1);
  expect(context.hints[0]).toEqual({ fileList: true, tree: true, overflow: false });
  // The flags may have hidden a `.gitignore` edit, so Git is asked again.
  await until(() => context.listCalls() === 2);
  // The proof came back unchanged, so it holds again: an event inside it is dropped.
  context.on("/wt").emit("change", "node_modules/pkg/index.js");
  context.on("/wt").emit("change", "src/b.ts");
  await until(() => context.hints.length === 2);
  expect(context.hints[1]?.paths).toEqual(["src/b.ts"]);
  // Four flags in one settle window cost one read; this later burst none.
  expect(context.listCalls()).toBe(2);
});

test("a proof invalidated by lost events stops dropping events under the tree", async () => {
  let proof: readonly string[] = ["node_modules"];
  let release: (() => void) | undefined;
  let reads = 0;
  const context = linkedWorktree(async () => {
    reads += 1;
    if (reads > 1) await new Promise<void>((resolve) => (release = resolve));
    return proof;
  });
  await until(() => context.watches.length === 4 && context.listCalls() === 1);
  await Bun.sleep(40);
  context.hints.length = 0;

  // The lost window held the `.gitignore` edit that stopped ignoring it.
  proof = [];
  context.on("/wt").lose();
  await until(() => context.hints.length === 1 && release !== undefined);
  // While Git is being asked, the old proof is not trusted.
  context.on("/wt").emit("change", "node_modules/early.ts");
  await until(() => context.hints.length === 2);
  expect(context.hints[1]?.paths).toEqual(["node_modules/early.ts"]);
  release!();
  // Writes dropped under the old proof before the flag are reported too.
  await until(() => context.hints.length === 3);
  expect(context.hints[2]).toEqual({ fileList: true, tree: true, overflow: false });
  context.on("/wt").emit("change", "node_modules/now-tracked.ts");
  await until(() => context.hints.length === 4);
  expect(context.hints[3]?.paths).toEqual(["node_modules/now-tracked.ts"]);
  expect(context.listCalls()).toBe(2);
});

test("lost events ask Git nothing when nothing is left out", async () => {
  const context = linkedWorktree(async () => []);
  await until(() => context.watches.length === 4 && context.listCalls() === 1);
  await Bun.sleep(40);
  context.hints.length = 0;

  context.on("/wt").lose();
  await until(() => context.hints.length === 1);
  // A later burst settles only after anything the flag queued has started.
  context.on("/wt").emit("change", "src/a.ts");
  await until(() => context.hints.length === 2);
  expect(context.listCalls()).toBe(1);
});

test("every watch of a worktree flagged in one burst costs one hint", async () => {
  const context = linkedWorktree();
  await until(() => context.watches.length === 4);
  await Bun.sleep(40);
  context.hints.length = 0;

  for (const watch of context.watches) watch.lose();
  await until(() => context.hints.length === 1);
  // The next hint is this event's own, so the flags made no second one.
  context.on("/wt").emit("change", "src/c.ts");
  await until(() => context.hints.length === 2);
  expect(context.hints).toEqual([
    { fileList: true, tree: true, overflow: false },
    { fileList: true, tree: true, overflow: false, paths: ["src/c.ts"] },
  ]);
});

test("lost events under Git metadata rescan the file list and keep the paths seen", async () => {
  const context = linkedWorktree();
  await until(() => context.watches.length === 4);
  await Bun.sleep(40);
  context.hints.length = 0;

  context.on("/wt").emit("change", "src/a.ts");
  context.on("/repo/.git/worktrees/wt").lose();
  context.on("/repo/.git/refs").lose();
  await until(() => context.hints.length === 1);
  // The paths cannot name the metadata change, so the hint says it had one.
  expect(context.hints[0]).toEqual({
    fileList: true,
    tree: true,
    overflow: false,
    paths: ["src/a.ts"],
    gitMetadata: true,
  });

  context.on("/repo/.git").lose();
  await until(() => context.hints.length === 2);
  expect(context.hints[1]).toEqual({ fileList: true, tree: false, overflow: false });
});

test("a burst that also touched Git metadata says so beside its paths (todo 7840)", async () => {
  const context = linkedWorktree();
  await until(() => context.watches.length === 4);
  await Bun.sleep(40);
  context.hints.length = 0;

  context.on("/wt").emit("change", "dist/out.js");
  context.on("/repo/.git/worktrees/wt").emit("change", "index");
  await until(() => context.hints.length === 1);
  expect(context.hints[0]).toEqual({
    fileList: true,
    tree: true,
    overflow: false,
    paths: ["dist/out.js"],
    gitMetadata: true,
  });

  // The flag belongs to that burst only.
  context.on("/wt").emit("change", "dist/out.js");
  await until(() => context.hints.length === 2);
  expect(context.hints[1]).toEqual({
    fileList: true,
    tree: true,
    overflow: false,
    paths: ["dist/out.js"],
  });
});
