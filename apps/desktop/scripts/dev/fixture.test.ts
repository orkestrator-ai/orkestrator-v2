import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../electron/runtime-profile.js";
import { prepareFixtureRepository } from "./fixture.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, {
  recursive: true,
  force: true,
}))));

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (status !== 0) throw new Error(stderr);
  return stdout.trim();
}

describe("disposable agent-test fixture", () => {
  test("re-seeds the same commit without modifying the checked-in template", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-fixture-"));
    directories.push(root);
    const template = path.resolve(import.meta.dirname, "../../../../test-fixtures/agent-project");
    const before = await readFile(path.join(template, "package.json"), "utf8");
    const profile = resolveRuntimeProfile({
      repositoryRoot: path.join(root, "repo"),
      requestedId: "fixture-test",
      roots: {
        developmentRoot: path.join(root, "profiles"),
        productionDataDir: path.join(root, "production"),
        homeDir: root,
      },
    });

    const first = await prepareFixtureRepository(profile, template);
    const firstCommit = await gitOutput(first, "rev-parse", "HEAD");
    await Bun.write(path.join(first, "disposable-change.txt"), "changed\n");
    const second = await prepareFixtureRepository(profile, template);

    expect(second).toBe(first);
    expect(await gitOutput(second, "rev-parse", "HEAD")).toBe(firstCommit);
    expect(await gitOutput(second, "status", "--porcelain")).toBe("");
    expect(await readFile(path.join(template, "package.json"), "utf8")).toBe(before);
  });
});
