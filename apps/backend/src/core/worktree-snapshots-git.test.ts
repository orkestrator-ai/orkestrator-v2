import { eventSink } from "./backend-emit.js";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { promises as fs, watch } from "node:fs";
import path from "node:path";
import { WORKTREE_SNAPSHOT_CHANGED_EVENT } from "@orkestrator/protocol/worktree-snapshots";
import { getLocalGitStatusDetailed } from "./commands-files.js";
import { DiffStatsService, LOCAL_SCAN_MIN_GAP_MS } from "./diff-stats-service.js";
import { createGitFetchScheduler } from "./diff-stats-tracking.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { worktreeWatchPlanIo } from "./worktree-watch-plan.js";
import { startWorktreeWatcher } from "./worktree-watcher.js";

/**
 * One change, one event, one short deadline holds on Linux. It does not on macOS:
 * with `fseventsd` saturated, Bun and Node watching the same directory were
 * handed the same 6 of 12 writes, up to 61 s late and the rest not at all (flake
 * 5061). There each detection keeps making the change until a scan shows it, and
 * a read of the cache is not asserted, because a late event can invalidate it.
 */
const EVENTS_CAN_BE_LOST = process.platform === "darwin";
const DETECTION_DEADLINE_MS = EVENTS_CAN_BE_LOST ? 180_000 : 15_000;
const REPEAT_CHANGE_EVERY_MS = 1_000;

// This slow-tier file creates real repositories/worktrees and waits for
// subprocess cleanup. Give that fixture work its own bounded host budget;
// explicit operation deadlines and shorter test budgets remain unchanged.
setDefaultTimeout(EVENTS_CAN_BE_LOST ? 2 * DETECTION_DEADLINE_MS : 30_000);

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
const hintedPaths: string[] = [];
/** Every native event, so a test can name the watch that delivered it. */
const rawEvents: Array<{ target: string; name: string | null }> = [];
let scannedRows: ChangeRow[] = [];
let publishedRows: ChangeRow[] = [];
let watchingSupported = true;
let scansStarted = 0;
let scansFinished = 0;
let forwardNativeEvents = true;
let deliverRootEvent: ((event: "change", name: string) => void) | undefined;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What a run on a loaded Mac cost. It also keeps `--only-failures` from going quiet
 * for longer than the test runner's five-minute no-output watchdog allows.
 */
function reportDelivery(what: string, startedAt: number): void {
  if (EVENTS_CAN_BE_LOST) process.stderr.write(`${what} in ${Date.now() - startedAt} ms\n`);
}

/**
 * Makes a change, then waits for a published scan to show it. Only watcher hints
 * start scans here, so a pass means the change was noticed.
 */
async function detect(
  change: (attempt: number) => void | Promise<void>,
  shown: (rows: ChangeRow[]) => boolean,
): Promise<void> {
  const before = latestRevision();
  const deadline = Date.now() + DETECTION_DEADLINE_MS;
  let attempt = 0;
  await change(attempt++);
  let repeatAt = Date.now() + REPEAT_CHANGE_EVERY_MS;
  while (!(latestRevision() > before && shown(publishedRows))) {
    if (Date.now() > deadline) throw new Error("condition not reached before the deadline");
    if (EVENTS_CAN_BE_LOST && Date.now() >= repeatAt) {
      await change(attempt++);
      repeatAt = Date.now() + REPEAT_CHANGE_EVERY_MS;
    }
    await sleep(25);
  }
  reportDelivery(`detected after ${attempt} change(s)`, deadline - DETECTION_DEADLINE_MS);
}

/** Removes paths until a scan stops listing them; a repeat first puts them back. */
async function removeUntilUnlisted(...names: string[]): Promise<void> {
  await detect(
    async (attempt) => {
      for (const name of names) {
        const target = path.join(linked, name);
        if (attempt > 0) await fs.writeFile(target, "again\n");
        await fs.rm(target, { force: true });
      }
    },
    (rows) => !rows.some((row) => names.includes(row.path)),
  );
}

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

