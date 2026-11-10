import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs, readdirSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import {
  worktreeWatchPlanIo,
  listIgnoredDependencyTrees,
  WATCH_PLAN_MAX_EXCLUDED,
} from "../src/core/worktree-watch-plan";
import {
  startWorktreeWatcher,
  type WorktreeChangeHint,
  type WorktreeWatcherOptions,
} from "../src/core/worktree-watcher";

/**
 * Real Git, real `fs.watch`, on whatever platform this runs on: this file is how
 * a change to the watch plan is proved on both macOS and Linux. A loaded host's
 * `fseventsd` has been measured taking 35 s to deliver a first event, so the only
 * safe assertions are "keeps writing until seen" and "absent from everything
 * delivered up to a later event".
 */

const DELIVERY_DEADLINE_MS = 90_000;
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...args], {
    cwd,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

async function write(root: string, relative: string, body = "x\n"): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), body);
}

/** A linked worktree, as every local environment is, with ignored and tracked trees. */
async function makeWorktree(): Promise<string> {
  // The checkout's own file system: macOS delivers no events for this host's
  // system temporary directory (flake 0091).
  const parent = path.resolve(import.meta.dir, "../../../output/watch-fixtures");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, "ork-watch-real-")));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  await write(repo, ".gitignore", "node_modules/\n");
  await write(repo, "src/a.ts");
  await write(repo, "packages/app/src/a.ts");
  await write(repo, "vendored/node_modules/kept/index.js");
  git(repo, "add", ".gitignore", "src", "packages");
  git(repo, "add", "-f", "vendored");
  git(repo, "commit", "-q", "-m", "initial");
  const worktree = path.join(root, "worktree");
  git(repo, "worktree", "add", "-q", worktree, "-b", "feature");
  for (const dependencies of ["node_modules", "packages/app/node_modules"]) {
    for (let index = 0; index < 20; index += 1) {
      await write(worktree, `${dependencies}/pkg-${index}/lib/index.js`);
    }
  }
  return worktree;
}

function openWorktreeWatcher(worktree: string, overrides: Partial<WorktreeWatcherOptions> = {}) {
  const seen = new Set<string>();
  const hints: WorktreeChangeHint[] = [];
  const errors: unknown[] = [];
  const watcher = startWorktreeWatcher({
    worktreePath: worktree,
    comparisonRef: "main",
    settleMs: 25,
    onChange: (hint) => {
      if (!hint) return;
      hints.push(hint);
      for (const name of hint.paths ?? []) seen.add(name);
    },
    onError: (error) => errors.push(error),
    ...overrides,
  });
  cleanups.push(() => watcher.close());
  return { seen, hints, errors, watcher };
}

async function watchWorktree(worktree: string, overrides: Partial<WorktreeWatcherOptions> = {}) {
  const plan =
    overrides.plan === undefined
      ? overrides.startWatch
        ? null
        : worktreeWatchPlanIo
      : overrides.plan;
  let proofRead = plan === null;
  const opened = openWorktreeWatcher(worktree, {
    ...overrides,
    plan: plan && {
      ...plan,
      async listExcluded(root) {
        try {
          return await plan.listExcluded(root);
        } finally {
          proofRead = true;
        }
      },
    },
  });
  const deadline = Date.now() + DELIVERY_DEADLINE_MS;
  // On macOS a recursive root already covers everything before Git has read
  // which events to omit. Ignore-rule assertions need that independent proof,
  // not just native coverage or the first source event.
  while ((!opened.watcher.qualified || !proofRead) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(opened.watcher.qualified).toBe(true);
  expect(proofRead).toBe(true);
  expect(opened.errors).toEqual([]);
  return opened;
}

/** Writes distinct files until the watcher names one, since one event can be lost. */
async function expectNoticed(
  worktree: string,
  seen: Set<string>,
  directory: string,
): Promise<string> {
  const deadline = Date.now() + DELIVERY_DEADLINE_MS;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const name = `${directory}/probe-${attempt}.txt`;
    await write(worktree, name);
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const candidate of seen) {
      if (path.posix.dirname(candidate) === directory) {
        // Keeps a loaded Mac's run from looking stalled to the runner's watchdog.
        if (process.platform === "darwin")
          process.stderr.write(`noticed after ${attempt + 1} write(s)\n`);
        return candidate;
      }
    }
  }
  throw new Error(`no change noticed in ${directory}`);
}

