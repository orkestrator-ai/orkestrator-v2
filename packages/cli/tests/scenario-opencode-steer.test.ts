import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScriptedModel } from "../../../scripts/opencode2-steer-probe.js";
import { scenarioPaths } from "../scenarios/harness.js";
import { OPENCODE_STEER_SCENARIO } from "../scenarios/opencode-steer.js";

const directories: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ork-cli-opencode-steer-"));
  directories.push(dir);
  return dir;
}

/** Spy on the scripted model's start, keeping the real one, to learn its origin. */
function watchStart() {
  const start = spyOn(ScriptedModel.prototype, "start");
  spies.push(start);
  return () => start.mock.results.map((result) => result.value as string);
}

test("runs only on a local environment, where its loopback model is reachable", () => {
  expect(OPENCODE_STEER_SCENARIO.explicit).toBe(true);
  expect(OPENCODE_STEER_SCENARIO.environmentTypes).toEqual(["local"]);
});

test("prepare stops its scripted model when a later setup write fails", async () => {
  const origins = watchStart();
  const dir = await root();
  // A file where the provider homes' directory should be makes the first mkdir fail.
  await writeFile(path.join(dir, "provider-homes"), "not a directory");
  await expect(OPENCODE_STEER_SCENARIO.prepare!(scenarioPaths(dir))).rejects.toThrow();
  const [origin] = origins();
  expect(origin).toStartWith("http://127.0.0.1:");
  await expect(fetch(`${origin}/v1/chat/completions`, { method: "POST" })).rejects.toThrow();

  // The module state was cleared too: the next prepare starts afresh and undoes cleanly.
  const next = await root();
  const undo = await OPENCODE_STEER_SCENARIO.prepare!(scenarioPaths(next));
  try {
    expect((await stat(path.join(next, "data", "config.json"))).isFile()).toBe(true);
    const second = origins()[1]!;
    expect(second).not.toBe(origin);
    expect((await fetch(`${second}/v1/models`)).status).toBe(404);
  } finally {
    await undo();
  }
  await expect(fetch(`${origins()[1]}/v1/models`)).rejects.toThrow();
});
