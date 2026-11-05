import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILD_COMMIT_ENV, buildCommitDefine } from "@orkestrator/protocol/node/build-commit";

/**
 * `BUILD_COMMIT` in a real bundle of the real module, the way both backend build
 * scripts embed it, and run from source, the way `dev:test` runs the backend.
 */

const CONSTANTS = path.join(import.meta.dir, "constants.ts");
const PRINT = `import { BUILD_COMMIT } from ${JSON.stringify(CONSTANTS)};
process.stdout.write(JSON.stringify(BUILD_COMMIT));`;

describe("BUILD_COMMIT", () => {
  let directory: string;
  let entry: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "orkestrator-build-commit-bundle-"));
    entry = path.join(directory, "print.ts");
    await writeFile(entry, PRINT);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** Runs with a different commit in its environment, which must never be believed. */
  function run(file: string): unknown {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", file], {
      cwd: directory,
      env: { ...process.env, [BUILD_COMMIT_ENV]: "fffffff" },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return JSON.parse(result.stdout.toString());
  }

  async function bundled(env: NodeJS.ProcessEnv, name: string): Promise<unknown> {
    const built = await Bun.build({
      entrypoints: [entry],
      outdir: path.join(directory, name),
      target: "bun",
      define: buildCommitDefine(env),
    });
    expect(built.success).toBe(true);
    return run(built.outputs[0]!.path);
  }

  test("a bundle reports the commit it was built with, not one in its environment", async () => {
    expect(await bundled({ [BUILD_COMMIT_ENV]: "abc1234" }, "stamped")).toBe("abc1234");
  });

  test("a bundle built with no commit reports null", async () => {
    expect(await bundled({}, "unset")).toBeNull();
  });

  test("a bundle from a modified tree, whose task exports an empty value, reports null", async () => {
    expect(await bundled({ [BUILD_COMMIT_ENV]: "" }, "empty")).toBeNull();
  });

  test("a bundle given an invalid value reports null", async () => {
    expect(await bundled({ [BUILD_COMMIT_ENV]: "abc1234-dirty" }, "invalid")).toBeNull();
  });

  test("running from source, as dev:test does, reports null", () => {
    expect(run(entry)).toBeNull();
  });
});
