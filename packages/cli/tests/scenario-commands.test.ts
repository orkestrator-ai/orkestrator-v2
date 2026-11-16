import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, runGit } from "../scenarios/harness.js";

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("scenario command helpers", () => {
  test("kills a TERM-resistant helper at its deadline and settles both output pipes", async () => {
    const result = await runCommand(
      [
        process.execPath,
        "--eval",
        `process.on("SIGTERM", () => {});
         console.log("started");
         console.error("waiting");
         setInterval(() => {}, 1000);`,
      ],
      { timeoutMs: 500 },
    );
    expect(result.code).toBe(128 + 9);
    expect(result.stdout).toBe("started\n");
    expect(result.stderr).toBe("waiting\n");
  }, 5_000);

  test("a successful helper clears its deadline so its caller process can exit", async () => {
    const harnessUrl = new URL("../scenarios/harness.ts", import.meta.url).href;
    const result = await runCommand(
      [
        process.execPath,
        "--eval",
        `import { runCommand } from ${JSON.stringify(harnessUrl)};
         const result = await runCommand(
           [process.execPath, "--eval", 'console.log("done")'],
           { timeoutMs: 60_000 },
         );
         console.log(JSON.stringify(result));`,
      ],
      { timeoutMs: 5_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ code: 0, stdout: "done\n", stderr: "" });
  }, 10_000);

  test("reports Git's nonzero exit with its stderr", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-scenario-command-"));
    directories.push(root);
    await runGit(["init", "--bare", root]);
    await expect(
      runGit(["rev-parse", "--verify", "refs/heads/absent"], {
        cwd: root,
        env: { ...process.env, LC_ALL: "C" },
      }),
    ).rejects.toThrow("git rev-parse failed: fatal: Needed a single revision");
  });

  test("failed and timed-out helpers leave concurrent Git and subprocess commands able to finish", async () => {
    const results = await Promise.all([
      runCommand([
        process.execPath,
        "--eval",
        'console.error("controlled failure"); process.exit(23)',
      ]),
      runCommand([process.execPath, "--eval", "setInterval(() => {}, 1000)"], { timeoutMs: 500 }),
      ...Array.from({ length: 8 }, async (_, index) => {
        expect(await runGit(["--version"])).toStartWith("git version ");
        return runCommand([process.execPath, "--eval", `console.log(${index})`]);
      }),
    ]);
    expect(results[0]).toEqual({ code: 23, stdout: "", stderr: "controlled failure\n" });
    expect(results[1]!.code).toBe(128 + 9);
    for (const [index, result] of results.slice(2).entries()) {
      expect(result).toEqual({ code: 0, stdout: `${index}\n`, stderr: "" });
    }
    expect(await runCommand([process.execPath, "--eval", 'console.log("after failures")'])).toEqual(
      {
        code: 0,
        stdout: "after failures\n",
        stderr: "",
      },
    );
  }, 10_000);
});
