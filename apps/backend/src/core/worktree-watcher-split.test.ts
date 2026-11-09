import { afterEach, describe, expect, test } from "bun:test";
import type { FSWatcher } from "node:fs";
import type { WorktreeWatchPlanIo } from "./worktree-watch-plan.js";
import {
  startWorktreeWatcher,
  WATCH_BURST_OVERFLOW_EVENTS,
  type StartWatch,
  type WorktreeChangeHint,
  type WorktreeWatcher,
} from "./worktree-watcher.js";

const ROOT = "/wt";

interface Watch {
  target: string;
  recursive: boolean;
  emit: (eventType: string, filename: string | null) => void;
  fail: (error: unknown) => void;
  closed: boolean;
}

/** Fake watches and a fake tree, so a plan's moves can be read directly. */
function fixture(initial: {
  directories: Record<string, string[]>;
  excluded: readonly string[] | undefined;
}) {
  const directories = new Map(Object.entries(initial.directories));
  const identities = new Map<string, number>();
  const state = {
    excluded: initial.excluded,
    listCalls: 0,
    refuse: new Map<string, unknown>(),
  };
  const watches: Watch[] = [];
  const start: StartWatch = (target, listener, options) => {
    const refusal =
      state.refuse.get(target) ??
      state.refuse.get(`${options.recursive ? "recursive" : "direct"} ${target}`);
    if (refusal) throw refusal;
    const errorHandlers = new Set<(error: unknown) => void>();
    const watch: Watch = {
      target,
      recursive: options.recursive,
      emit: listener,
      fail: (error) => {
        for (const handler of errorHandlers) handler(error);
      },
      closed: false,
    };
    watches.push(watch);
    return {
      on(event: string, handler: (error: unknown) => void) {
        if (event === "error") errorHandlers.add(handler);
        return this;
      },
      close() {
        watch.closed = true;
      },
    } as unknown as FSWatcher;
  };
  const io: WorktreeWatchPlanIo = {
    listExcluded: async () => {
      state.listCalls += 1;
      return state.excluded;
    },
    childDirectories: async (_root, relative) => {
      const children = directories.get(relative);
      if (!children) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return children;
    },
    directoryIdentity: async (_root, relative) =>
      directories.has(relative) ? `id-${identities.get(relative) ?? 0}` : null,
  };
  const live = () =>
    watches
      .filter((watch) => !watch.closed)
      .map((watch) => `${watch.recursive ? "recursive" : "direct"} ${watch.target}`)
      .sort();
  const watchOn = (target: string) =>
    watches.findLast((watch) => watch.target === target && !watch.closed)!;
  const replaceDirectory = (relative: string) =>
    identities.set(relative, (identities.get(relative) ?? 0) + 1);
  return { directories, state, start, io, live, watchOn, replaceDirectory };
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

function split(
  context: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof startWorktreeWatcher>[0]> = {},
) {
  const hints: WorktreeChangeHint[] = [];
  const errors: unknown[] = [];
  let coverage = 0;
  const watcher = startWorktreeWatcher({
    worktreePath: ROOT,
    settleMs: 1,
    startWatch: context.start,
    plan: context.io,
    perDirectoryWatches: true,
    resolveGitPaths: async () => ({ gitDir: "/wt/.git", commonDir: "/wt/.git", linked: false }),
    onChange: (hint) => {
      if (hint) hints.push(hint);
    },
    onError: (error) => errors.push(error),
    onCoverageChange: () => {
      coverage += 1;
    },
    ...overrides,
  });
  opened.push(watcher);
  return { watcher, hints, errors, coverage: () => coverage };
}

const standardTree = () =>
  fixture({
    directories: {
      "": ["apps", "node_modules", "src"],
      src: [],
      node_modules: [],
      apps: ["web"],
      "apps/web": ["node_modules", "lib"],
      "apps/web/lib": [],
      "apps/web/node_modules": [],
    },
    excluded: ["node_modules", "apps/web/node_modules"],
  });

const SPLIT_WATCHES = [
  "direct /wt",
  "direct /wt/apps",
  "direct /wt/apps/web",
  "recursive /wt/apps/web/lib",
  "recursive /wt/src",
];

describe("startWorktreeWatcher, per-directory platforms", () => {
  test("leaves excluded subtrees unwatched and is qualified only once the plan applies", async () => {
    const context = standardTree();
    let releaseList!: () => void;
    const listed = context.io.listExcluded;
    context.io.listExcluded = async (root) => {
      await new Promise<void>((resolve) => (releaseList = resolve));
      return listed(root);
    };
    const { watcher, coverage } = split(context);

    // Metadata alone must not qualify a root that sees only its direct children.
    await until(() => releaseList !== undefined);
    await Promise.resolve();
    expect(context.live()).toEqual(["direct /wt"]);
    expect(watcher.watching).toBe(true);
    expect(watcher.qualified).toBe(false);
    expect(coverage()).toBe(0);

    releaseList();
    await until(() => watcher.qualified === true);
    expect(context.live()).toEqual(SPLIT_WATCHES);
    expect(coverage()).toBe(1);
  });

  test("reports a path relative to the worktree from any watch", async () => {
    const context = standardTree();
    const { watcher, hints } = split(context);
    await until(() => watcher.qualified === true);
    await until(() => hints.length > 0);
    hints.length = 0;

    context.watchOn("/wt/src").emit("change", "deep/a.ts");
    await until(() => hints.length === 1);
    expect(hints[0]!.paths).toEqual(["src/deep/a.ts"]);

    context.watchOn("/wt/apps/web").emit("change", "package.json");
    await until(() => hints.length === 2);
    expect(hints[1]!.paths).toEqual(["apps/web/package.json"]);
  });

  // The watch began after the directory did, so anything written in between
  // reached no watch; the scan the hint causes starts after the watch.
  test("a new directory is watched and reported, with its contents unknown", async () => {
    const context = standardTree();
    const { watcher, hints } = split(context);
    await until(() => watcher.qualified === true);
    await until(() => hints.length > 0);
    hints.length = 0;

    context.directories.set("", ["apps", "node_modules", "src", "fresh"]);
    context.directories.set("fresh", []);
    context.watchOn("/wt").emit("rename", "fresh");
    await until(() => context.live().includes("recursive /wt/fresh"));

    await until(() => hints.some((hint) => hint.paths === undefined && hint.tree));
    hints.length = 0;
    context.watchOn("/wt/fresh").emit("rename", "a/b.ts");
    await until(() => hints.length === 1);
    expect(hints[0]!.paths).toEqual(["fresh/a/b.ts"]);
  });

  test("a new directory inside a split directory is watched too", async () => {
    const context = standardTree();
    const { watcher } = split(context);
    await until(() => watcher.qualified === true);

    context.directories.set("apps/web", ["node_modules", "lib", "fresh"]);
    context.directories.set("apps/web/fresh", []);
    context.watchOn("/wt/apps/web").emit("rename", "fresh");
    await until(() => context.live().includes("recursive /wt/apps/web/fresh"));
  });

  test("a file saved beside the watched directories changes no watches", async () => {
    const context = standardTree();
    const { watcher, hints } = split(context);
    await until(() => watcher.qualified === true);
    await until(() => hints.length > 0);
    hints.length = 0;
    const before = context.state.listCalls;

    context.watchOn("/wt").emit("rename", "README.md");
    await until(() => hints.length === 1);
    expect(hints[0]!.paths).toEqual(["README.md"]);
    expect(context.live()).toEqual(SPLIT_WATCHES);
    expect(context.state.listCalls).toBe(before);
  });

  test("a removed directory loses its watch", async () => {
    const context = standardTree();
    const { watcher } = split(context);
    await until(() => watcher.qualified === true);

    context.directories.set("", ["apps", "node_modules"]);
    context.directories.delete("src");
    context.watchOn("/wt").emit("rename", "src");
    await until(() => !context.live().includes("recursive /wt/src"));
  });

  // Bun's watch on the old directory never reports again once it is removed.
  test("a directory replaced under the same name gets a new watch", async () => {
    const context = standardTree();
    const { watcher } = split(context);
    await until(() => watcher.qualified === true);
    const previous = context.watchOn("/wt/src");

    context.replaceDirectory("src");
    context.watchOn("/wt").emit("rename", "src");
    await until(() => previous.closed);
    // The old watch closes at the event; the next plan pass attaches the new one.
    await until(() => context.live().includes("recursive /wt/src"));
    expect(context.live()).toEqual(SPLIT_WATCHES);
  });

  // Linux reuses a removed directory's inode number for the next one made, so
  // `rm -r src && mkdir src` usually leaves the identity unchanged while the
  // old watch is dead (flake 6381).
  test("a directory replaced with the same identity still gets a new watch", async () => {
    const context = standardTree();
    const { watcher, hints } = split(context);
    await until(() => watcher.qualified === true);
    const previous = context.watchOn("/wt/src");

    context.watchOn("/wt").emit("rename", "src");
    await until(() => previous.closed);
    await until(() => context.live().includes("recursive /wt/src"));
    expect(context.live()).toEqual(SPLIT_WATCHES);
    hints.length = 0;
    context.watchOn("/wt/src").emit("rename", "probe.txt");
    await until(() => hints.some((hint) => hint.paths?.includes("src/probe.txt") === true));
  });

  test("watches below a directory replaced with the same identity are replaced too", async () => {
    const context = standardTree();
    const { watcher } = split(context);
    await until(() => watcher.qualified === true);
    const previous = ["/wt/apps", "/wt/apps/web", "/wt/apps/web/lib"].map(context.watchOn);
    const unrelated = context.watchOn("/wt/src");

    context.watchOn("/wt").emit("rename", "apps");
    await until(() => previous.every((watch) => watch.closed));
    await until(() => context.live().length === SPLIT_WATCHES.length);
    expect(context.live()).toEqual(SPLIT_WATCHES);
    expect(unrelated.closed).toBe(false);
  });

  test("a new node_modules is left out before anything enters it", async () => {
    const context = standardTree();
    const { watcher } = split(context);
    await until(() => watcher.qualified === true);
    expect(context.state.listCalls).toBe(1);

    context.directories.set("src", ["node_modules"]);
    context.directories.set("src/node_modules", []);
    context.state.excluded = ["node_modules", "apps/web/node_modules", "src/node_modules"];
    context.watchOn("/wt/src").emit("rename", "node_modules");
    await until(() => context.live().includes("direct /wt/src"));
    expect(context.state.listCalls).toBe(2);
    expect(context.live()).not.toContain("recursive /wt/src");
    expect(context.live()).not.toContain("recursive /wt/src/node_modules");
  });

  // A file tracked or an ignore rule removed makes the subtree part of the diff.
  test.each([
    ["a staged file", "/wt", ".git/index"],
    ["an ignore rule", "/wt", ".gitignore"],
  ])("%s puts a left-out subtree back, after the burst settles", async (_label, target, name) => {
    const context = standardTree();
    const { watcher } = split(context);
    await until(() => watcher.qualified === true);
    expect(context.live()).not.toContain("recursive /wt/node_modules");

    context.state.excluded = ["apps/web/node_modules"];
    const before = context.state.listCalls;
    context.watchOn(target).emit("change", name);
    context.watchOn(target).emit("change", name);
    await until(() => context.live().includes("recursive /wt/node_modules"));
    expect(context.state.listCalls).toBe(before + 1);
  });

  test("a linked worktree's index change re-reads the exclusions", async () => {
    const context = standardTree();
    const { watcher } = split(context, {
      resolveGitPaths: async () => ({
        gitDir: "/repo/.git/worktrees/wt",
        commonDir: "/repo/.git",
        linked: true,
      }),
    });
    await until(() => watcher.qualified === true);

    context.state.excluded = ["apps/web/node_modules"];
    context.watchOn("/repo/.git/worktrees/wt").emit("rename", "index");
    await until(() => context.live().includes("recursive /wt/node_modules"));
  });

  test("no answer from Git watches the whole worktree", async () => {
    const context = standardTree();
    context.state.excluded = undefined;
    const { watcher, errors } = split(context);
    await until(() => watcher.qualified === true);
    expect(context.live()).toEqual(["recursive /wt"]);
    expect(errors).toEqual([]);
  });

  test("Git stopping answering later puts the whole worktree back", async () => {
    const context = standardTree();
    const { watcher } = split(context);
    await until(() => watcher.qualified === true);

    context.state.excluded = undefined;
    context.watchOn("/wt").emit("change", ".gitignore");
    await until(() => context.live().join() === "recursive /wt");
  });

  test("a directory gone before its watch begins is not a failure", async () => {
    const context = standardTree();
    context.state.refuse.set("/wt/src", Object.assign(new Error("gone"), { code: "ENOENT" }));
    const { watcher, errors } = split(context);
    await until(() => watcher.qualified === true);
    expect(errors).toEqual([]);
    expect(watcher.watching).toBe(true);
    expect(context.live()).not.toContain("recursive /wt/src");
  });

  for (const operation of ["childDirectories", "directoryIdentity"] as const) {
    for (const phase of ["setup", "replan"]) {
      test.each(["EACCES", "EIO"])(
        `${operation} ${phase} failure (%s) closes coverage`,
        async (code) => {
          const context = standardTree();
          let fail = phase === "setup";
          const error = Object.assign(new Error("read failed"), { code });
          const wrap =
            <T>(read: (root: string, relative: string) => Promise<T>) =>
            async (root: string, relative: string): Promise<T> => {
              if (fail && relative === "apps/web") throw error;
              return read(root, relative);
            };
          if (operation === "childDirectories") {
            context.io.childDirectories = wrap(context.io.childDirectories);
          } else {
            context.io.directoryIdentity = wrap(context.io.directoryIdentity);
          }
          const { watcher, errors } = split(context);
          if (!fail) {
            await until(() => watcher.qualified === true);
            fail = true;
            context.watchOn("/wt").emit("change", ".gitignore");
          }
          await until(() => errors.length === 1);
          expect(errors).toEqual([error]);
          expect(watcher.qualified).toBe(false);
          expect(watcher.watching).toBe(false);
          expect(context.live()).toEqual([]);
        },
      );
    }
  }

  test.each(["EACCES", "EPERM"])("an unreadable child (%s) falls back to polling", async (code) => {
    const context = standardTree();
    context.state.refuse.set("/wt/src", Object.assign(new Error("denied"), { code }));
    const { watcher, errors } = split(context);
    await until(() => errors.length === 1);
    expect(watcher.qualified).toBe(false);
    expect(watcher.watching).toBe(false);
    expect(context.live()).toEqual([]);
    // Restoring permissions cannot leave a qualified watcher with a hole:
    // its owner has already been told to poll.
    context.state.refuse.delete("/wt/src");
    expect(watcher.qualified).toBe(false);
  });

  test.each([true, false])(
    "ancestor replacement refreshes proof (split=%s)",
    async (perDirectoryWatches) => {
      const context = standardTree();
      const { watcher, hints } = split(context, { perDirectoryWatches });
      await until(() => watcher.qualified === true && context.state.listCalls === 1);
      context.replaceDirectory("apps/web");
      context.state.excluded = ["node_modules"];
      context
        .watchOn(perDirectoryWatches ? "/wt/apps" : "/wt")
        .emit("rename", perDirectoryWatches ? "web" : "apps/web");
      await until(() => context.state.listCalls === 2);
      if (perDirectoryWatches) await until(() => context.live().includes("recursive /wt/apps"));
      await until(() => hints.length > 0);
      hints.length = 0;
      context
        .watchOn(perDirectoryWatches ? "/wt/apps" : "/wt")
        .emit(
          "change",
          perDirectoryWatches ? "web/node_modules/a.js" : "apps/web/node_modules/a.js",
        );
      await until(() => hints.length === 1);
      expect(hints[0]!.paths).toEqual(["apps/web/node_modules/a.js"]);
    },
  );

  test.each([true, false])(
    "an excluded entry itself refreshes proof (split=%s)",
    async (perDirectoryWatches) => {
      const context = standardTree();
      const { watcher, hints } = split(context, { perDirectoryWatches });
      await until(() => watcher.qualified === true && context.state.listCalls === 1);
      context.state.excluded = ["apps/web/node_modules"];
      context.directories.delete("node_modules");
      context.watchOn("/wt").emit("rename", "node_modules");
      await until(() => context.state.listCalls >= 2);
      await until(() => hints.some((hint) => hint.fileList));
    },
  );

  test("a child created between listing and direct attachment is watched", async () => {
    const context = standardTree();
    const list = context.io.childDirectories;
    let inserted = false;
    context.io.childDirectories = async (root, relative) => {
      const result = await list(root, relative);
      if (relative === "apps/web" && !inserted) {
        inserted = true;
        context.directories.set(relative, [...result, "raced"]);
        context.directories.set("apps/web/raced", []);
      }
      return result;
    };
    const { watcher } = split(context);
    await until(() => watcher.qualified === true);
    await until(() => context.live().includes("recursive /wt/apps/web/raced"));
  });

  test("a root that cannot be re-watched fails, because nothing else covers it", async () => {
    const context = standardTree();
    context.state.excluded = undefined;
    context.state.refuse.set("recursive /wt", Object.assign(new Error("gone"), { code: "ENOENT" }));
    const { watcher, errors } = split(context);
    await until(() => errors.length === 1);
    expect(watcher.watching).toBe(false);
  });

  test("running out of watches closes everything so the owner falls back", async () => {
    const context = standardTree();
    context.state.refuse.set("/wt/src", Object.assign(new Error("full"), { code: "ENOSPC" }));
    const { watcher, errors } = split(context);
    await until(() => errors.length === 1);
    expect(watcher.watching).toBe(false);
    expect(context.live()).toEqual([]);
  });

  test("a later watch failing asynchronously closes everything too", async () => {
    const context = standardTree();
    const { watcher, errors } = split(context);
    await until(() => watcher.qualified === true);
    context.watchOn("/wt/src").fail(new Error("ENOSPC"));
    expect(errors).toHaveLength(1);
    expect(watcher.watching).toBe(false);
    expect(context.live()).toEqual([]);
  });

  test("closing during a plan attaches nothing", async () => {
    const context = standardTree();
    let releaseList!: () => void;
    const listed = context.io.listExcluded;
    context.io.listExcluded = async (root) => {
      await new Promise<void>((resolve) => (releaseList = resolve));
      return listed(root);
    };
    const { watcher } = split(context);
    await until(() => releaseList !== undefined);
    watcher.close();
    releaseList();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(context.live()).toEqual([]);
  });
});

describe("startWorktreeWatcher, platforms with one recursive watch", () => {
  const recursiveRoot = (context: ReturnType<typeof fixture>) =>
    split(context, { perDirectoryWatches: false });

  test("keeps one watch and is not held back by the plan", async () => {
    const context = standardTree();
    const { watcher } = recursiveRoot(context);
    await until(() => watcher.qualified === true);
    await until(() => context.state.listCalls === 1);
    expect(context.live()).toEqual(["recursive /wt"]);
  });

  test("drops events under an excluded subtree, and only those", async () => {
    const context = standardTree();
    const { hints } = recursiveRoot(context);
    await until(() => context.state.listCalls === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    hints.length = 0;
    const root = context.watchOn("/wt");

    root.emit("change", "node_modules/pkg/index.js");
    root.emit("change", "apps/web/node_modules/pkg/index.js");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(hints).toEqual([]);

    // Same name, different place: not the subtree Git proved.
    root.emit("change", "node_modules-old/index.js");
    root.emit("change", "src/node_modules/index.js");
    await until(() => hints.length === 1);
    expect(hints[0]!.paths?.sort()).toEqual([
      "node_modules-old/index.js",
      "src/node_modules/index.js",
    ]);
  });

  test("an install larger than the overflow bound reports nothing", async () => {
    const context = standardTree();
    const { hints } = recursiveRoot(context);
    await until(() => context.state.listCalls === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    hints.length = 0;
    const root = context.watchOn("/wt");
    for (let index = 0; index <= WATCH_BURST_OVERFLOW_EVENTS; index += 1) {
      root.emit("rename", `node_modules/pkg/${index}.js`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(hints).toEqual([]);
  });

  test("an ignore rule change stops dropping them, and reports what it dropped", async () => {
    const context = standardTree();
    const { hints } = recursiveRoot(context);
    await until(() => context.state.listCalls === 1);
    const root = context.watchOn("/wt");

    context.state.excluded = [];
    root.emit("change", ".gitignore");
    await until(() => context.state.listCalls === 2);
    await until(() => hints.some((hint) => hint.fileList && hint.paths === undefined));
    await new Promise((resolve) => setTimeout(resolve, 5));
    hints.length = 0;
    root.emit("change", "node_modules/pkg/index.js");
    await until(() => hints.length === 1);
    expect(hints[0]!.paths).toEqual(["node_modules/pkg/index.js"]);
    expect(hints[0]!.tree).toBe(false);
  });
});

describe("startWorktreeWatcher, without a plan", () => {
  test("an injected startWatch keeps one recursive root and reads no exclusions", async () => {
    const context = standardTree();
    const watcher = startWorktreeWatcher({
      worktreePath: ROOT,
      startWatch: context.start,
      perDirectoryWatches: true,
      resolveGitPaths: async () => ({
        gitDir: "/wt/.git",
        commonDir: "/wt/.git",
        linked: false,
      }),
      onChange: () => undefined,
    });
    opened.push(watcher);
    await until(() => watcher.qualified === true);
    expect(context.live()).toEqual(["recursive /wt"]);
    expect(context.state.listCalls).toBe(0);
  });
});

test("a watch set up after the call returns keeps coverage unqualified until it is", async () => {
  let establish!: () => void;
  const established = new Promise<void>((resolve) => {
    establish = resolve;
  });
  let announced = 0;
  const hints: WorktreeChangeHint[] = [];
  const handle = { on: () => handle, close: () => undefined, established };
  const watcher = startWorktreeWatcher({
    worktreePath: "/wt",
    settleMs: 1,
    onChange: (hint) => {
      if (hint) hints.push(hint);
    },
    onCoverageChange: () => {
      announced += 1;
    },
    plan: null,
    startWatch: () => handle,
    resolveGitPaths: async () => ({
      linked: false,
      gitDir: "/wt/.git",
      commonDir: "/wt/.git",
    }),
  });
  await Bun.sleep(0);
  expect(watcher.watching).toBe(true);
  expect(watcher.qualified).toBe(false);
  expect(announced).toBe(0);
  establish();
  await Bun.sleep(0);
  expect(watcher.qualified).toBe(true);
  expect(announced).toBe(1);
  await until(() => hints.length === 1);
  expect(hints).toEqual([{ fileList: true, tree: true, overflow: false }]);
  watcher.close();
});

test("a watch that fails after the call returns closes the watcher through onError", async () => {
  let reject!: (error: Error) => void;
  const established = new Promise<void>((_resolve, rejectIt) => {
    reject = rejectIt;
  });
  established.catch(() => undefined);
  let report: ((error: Error) => void) | undefined;
  const errors: unknown[] = [];
  const handle = {
    on: (_event: string, listener: (error: Error) => void) => {
      report = listener;
      return handle;
    },
    close: () => undefined,
    established,
  };
  const watcher = startWorktreeWatcher({
    worktreePath: "/gone",
    onChange: () => undefined,
    onError: (error) => errors.push(error),
    plan: null,
    startWatch: () => handle,
    resolveGitPaths: null,
  });
  expect(watcher.watching).toBe(true);
  const failure = new Error("gone");
  reject(failure);
  report?.(failure);
  await Bun.sleep(0);
  expect(errors).toEqual([failure]);
  expect(watcher.watching).toBe(false);
});

test("retiring an unready split watch does not leave replacement coverage pending", async () => {
  const context = standardTree();
  const registrations: Array<{
    target: string;
    ready: () => void;
    settled: boolean;
    closed: boolean;
  }> = [];
  const { watcher, errors } = split(context, {
    startWatch: (target, listener, options) => {
      const handle = context.start(target, listener, options);
      const ready = Promise.withResolvers<void>();
      const registration = {
        target,
        ready: () => {
          registration.settled = true;
          ready.resolve();
        },
        settled: false,
        closed: false,
      };
      registrations.push(registration);
      return {
        on: handle.on.bind(handle),
        established: ready.promise,
        close: () => {
          registration.closed = true;
          handle.close();
          ready.reject(Object.assign(new Error("closed"), { code: "ECANCELED" }));
        },
      };
    },
  });
  await until(() => context.live().includes("recursive /wt/src"));
  // All but src are ready. A replan replaces src before its helper answers.
  for (const registration of registrations)
    if (registration.target !== "/wt/src") registration.ready();
  expect(watcher.qualified).toBe(false);
  const retired = registrations.find((registration) => registration.target === "/wt/src")!;
  context.replaceDirectory("src");
  context.watchOn("/wt").emit("rename", "src");
  await until(
    () =>
      retired.closed &&
      registrations.filter((registration) => registration.target === "/wt/src").length === 2,
  );
  for (const registration of registrations)
    if (!registration.closed && !registration.settled) registration.ready();
  await until(() => watcher.qualified === true);
  expect(errors).toEqual([]);
  watcher.close();
  await Promise.resolve();
  expect(watcher.qualified).toBe(false);
});
