import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { WatchHost } from "./watch-host.js";

/**
 * Real OS event delivery through the real helper process. Deterministic helper
 * batching and backpressure are covered by watch-host-program.test.ts.
 *
 * A loaded host's `fseventsd` delivers tens of seconds late and loses events: with
 * it pinned at 100% of a core, independent Bun and Node processes writing one new
 * file a second each saw their first event 72 s in, and about 44 events for the
 * first 107 files. One write therefore proves nothing, so each step repeats its
 * change until an event names it.
 */

const DELIVERY_DEADLINE_MS = 240_000;
const REPEAT_MS = 500;
const PROGRESS_MS = 30_000;

let directory = "";
const host = new WatchHost();

afterEach(async () => {
  host.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

test("delivers real create, modify and rename events, and recovers after helper death", async () => {
  // The checkout's own file system, as in worktree-watcher-real.test.ts.
  const parent = path.resolve(import.meta.dir, "../../../../output/watch-fixtures");
  await mkdir(parent, { recursive: true });
  directory = await realpath(await mkdtemp(path.join(parent, "ork-watch-host-")));
  const inside = (name: string) => path.join(directory, name);

  const seen = new Set<string | null>();
  const listener = (_type: string, name: string | null) => void seen.add(name);

  /** Repeats a change, which returns the name it touched, until an event names one. */
  const deliver = async (step: string, change: (attempt: number) => Promise<string>) => {
    const started = Date.now();
    const touched = new Set<string>();
    let progress = started;
    for (let attempt = 0; ; attempt += 1) {
      touched.add(await change(attempt));
      await Bun.sleep(REPEAT_MS);
      if ([...touched].some((name) => seen.has(name))) break;
      if (Date.now() - started > DELIVERY_DEADLINE_MS) {
        throw new Error(`helper delivered no ${step} event in ${DELIVERY_DEADLINE_MS} ms`);
      }
      // Keeps a loaded Mac's run from looking stalled to the runner's watchdog.
      if (Date.now() - progress > PROGRESS_MS) {
        progress = Date.now();
        process.stderr.write(`still waiting for a ${step} event\n`);
      }
    }
    process.stderr.write(`${step} event after ${Date.now() - started} ms\n`);
  };

  // Written before the watch, so that its own create event is not the proof below.
  await writeFile(inside("modified"), "before");

  const errors: unknown[] = [];
  const live = host.watch(directory, listener, { recursive: false });
  live.on("error", (error) => errors.push(error));
  await live.established;

  await deliver("create", async (attempt) => {
    await writeFile(inside(`created-${attempt}`), "one");
    return `created-${attempt}`;
  });
  // Delivery is ordered, so anything from before the watch has now gone by.
  seen.clear();

  await deliver("modify", async (attempt) => {
    await writeFile(inside("modified"), `after-${attempt}`);
    return "modified";
  });

  await deliver("rename", async (attempt) => {
    await writeFile(inside(`source-${attempt}`), "one");
    await rename(inside(`source-${attempt}`), inside(`renamed-${attempt}`));
    return `renamed-${attempt}`;
  });
  expect(errors).toEqual([]);

  // A lost helper fails its watches, and the next start spawns one that delivers.
  host.stop();
  expect(errors).toHaveLength(1);
  const restarted = host.watch(directory, listener, { recursive: false });
  await restarted.established;
  await deliver("post-restart", async (attempt) => {
    await writeFile(inside(`restarted-${attempt}`), "one");
    return `restarted-${attempt}`;
  });
  restarted.close();
}, 1_000_000);
