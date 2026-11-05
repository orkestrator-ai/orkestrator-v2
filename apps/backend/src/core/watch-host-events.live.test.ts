import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WatchHost } from "./watch-host.js";

// Real OS event delivery belongs in the slow tier; deterministic helper
// batching and backpressure are covered by watch-host-program.test.ts.
let directory = "";
const host = new WatchHost();
afterEach(async () => {
  host.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

test("delivers real create, modify and rename events, and recovers after helper death", async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "ork-watch-host-")));
  const target = path.join(directory, "created");
  const seen: Array<[string, string | null]> = [];
  const errors: unknown[] = [];
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(`helper did not deliver event: ${JSON.stringify(seen)}`);
      await Bun.sleep(5);
    }
  };
  const live = host.watch(directory, (type, name) => seen.push([type, name]), { recursive: false });
  live.on("error", (error) => errors.push(error));
  await live.established;
  await writeFile(target, "one");
  await until(() => seen.some(([, name]) => name === "created"));
  seen.length = 0;
  await writeFile(target, "two");
  await until(() => seen.some(([type]) => type === "change"));
  seen.length = 0;
  const renamed = path.join(directory, "renamed");
  await rename(target, renamed);
  await until(() => seen.some(([type]) => type === "rename"));
  host.stop();
  expect(errors).toHaveLength(1);
  seen.length = 0;
  const restarted = host.watch(directory, (type, name) => seen.push([type, name]), {
    recursive: false,
  });
  await restarted.established;
  await writeFile(renamed, "three");
  await until(() => seen.some(([type]) => type === "change"));
  restarted.close();
}, 60_000);