/** Observe both native delivery and completed Git proof before testing writes. */
async function watchProof(worktree: string) {
  const raw = new Set<string>();
  let proof: readonly string[] | undefined;
  const result = await watchWorktree(worktree, {
    startWatch: (target, listener, options) =>
      watch(target, { ...options, persistent: false }, (event, filename) => {
        if (filename)
          raw.add(
            path
              .relative(worktree, path.join(target, filename.toString()))
              .split(path.sep)
              .join("/"),
          );
        listener(event, filename?.toString() ?? null);
      }),
    plan: {
      ...worktreeWatchPlanIo,
      listExcluded: async (root) => {
        proof = await listIgnoredDependencyTrees(root);
        return proof;
      },
    },
  });
  return { ...result, raw, proof: () => proof };
}

async function refreshUntil(mutate: () => Promise<void>, ready: () => boolean) {
  const deadline = Date.now() + DELIVERY_DEADLINE_MS;
  while (!ready() && Date.now() < deadline) {
    await mutate();
    await Bun.sleep(250);
  }
  expect(ready()).toBe(true);
}

/** Inotify watches this process holds. Linux only. */
function inotifyWatches(): number {
  let total = 0;
  for (const fd of readdirSync("/proc/self/fdinfo")) {
    try {
      total += readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("inotify wd:")).length;
    } catch {
      // The descriptor closed while this read it.
    }
  }
  return total;
}

describe("listIgnoredDependencyTrees", () => {
  test("names only ignored, tracked-free node_modules at any depth", async () => {
    const worktree = await makeWorktree();
    expect([...(await listIgnoredDependencyTrees(worktree))!].sort()).toEqual([
      "node_modules",
      "packages/app/node_modules",
    ]);
  });

  test("an empty ignored node_modules counts, so an install there is left out", async () => {
    const worktree = await makeWorktree();
    await fs.mkdir(path.join(worktree, "packages/fresh/node_modules"), { recursive: true });
    expect(await listIgnoredDependencyTrees(worktree)).toContain("packages/fresh/node_modules");
  });

  // Everything in it is ignored today, so Git lists it, but a new file there
  // would be untracked and visible.
  test("a node_modules that is not itself ignored stays watched", async () => {
    const worktree = await makeWorktree();
    await write(worktree, ".gitignore", "*.js\n");
    await fs.rm(path.join(worktree, "packages/app/node_modules"), { recursive: true });
    const listed = await listIgnoredDependencyTrees(worktree);
    expect(listed).toEqual([]);
  });

  test("a directory that is not a repository has no answer", async () => {
    const parent = await fs.realpath(process.env.TMPDIR ?? "/tmp");
    const elsewhere = await fs.mkdtemp(path.join(parent, "not-repo-"));
    cleanups.push(() => fs.rm(elsewhere, { recursive: true, force: true }));
    // TMPDIR can sit inside a checkout (fixtures moved off tmpfs onto a
    // worktree's own disk), where Git would answer for the enclosing repository.
    // Stop discovery at the parent so the directory is in no repository.
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = parent;
    cleanups.push(() => {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    });
    expect(await listIgnoredDependencyTrees(elsewhere)).toBeUndefined();
  });

  test("too many exclusion candidates declines the proof", async () => {
    const worktree = await makeWorktree();
    for (let index = 0; index <= WATCH_PLAN_MAX_EXCLUDED; index += 1) {
      await fs.mkdir(path.join(worktree, `wide-${index}/node_modules`), { recursive: true });
    }
    expect(await listIgnoredDependencyTrees(worktree)).toBeUndefined();
  });

  test("a lossy directory name stays watched", async () => {
    const worktree = await makeWorktree();
    await fs.mkdir(path.join(worktree, "caf�/node_modules"), { recursive: true });
    const listed = await listIgnoredDependencyTrees(worktree);
    expect(listed).toContain("node_modules");
    expect(listed).not.toContain("caf�/node_modules");
  });

  // A worktree's config is whatever ran in it wrote. These reads must not run it.
  test("a worktree's fsmonitor hook does not run", async () => {
    const worktree = await makeWorktree();
    const marker = path.join(path.dirname(worktree), "hook-ran");
    const hook = path.join(path.dirname(worktree), "hook.sh");
    await fs.writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    git(worktree, "config", "core.fsmonitor", hook);
    await listIgnoredDependencyTrees(worktree);
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
  });
});