beforeAll(
  async () => {
    // Qualify native notifications on the worktree filesystem. Bun on macOS can
    // establish a watcher in the system temp directory without delivering edits.
    const fixtureParent = path.resolve(import.meta.dir, "../../../../output/watch-fixtures");
    await fs.mkdir(fixtureParent, { recursive: true });
    root = await fs.realpath(await fs.mkdtemp(path.join(fixtureParent, "ork-snapshots-git-")));
    repo = path.join(root, "repo");
    linked = path.join(root, "linked");
    await fs.mkdir(repo);
    run(repo, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(repo, "a.txt"), "one\n");
    await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
    run(repo, "add", "a.txt", ".gitignore");
    run(repo, "commit", "-q", "-m", "initial");
    run(repo, "worktree", "add", "-q", linked, "-b", "feature");
    // Left out of the watch, so every test below runs against the watch plan.
    await fs.mkdir(path.join(linked, "node_modules", "pkg"), { recursive: true });

    metrics = new RecurringWorkMetrics();
    const gitFetches = createGitFetchScheduler();
    const readinessFile = ".watcher-ready";
    let readinessHints = 0;
    service = new DiffStatsService({
      metrics,
      pollIntervalMs: 10 * 60_000,
      safetyNetIntervalMs: 10 * 60_000,
      emit: eventSink((event, payload) => {
        if (event !== WORKTREE_SNAPSHOT_CHANGED_EVENT) return;
        events.push(payload as never);
        publishedRows = scannedRows;
      }),
      startWatcher: (options) =>
        startWorktreeWatcher({
          ...options,
          settleMs: 50,
          plan: worktreeWatchPlanIo,
          onChange: (hint) => {
            hintedPaths.push(...(hint?.paths ?? []));
            options.onChange(hint);
          },
          startWatch: (target, listener, watchOptions) => {
            if (target === linked) deliverRootEvent = listener;
            return watch(target, { ...watchOptions, persistent: false }, (event, filename) => {
              const name = filename?.toString() ?? null;
              rawEvents.push({ target, name });
              if (target === linked && name?.split(path.sep).at(-1) === readinessFile)
                readinessHints++;
              if (forwardNativeEvents) listener(event, name);
            });
          },
        }),
      scan: async (target) => {
        scansStarted++;
        const detailed = await getLocalGitStatusDetailed(
          target.worktreePath!,
          target.comparisonRef,
          true,
          gitFetches,
        );
        scansFinished++;
        scannedRows = detailed.changes.map(({ path: file, status, additions }) => ({
          path: file,
          status,
          additions,
        }));
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
    await until(() => latestRevision() >= 1, DETECTION_DEADLINE_MS);
    // Recursive fs.watch is not available on every platform; there the owner
    // documents a polling fallback, which the unit suite covers.
    if (!service.isWatching("env")) watchingSupported = false;
    else {
      await until(() => events.some((event) => event.watched === true));
      // Native stream registration can finish after metadata coverage is known.
      // Prove a real root notification arrived before the tracked-edit test;
      // periodic scans remain disabled and cannot satisfy this readiness gate.
      const marker = path.join(linked, readinessFile);
      const revision = latestRevision();
      const deadline = Date.now() + DETECTION_DEADLINE_MS;
      let attempt = 0;
      while (readinessHints === 0 && Date.now() < deadline) {
        await fs.writeFile(marker, String(attempt++));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(readinessHints).toBeGreaterThan(0);
      reportDelivery("first native event", deadline - DETECTION_DEADLINE_MS);
      await until(() => latestRevision() > revision, DETECTION_DEADLINE_MS);
      const hintsBeforeRemoval = readinessHints;
      await removeUntilUnlisted(readinessFile);
      await until(() => readinessHints > hintsBeforeRemoval, DETECTION_DEADLINE_MS);
      expect(await readRows()).toEqual([]);
    }
  },
  2 * DETECTION_DEADLINE_MS + 15_000,
);

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

    await detect(
      async () => {
        await fs.writeFile(path.join(linked, "a.txt"), "one\ntwo\n");
        // The premise: a working-tree write leaves the index alone.
        expect((await fs.stat(index)).mtimeMs).toBe(indexBefore);
      },
      (rows) => rows.some((row) => row.path === "a.txt"),
    );
    const hits = metrics.snapshot().kinds["file-list-read"]?.cacheHits ?? 0;
    expect(await readRows()).toEqual([{ path: "a.txt", status: "M", additions: 1 }]);
    // Served from the hint-driven scan, not a read-triggered one.
    if (!EVENTS_CAN_BE_LOST) {
      expect(metrics.snapshot().kinds["file-list-read"]?.cacheHits).toBe(hits + 1);
    }
    // The scan itself is read-only. A `git status` that refreshed the index
    // would be a watcher hint of its own, invalidating the result it had just
    // published and making the read above join a redundant rescan (case 0180).
    expect((await fs.stat(index)).mtimeMs).toBe(indexBefore);
  });

  test("a file in a directory created after the watch began is detected", async () => {
    if (!watchingSupported) return;
    await detect(
      async () => {
        await fs.mkdir(path.join(linked, "fresh", "deep"), { recursive: true });
        await fs.writeFile(path.join(linked, "fresh", "deep", "first.txt"), "one\n");
      },
      (rows) => rows.some((row) => row.path === "fresh/deep/first.txt"),
    );
    expect(await readRows()).toContainEqual({
      path: "fresh/deep/first.txt",
      status: "?",
      additions: 1,
    });

    // The later file is what a watch the plan added has to report on its own.
    await detect(
      () => fs.writeFile(path.join(linked, "fresh", "deep", "second.txt"), "two\n"),
      (rows) => rows.some((row) => row.path === "fresh/deep/second.txt"),
    );
    expect(await readRows()).toContainEqual({
      path: "fresh/deep/second.txt",
      status: "?",
      additions: 1,
    });

    await removeUntilUnlisted("fresh/deep/first.txt", "fresh/deep/second.txt");
    await fs.rm(path.join(linked, "fresh"), { recursive: true });
  });

  test("a write under the ignored node_modules reaches no hint", async () => {
    if (!watchingSupported) return;
    // Exercise the real plan/filter/service with explicit delivery. Delayed native
    // events from earlier tests must not contaminate this negative assertion.
    // Native delivery remains covered by the surrounding detection tests.
    forwardNativeEvents = false;
    try {
      expect(deliverRootEvent).toBeDefined();
      await until(() => scansStarted === scansFinished);
      await sleep(LOCAL_SCAN_MIN_GAP_MS + 100);
      await until(() => scansStarted === scansFinished);
      const scansBefore = scansStarted;
      const hintsBefore = hintedPaths.length;
      await fs.writeFile(path.join(linked, "node_modules", "pkg", "index.js"), "x\n");
      deliverRootEvent!("change", "node_modules/pkg/index.js");
      await sleep(LOCAL_SCAN_MIN_GAP_MS + 100);
      expect(scansStarted).toBe(scansBefore);
      expect(hintedPaths.length).toBe(hintsBefore);
      // Positive control: the same listener must still reach the owner, scan
      // real Git, and publish the changed source file without a read or timer.
      await detect(
        async () => {
          await fs.writeFile(path.join(linked, "a.txt"), "one\ntwo\nthree\n");
          deliverRootEvent!("change", "a.txt");
        },
        (rows) => rows.some((row) => row.path === "a.txt" && row.additions === 2),
      );
      expect(scansStarted).toBeGreaterThan(scansBefore);
      expect(hintedPaths.slice(hintsBefore)).toContain("a.txt");
      expect(hintedPaths.filter((name) => name.startsWith("node_modules/"))).toEqual([]);
      expect((await readRows()).filter((row) => row.path.startsWith("node_modules/"))).toEqual([]);
    } finally {
      forwardNativeEvents = true;
    }
  });

  test("a file written inside the minimum gap reaches the following scan unasked", async () => {
    if (!watchingSupported) return;
    await detect(
      () => fs.writeFile(path.join(linked, "gap-first.txt"), "one\n"),
      (rows) => rows.some((row) => row.path === "gap-first.txt"),
    );
    const firstPublished = Date.now();

    await detect(
      () => fs.writeFile(path.join(linked, "gap-second.txt"), "two\n"),
      (rows) => rows.some((row) => row.path === "gap-second.txt"),
    );
    // Half the gap: `until` polls, so the first scan ended a little earlier.
    expect(Date.now() - firstPublished).toBeGreaterThanOrEqual(LOCAL_SCAN_MIN_GAP_MS / 2);
    const hits = metrics.snapshot().kinds["file-list-read"]?.cacheHits ?? 0;
    const rows = await readRows();
    expect(rows).toContainEqual({ path: "gap-second.txt", status: "?", additions: 1 });
    if (!EVENTS_CAN_BE_LOST) {
      expect(metrics.snapshot().kinds["file-list-read"]?.cacheHits).toBe(hits + 1);
    }

    await removeUntilUnlisted("gap-first.txt", "gap-second.txt");
  });

  test("staging in a linked worktree (index outside the root) is detected", async () => {
    if (!watchingSupported) return;
    await detect(
      () => fs.writeFile(path.join(linked, "b.txt"), "new\n"),
      (rows) => rows.some((row) => row.path === "b.txt"),
    );
    expect(await readRows()).toContainEqual({ path: "b.txt", status: "?", additions: 1 });

    const eventsBefore = rawEvents.length;
    await detect(
      (attempt) => {
        // Staging an already staged file would write no index to report.
        if (attempt > 0) run(linked, "reset", "-q", "--", "b.txt");
        run(linked, "add", "b.txt");
      },
      (rows) =>
        rows.some((row) => row.path === "b.txt" && row.status === "A") &&
        // The hint has to have come from the watch outside the root.
        rawEvents
          .slice(eventsBefore)
          .some(
            ({ target, name }) =>
              target.endsWith(path.join(".git", "worktrees", "linked")) && name === "index",
          ),
    );
    expect(await readRows()).toContainEqual({ path: "b.txt", status: "A", additions: 1 });
  });

  test("a shared ref moving the baseline outside the worktree is detected", async () => {
    if (!watchingSupported) return;
    const eventsBefore = rawEvents.length;
    await detect(
      async (attempt) => {
        await fs.writeFile(path.join(repo, `c-${attempt}.txt`), "on main\n");
        run(repo, "add", `c-${attempt}.txt`);
        run(repo, "commit", "-q", "-m", "advance main");
      },
      (rows) =>
        rows.some((row) => row.path === "c-0.txt" && row.status === "D") &&
        // The hint has to have come from the shared refs' own watch.
        rawEvents
          .slice(eventsBefore)
          .some(
            ({ target, name }) =>
              target.endsWith(path.join(".git", "refs")) &&
              name?.split(path.sep).join("/") === "heads/main",
          ),
    );
    expect(await readRows()).toContainEqual({ path: "c-0.txt", status: "D", additions: 0 });
  });
});
