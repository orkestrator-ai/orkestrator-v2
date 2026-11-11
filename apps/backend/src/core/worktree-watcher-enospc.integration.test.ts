import { expect, test } from "bun:test";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWorktreeWatcher, type WorktreeWatcher } from "./worktree-watcher.js";
import { worktreeWatchPlanIo } from "./worktree-watch-plan.js";

// Opt in ONLY with a small, private inotify quota: a disposable Linux VM with a
// dedicated user and a small fs.inotify.max_user_watches, or a private user
// namespace with a small user.max_inotify_watches (Linux 5.11+), which leaves
// the host's setting alone. Never lower the host-wide sysctl on a shared host
// (including Docker Desktop's VM) to enable this test.
const enabled = process.env.ORKESTRATOR_TEST_INOTIFY_EXHAUSTION === "1";
const MAX_WATCHES = 128;

/** The smaller of the host-wide quota and this user namespace's own, if any. */
async function inotifyQuota(): Promise<number> {
  const limits = await Promise.all(
    ["/proc/sys/fs/inotify/max_user_watches", "/proc/sys/user/max_inotify_watches"].map((file) =>
      fs.readFile(file, "utf8").then(Number, () => Number.POSITIVE_INFINITY),
    ),
  );
  return Math.min(...limits);
}

async function until(ready: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!ready() && Date.now() < deadline) await Bun.sleep(10);
  expect(ready()).toBe(true);
}

test.skipIf(!enabled || process.platform !== "linux")(
  "real inotify exhaustion during split attachment closes coverage and permits recovery",
  async () => {
    const quota = await inotifyQuota();
    // Refuse instead of attempting an unbounded allocation on a normal host.
    expect(quota).toBeGreaterThanOrEqual(16);
    expect(quota).toBeLessThanOrEqual(MAX_WATCHES);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-inotify-exhaustion-"));
    const worktree = path.join(root, "worktree");
    const fillers: FSWatcher[] = [];
    let watcher: WorktreeWatcher | undefined;
    try {
      await fs.mkdir(path.join(worktree, "src"), { recursive: true });
      await fs.mkdir(path.join(worktree, "node_modules"));
      await fs.writeFile(path.join(worktree, ".gitignore"), "node_modules/\n");
      const git = Bun.spawnSync(["git", "init", "-q", worktree]);
      expect(git.exitCode).toBe(0);
      // Make every inode before watching: allocator writes must not trigger
      // reconciliation in the worktree while its first plan is pending.
      for (let index = 0; index <= quota; index += 1) {
        await fs.mkdir(path.join(root, `fill-${index}`));
      }
      const errors: unknown[] = [];
      let allocationError: NodeJS.ErrnoException | undefined;
      let exclusions: readonly string[] | undefined;
      let qualified = 0;
      // The real root watch already exists. Exhaust the kernel quota before
      // the real planner attaches its recursive src watch.
      const exhaustQuota = () => {
        for (let index = 0; index <= quota; index += 1) {
          try {
            fillers.push(watch(path.join(root, `fill-${index}`), { persistent: false }));
          } catch (error) {
            allocationError = error as NodeJS.ErrnoException;
            break;
          }
        }
      };
      watcher = startWorktreeWatcher({
        worktreePath: worktree,
        onChange: () => undefined,
        onError: (error) => errors.push(error),
        onCoverageChange: () => qualified++,
        plan: {
          ...worktreeWatchPlanIo,
          // Linux reads the proof through `listIgnoredTrees`; wrap both reads.
          listExcluded: async (target) => {
            exclusions = await worktreeWatchPlanIo.listExcluded(target);
            exhaustQuota();
            return exclusions;
          },
          listIgnoredTrees: async (target) => {
            const trees = await worktreeWatchPlanIo.listIgnoredTrees!(target);
            exclusions = trees?.dependencies;
            exhaustQuota();
            return trees;
          },
        },
      });
      expect(watcher.watching).toBe(true);
      await until(() => errors.length > 0);
      expect(exclusions).toContain("node_modules");
      expect(allocationError?.code).toBe("ENOSPC");
      expect((errors[0] as NodeJS.ErrnoException).code).toBe("ENOSPC");
      expect(watcher.watching).toBe(false);
      expect(watcher.qualified).toBe(false);
      expect(qualified).toBe(0);
      watcher.close();
      for (const handle of fillers.splice(0)) handle.close();

      // Releasing the quota lets an ordinary watcher qualify and name a source
      // write again, with no injected event or startWatch fake. Each new watch
      // opens a burst reporting unknown paths (the attachment gap), and a write
      // landing in it is folded into that hint, so write until one is named.
      const seen = new Set<string>();
      watcher = startWorktreeWatcher({
        worktreePath: worktree,
        settleMs: 10,
        onChange: (hint) => {
          for (const name of hint?.paths ?? []) seen.add(name);
        },
        onError: (error) => errors.push(error),
      });
      await until(() => watcher?.qualified === true);
      const named = () => [...seen].some((name) => name.startsWith("src/recovered-"));
      const deadline = Date.now() + 5_000;
      for (let attempt = 0; !named() && Date.now() < deadline; attempt += 1) {
        await fs.writeFile(path.join(worktree, `src/recovered-${attempt}.txt`), "recovered\n");
        await Bun.sleep(100);
      }
      expect(named()).toBe(true);
      expect(errors).toHaveLength(1);
    } finally {
      watcher?.close();
      for (const handle of fillers) handle.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
