import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const preload = resolve(import.meta.dir, "../default-test-timeout.ts");

// Exercise the actual preload in fresh test runners, without the repository's
// other preloads masking its behavior. These are the supported multi-file modes.
test.each([
  { flags: ["--parallel=1"] },
  { flags: ["--parallel=2"] },
  { flags: ["--parallel=1", "--isolate", "--rerun-each=2"] },
])("timeout preload runtime contract with %j", async ({ flags }) => {
  const root = mkdtempSync(join(tmpdir(), "timeout-contract-"));
  try {
    for (const name of ["first", "second"]) {
      writeFileSync(
        join(root, `${name}.test.ts`),
        `import { test } from "bun:test";
// Exceed Bun's unconfigured five-second budget in both isolated files.
test("${name} uses the preload budget", async () => { await Bun.sleep(5100); });`,
      );
    }
    const run = async (files: string[]) => {
      const child = Bun.spawn(
        [process.execPath, "test", "--preload", preload, ...files, ...flags],
        {
          cwd: root,
          env: { ...process.env, NODE_ENV: "test" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 45000,
        },
      );
      const output = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      try {
        return { status: await child.exited, output: (await output).join("") };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        await output;
      }
    };
    const defaults = await run(["./first.test.ts", "./second.test.ts"]);
    expect(defaults.status, defaults.output).toBe(0);
    for (const name of ["first", "second"])
      expect(defaults.output).toContain(`${name} uses the preload budget`);

    writeFileSync(
      join(root, "overrides.test.ts"),
      `import { test, setDefaultTimeout } from "bun:test";
setDefaultTimeout(50);
test("file override wins", async () => { await new Promise(() => {}); });
test("explicit short test override wins", async () => { await new Promise(() => {}); }, 30);
test("explicit long test override wins", async () => { await Bun.sleep(100); }, 5000);`,
    );
    const overrides = await run(["./overrides.test.ts"]);
    expect(overrides.status, overrides.output).toBe(1);
    expect(overrides.output).toMatch(/\(fail\) file override wins/);
    expect(overrides.output).toMatch(/\(fail\) explicit short test override wins/);
    expect(overrides.output).toMatch(/\(pass\) explicit long test override wins/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