describe("worktree watcher on this platform's real watch", () => {
  // Root bypasses mode bits, so this qualification needs a non-root Linux user.
  describe.skipIf(process.platform !== "linux" || process.geteuid?.() === 0)(
    "unreadable descendants on Linux as a non-root user",
    () => {
      test.each(["before attachment", "after qualification"])(
        "a real permission error %s keeps existing and new source directories watched",
        async (when) => {
          const worktree = await makeWorktree();
          const parent = path.join(worktree, "src/runtime-data");
          const denied = path.join(parent, "unreadable");
          await fs.mkdir(parent);
          // Added after the fixture removal cleanup, so permissions are restored first.
          cleanups.push(async () => {
            await fs.chmod(denied, 0o700).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
          });
          const makeUnreadable = async () => {
            await fs.mkdir(denied, { mode: 0 });
            await expect(fs.readdir(denied)).rejects.toMatchObject({ code: "EACCES" });
          };
          if (when === "before attachment") await makeUnreadable();
          const permissionErrors: NodeJS.ErrnoException[] = [];
          let coverageChanges = 0;
          const options: Partial<WorktreeWatcherOptions> = {
            plan: worktreeWatchPlanIo,
            onCoverageChange: () => coverageChanges++,
            startWatch: (target, listener, settings) => {
              const handle = watch(target, { ...settings, persistent: false }, (event, name) =>
                listener(event, name?.toString() ?? null),
              );
              handle.on("error", (error: NodeJS.ErrnoException) => permissionErrors.push(error));
              return handle;
            },
          };
          const opened =
            when === "after qualification"
              ? await watchWorktree(worktree, options)
              : openWorktreeWatcher(worktree, options);
          if (when === "after qualification") {
            expect(coverageChanges).toBe(1);
            await makeUnreadable();
          }
          const deadline = Date.now() + DELIVERY_DEADLINE_MS;
          while (permissionErrors.length === 0 && Date.now() < deadline) await Bun.sleep(10);
          expect(permissionErrors.length).toBeGreaterThan(0);
          expect(permissionErrors.every((error) => ["EACCES", "EPERM"].includes(error.code!))).toBe(
            true,
          );
          expect(permissionErrors.some((error) => error.path === denied)).toBe(true);
          expect(opened.watcher.watching).toBe(true);
          expect(opened.watcher.qualified).toBe(false);
          if (when === "after qualification") expect(coverageChanges).toBe(2);
          // Even an existing unreadable child may be reported asynchronously,
          // after the watch briefly announced coverage. Either ordering must
          // end unqualified, with at most one withdrawal notification.
          else expect([0, 2]).toContain(coverageChanges);
          await expectNoticed(worktree, opened.seen, "src");
          await expectNoticed(worktree, opened.seen, "src/created-after-permission-error");
          expect(opened.errors).toEqual([]);
          expect(opened.watcher.qualified).toBe(false);
        },
        DELIVERY_DEADLINE_MS * 3,
      );
    },
  );

  test(
    "a write under an ignored node_modules goes unreported while a source write is noticed",
    async () => {
      const worktree = await makeWorktree();
      const { seen } = await watchWorktree(worktree);
      // Proves the watch is delivering before the absence below can mean anything.
      await expectNoticed(worktree, seen, "src");
      await write(worktree, "node_modules/pkg-1/lib/installed.js");
      await write(worktree, "packages/app/node_modules/pkg-1/lib/installed.js");
      // Delivered in order, so anything from the writes above has arrived by now.
      await expectNoticed(worktree, seen, "packages/app/src");
      await expectNoticed(worktree, seen, "src/later");
      expect([...seen].filter((name) => name.includes("/installed.js"))).toEqual([]);
    },
    DELIVERY_DEADLINE_MS * 4,
  );

  test(
    "replacing an ignored directory with a symlink refreshes proof and reports it",
    async () => {
      const worktree = await makeWorktree();
      let proof: readonly string[] | undefined;
      let rootEvent!: (event: string, filename: string | null) => void;
      const { seen, hints } = await watchWorktree(worktree, {
        startWatch: (target, listener, options) => {
          if (target === worktree) rootEvent = listener;
          return watch(target, { ...options, persistent: false }, (event, filename) =>
            listener(event, filename?.toString() ?? null),
          );
        },
        plan: {
          ...worktreeWatchPlanIo,
          listExcluded: async (root) => {
            proof = await listIgnoredDependencyTrees(root);
            return proof;
          },
        },
      });
      await expectNoticed(worktree, seen, "src");
      expect(proof).toContain("node_modules");
      const hintsBefore = hints.length;
      await fs.rm(path.join(worktree, "node_modules"), { recursive: true });
      await fs.symlink("src", path.join(worktree, "node_modules"));
      // Exercise real Git proof invalidation independently of macOS losing a
      // single native notification (5061). Native delivery has separate tests.
      rootEvent("rename", "node_modules");
      const deadline = Date.now() + DELIVERY_DEADLINE_MS;
      while (
        (hints.length === hintsBefore || proof?.includes("node_modules")) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(hints.length).toBeGreaterThan(hintsBefore);
      expect(proof).not.toContain("node_modules");
    },
    DELIVERY_DEADLINE_MS * 2,
  );

  // The control for the test above: the same write, with nothing left out.
  test(
    "the same write is reported when the whole worktree is watched",
    async () => {
      const worktree = await makeWorktree();
      const { seen } = await watchWorktree(worktree, { plan: null });
      await expectNoticed(worktree, seen, "src");
      await expectNoticed(worktree, seen, "node_modules/pkg-1/lib");
    },
    DELIVERY_DEADLINE_MS * 2,
  );

  test(
    "a file in a directory created after the watch began is noticed",
    async () => {
      const worktree = await makeWorktree();
      const { seen } = await watchWorktree(worktree);
      // A new top-level directory, and one created with its contents already in it.
      await expectNoticed(worktree, seen, "fresh");
      await expectNoticed(worktree, seen, "brand/new/deep");
      // Inside a directory the watcher had to split around a nested node_modules.
      await expectNoticed(worktree, seen, "packages/fresh");
      await expectNoticed(worktree, seen, "packages/app/fresh/deep");
      // A new directory inside a directory that was already recursively watched.
      await expectNoticed(worktree, seen, "src/fresh/deep");
    },
    DELIVERY_DEADLINE_MS * 6,
  );

  test(
    "a tracked file under node_modules is noticed",
    async () => {
      const worktree = await makeWorktree();
      const { seen } = await watchWorktree(worktree);
      await expectNoticed(worktree, seen, "vendored/node_modules/kept");
    },
    DELIVERY_DEADLINE_MS * 2,
  );

  test(
    "removing the ignore rule makes node_modules visible again",
    async () => {
      const worktree = await makeWorktree();
      const { seen, raw, proof } = await watchProof(worktree);
      await refreshUntil(
        () => write(worktree, ".gitignore", "\n"),
        () => raw.has(".gitignore") && proof() !== undefined && !proof()!.includes("node_modules"),
      );
      await expectNoticed(worktree, seen, "node_modules/pkg-2/lib");
    },
    DELIVERY_DEADLINE_MS * 2,
  );

  test(
    "a directory removed and created again is still noticed",
    async () => {
      const worktree = await makeWorktree();
      const { seen } = await watchWorktree(worktree);
      await expectNoticed(worktree, seen, "src");
      await fs.rm(path.join(worktree, "src"), { recursive: true });
      await fs.mkdir(path.join(worktree, "src"));
      seen.clear();
      await expectNoticed(worktree, seen, "src");
    },
    DELIVERY_DEADLINE_MS * 3,
  );

  test(
    "an install into a new node_modules goes unreported",
    async () => {
      const worktree = await makeWorktree();
      const { seen, raw, proof } = await watchProof(worktree);
      await expectNoticed(worktree, seen, "packages/app/src");
      const dependency = "packages/app/src/node_modules";
      await refreshUntil(
        async () => {
          await fs.rm(path.join(worktree, dependency), { recursive: true, force: true });
          await fs.mkdir(path.join(worktree, dependency));
        },
        () => raw.has(dependency) && proof()?.includes(dependency) === true,
      );
      await write(worktree, "packages/app/src/node_modules/pkg/lib/installed.js");
      await expectNoticed(worktree, seen, "src");
      await expectNoticed(worktree, seen, "packages/app/src/later");
      expect([...seen].filter((name) => name.includes("/installed.js"))).toEqual([]);
    },
    DELIVERY_DEADLINE_MS * 4,
  );

  test.skipIf(process.platform !== "linux")(
    "takes no inotify watches inside an ignored node_modules",
    async () => {
      const worktree = await makeWorktree();
      const before = inotifyWatches();
      const { seen } = await watchWorktree(worktree);
      await expectNoticed(worktree, seen, "src");
      // Fixture directories outside node_modules: a dozen or so. Inside: over 120.
      expect(inotifyWatches() - before).toBeLessThan(40);
    },
    DELIVERY_DEADLINE_MS,
  );
});
