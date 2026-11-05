import { expect, test } from "bun:test";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWorktreeWatcher, type WorktreeWatcher } from "./worktree-watcher.js";
import { worktreeWatchPlanIo } from "./worktree-watch-plan.js";

// Opt in ONLY in a disposable Linux VM with a dedicated user and a small
// fs.inotify.max_user_watches quota. Never lower that host-wide sysctl on a
// shared host (including Docker Desktop's VM) to enable this test.
const enabled = process.env.ORKESTRATOR_TEST_INOTIFY_EXHAUSTION === "1";
const MAX_WATCHES = 128;

async function until(ready: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!ready() && Date.now() < deadline) await Bun.sleep(10);
  expect(ready()).toBe(true);
}

test.skipIf(!enabled || process.platform !== "linux")(
  "real inotify exhaustion during split attachment closes coverage and permits recovery",
  async () => {
    const quota = Number(await fs.readFile("/proc/sys/fs/inotify/max_user_watches", "utf8"));
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
      watcher = startWorktreeWatcher({
        worktreePath: worktree,
        onChange: () => undefined,
        onError: (error) => errors.push(error),
        onCoverageChange: () => qualified++,
        plan: {
          ...worktreeWatchPlanIo,
          listExcluded: async (target) => {
            exclusions = await worktreeWatchPlanIo.listExcluded(target);
            // The real root watch already exists. Exhaust the kernel quota
            // before the real planner attaches its recursive src watch.
            for (let index = 0; index <= quota; index += 1) {
              try {
                fillers.push(watch(path.join(root, `fill-${index}`), { persistent: false }));
              } catch (error) {
                allocationError = error as NodeJS.ErrnoException;
                break;
              }
            }
            return exclusions;
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

      // Releasing the quota lets an ordinary watcher qualify and deliver a
      // single source write again, with no injected event or startWatch fake.
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
      await fs.writeFile(path.join(worktree, "src/recovered.txt"), "recovered\n");
      await until(() => seen.has("src/recovered.txt"));
      expect(errors).toHaveLength(1);
    } finally {
      watcher?.close();
      for (const handle of fillers) handle.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
