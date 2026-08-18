import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const runner = path.join(root, "scripts/run-logged.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((target) =>
      rm(target, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function runLogged(args: string[]) {
  const logDirectory = await mkdtemp(path.join(os.tmpdir(), "ork-run-logged-test-"));
  temporaryDirectories.push(logDirectory);
  const result = Bun.spawnSync({
    cmd: ["bun", runner, ...args],
    cwd: root,
    env: { ...process.env, ORKESTRATOR_TEST_LOG_DIR: logDirectory },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    logDirectory,
  };
}

describe("scripts/run-logged.ts", () => {
  test("accepts separators and a name, deletes passing output, and writes a summary", async () => {
    const result = await runLogged([
      "--",
      "--name",
      "focused validation",
      "--",
      process.execPath,
      "-e",
      "process.stdout.write('bounded output')",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS focused validation");
    const entries = await readdir(result.logDirectory);
    expect(entries).toContain("summary.json");
    expect(entries.some((entry) => entry.endsWith(".log"))).toBe(false);
    const summary = JSON.parse(
      await readFile(path.join(result.logDirectory, "summary.json"), "utf8"),
    ) as { succeeded: boolean; groups: Array<{ name: string }> };
    expect(summary.succeeded).toBe(true);
    expect(summary.groups[0]?.name).toBe("focused validation");
  });

  test("propagates failure status and retains a compressed artifact", async () => {
    const result = await runLogged([
      "--name",
      "failing validation",
      "--",
      process.execPath,
      "-e",
      "process.stderr.write('intentional failure'); process.exit(7)",
    ]);

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("FAIL failing validation");
    expect(result.stderr).toContain("intentional failure");
    expect(result.stderr).toContain("Failure artifacts:");
    expect((await readdir(result.logDirectory)).some((entry) => entry.endsWith(".log.gz"))).toBe(
      true,
    );
  });

  test("uses the default name when no name flag is supplied", async () => {
    const result = await runLogged([process.execPath, "-e", "process.exit(0)"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS validation");
  });

  test("rejects missing commands and missing or blank name values", async () => {
    for (const args of [[], ["--name"], ["--name", ""]]) {
      const result = await runLogged(args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Usage: bun run test:logged");
    }
  });
});
