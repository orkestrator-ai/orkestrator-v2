import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKTREE_SNAPSHOT_CHANGED_EVENT } from "@orkestrator/protocol/worktree-snapshots";
import { getLocalGitStatusDetailed } from "./commands-files.js";
import { DiffStatsService } from "./diff-stats-service.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { startWorktreeWatcher } from "./worktree-watcher.js";

/**
 * The shared owner against real Git, a real linked worktree and the real
 * recursive watcher. Periodic scans are pushed out of the way (10 min), so
 * every detection below comes from a watcher hint, never from a timer or a
 * read. The repository has no `origin`, so every scan's fetch fails and the
 * comparison degrades to the local `main` — the remote-fetch failure path.
 */

type ChangeRow = { path: string; status: string; additions: number };

let root: string;
let repo: string;
let linked: string;
let service: DiffStatsService;
let metrics: RecurringWorkMetrics;
const events: Array<{ fileListRevision?: number; watched?: boolean }> = [];
let watchingSupported = true;

function run(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...args], {
    cwd,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const latestRevision = () =>
  events.reduce((highest, event) => Math.max(highest, event.fileListRevision ?? 0), 0);

async function readRows(): Promise<ChangeRow[]> {
  const read = await service.readFileList({
    lookup: { worktreePath: linked },
    comparisonRef: "main",
    includeUncommitted: true,
  });
  return (read.changes as ChangeRow[]).map(({ path: file, status, additions }) => ({
    path: file,
    status,
    additions,
  }));
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-snapshots-git-")));
  repo = path.join(root, "repo");
  linked = path.join(root, "linked");
  await fs.mkdir(repo);
  run(repo, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(repo, "a.txt"), "one\n");
  run(repo, "add", "a.txt");
  run(repo, "commit", "-q", "-m", "initial");
  run(repo, "worktree", "add", "-q", linked, "-b", "feature");

  metrics = new RecurringWorkMetrics();
  service = new DiffStatsService({
    metrics,
    pollIntervalMs: 10 * 60_000,
    safetyNetIntervalMs: 10 * 60_000,
    emit: (event, payload) => {
      if (event === WORKTREE_SNAPSHOT_CHANGED_EVENT) events.push(payload as never);
    },
    startWatcher: (options) => startWorktreeWatcher({ ...options, settleMs: 50 }),
    scan: async (target) => {
      const detailed = await getLocalGitStatusDetailed(
        target.worktreePath!,
        target.comparisonRef,
        true,
      );
      return {
        stats: {
          additions: detailed.changes.reduce((sum, row) => sum + row.additions, 0),
          deletions: detailed.changes.reduce((sum, row) => sum + row.deletions, 0),
          filesChanged: detailed.changes.length,
          truncated: detailed.truncated,
        },
        changes: detailed.changes,
      };
    },
  });
  service.track({
    environmentId: "env",
    kind: "local",
    worktreePath: linked,
    comparisonRef: "main",
  });
  await until(() => latestRevision() >= 1);
  // Recursive fs.watch is not available on every platform; there the owner
  // documents a polling fallback, which the unit suite covers.
  if (!service.isWatching("env")) watchingSupported = false;
  else await until(() => events.some((event) => event.watched === true));
});

afterAll(async () => {
  service?.shutdown();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("real Git through the shared owner", () => {
  test("Linux and macOS establish qualified coverage for a linked worktree", () => {
    if (process.platform === "linux" || process.platform === "darwin") {
      expect(watchingSupported).toBe(true);
    }
  });

  test("a tracked edit that never touches the index is detected", async () => {
    if (!watchingSupported) return;
    const index = path.join(repo, ".git", "worktrees", "linked", "index");
    const indexBefore = (await fs.stat(index)).mtimeMs;
    const before = latestRevision();

    await fs.appendFile(path.join(linked, "a.txt"), "two\n");
    // The premise: a working-tree write leaves the index alone.
    expect((await fs.stat(index)).mtimeMs).toBe(indexBefore);

    await until(() => latestRevision() > before);
    const hits = metrics.snapshot().kinds["file-list-read"]?.cacheHits ?? 0;
    expect(await readRows()).toEqual([{ path: "a.txt", status: "M", additions: 1 }]);
    // Served from the hint-driven scan, not a read-triggered one.
    expect(metrics.snapshot().kinds["file-list-read"]?.cacheHits).toBe(hits + 1);
  });

  test("staging in a linked worktree (index outside the root) is detected", async () => {
    if (!watchingSupported) return;
    let before = latestRevision();
    await fs.writeFile(path.join(linked, "b.txt"), "new\n");
    await until(() => latestRevision() > before);
    expect(await readRows()).toContainEqual({ path: "b.txt", status: "?", additions: 1 });

    before = latestRevision();
    run(linked, "add", "b.txt");
    await until(() => latestRevision() > before);
    expect(await readRows()).toContainEqual({ path: "b.txt", status: "A", additions: 1 });
  });

  test("a shared ref moving the baseline outside the worktree is detected", async () => {
    if (!watchingSupported) return;
    const before = latestRevision();
    await fs.writeFile(path.join(repo, "c.txt"), "on main\n");
    run(repo, "add", "c.txt");
    run(repo, "commit", "-q", "-m", "advance main");
    await until(() => latestRevision() > before);
    expect(await readRows()).toContainEqual({ path: "c.txt", status: "D", additions: 0 });
  });
});
