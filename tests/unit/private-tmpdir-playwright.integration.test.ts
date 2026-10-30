import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KEEP_PRIVATE_TMPDIR_ENV, PRIVATE_TMPDIR_ENV, privateTmpdirRoot } from "../private-tmpdir";
import { PARENT_TMPDIR_ENV } from "../temp-sweep";

const repository = path.resolve(import.meta.dir, "../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a detached child creates temporary files after its private-TMPDIR owner exits", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ork-outlive-"));
  roots.push(root);
  const ready = path.join(root, "ready");
  const release = path.join(root, "release");
  const resultFile = path.join(root, "result.json");
  const childFile = path.join(root, "child.ts");
  writeFileSync(
    childFile,
    `
    import { existsSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import path from "node:path";
    writeFileSync(${JSON.stringify(ready)}, "ready");
    const deadline = Date.now() + 15_000;
    while (!existsSync(${JSON.stringify(release)})) {
      if (Date.now() > deadline) process.exit(1);
      await Bun.sleep(10);
    }
    const directory = mkdtempSync(path.join(tmpdir(), "after-owner-"));
    writeFileSync(path.join(directory, "proof"), "created after owner exit");
    writeFileSync(${JSON.stringify(`${resultFile}.tmp`)}, JSON.stringify({ directory,
      privateTmpdir: process.env.${PRIVATE_TMPDIR_ENV},
      parentTmpdir: process.env.${PARENT_TMPDIR_ENV} }));
    renameSync(${JSON.stringify(`${resultFile}.tmp`)}, ${JSON.stringify(resultFile)});
    `,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root };
  for (const key of [PRIVATE_TMPDIR_ENV, PARENT_TMPDIR_ENV, KEEP_PRIVATE_TMPDIR_ENV])
    delete env[key];
  const owner = spawnSync(
    process.execPath,
    [
      "--eval",
      `
      import { spawn } from "node:child_process";
      import { existsSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { enterPrivateTestTmpdir, outlivingProcessEnv } from ${JSON.stringify(path.join(repository, "tests/private-tmpdir.ts"))};
      process.once("exit", enterPrivateTestTmpdir());
      const child = spawn(process.execPath, [${JSON.stringify(childFile)}], {
        detached: true, stdio: "ignore", env: outlivingProcessEnv(),
      });
      child.unref();
      console.log(JSON.stringify({ directory: tmpdir(), pid: child.pid }));
      const deadline = Date.now() + 5_000;
      while (!existsSync(${JSON.stringify(ready)})) {
        if (Date.now() > deadline) process.exit(1);
        await Bun.sleep(10);
      }
      `,
    ],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  const child = JSON.parse(owner.stdout.trim()) as { directory: string; pid: number };
  roots.push(child.directory);
  try {
    expect(owner.stderr).toBe("");
    expect(owner.status).toBe(0);
    expect(existsSync(child.directory)).toBe(false);
    // spawnSync returned only after the owner exited and its exit handler removed TMPDIR.
    writeFileSync(release, "go");
    const deadline = Date.now() + 5_000;
    while (!existsSync(resultFile)) {
      if (Date.now() > deadline) throw new Error("detached child did not create temporary files");
      await Bun.sleep(10);
    }
    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    expect(path.dirname(result.directory)).toBe(root);
    expect(result.privateTmpdir).toBeUndefined();
    expect(result.parentTmpdir).toBeUndefined();
    expect(readFileSync(path.join(result.directory, "proof"), "utf8")).toBe(
      "created after owner exit",
    );
    expect(path.dirname(child.directory)).toBe(privateTmpdirRoot(root));
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
}, 20_000);

describe("Playwright private TMPDIR wiring", () => {
  for (const config of [
    "e2e/playwright.config.ts",
    "e2e/public-site/playwright.config.ts",
    // The real-stack and preview suites (0830); the Claude warm and
    // paused-interactions configs spread the browser one.
    "e2e/agent-testing/playwright.browser.config.ts",
    "e2e/agent-testing/playwright.coordinator.config.ts",
    "e2e/agent-testing/playwright.electron.config.ts",
    "e2e/preview/playwright.preview.config.ts",
  ]) {
    for (const outlives of [false, true]) {
      test(`${config}: runner and worker share a directory that is ${outlives ? "retained for a live browser" : "removed on exit"}`, async () => {
        // In the parent TMPDIR, not this process's private one: the runner's
        // private directory nests inside `root`, and Chrome's SingletonSocket
        // inside that, which passed Linux's 108-byte socket limit (0830).
        const parent = process.env[PARENT_TMPDIR_ENV] || tmpdir();
        const root = mkdtempSync(path.join(parent, "ork-pw-tmp-test-"));
        roots.push(root);
        const fixture = path.join(root, "fixture");
        mkdirSync(fixture);
        writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
        const runnerFile = path.join(root, "runner.json");
        const workerFile = path.join(root, "worker.json");
        // Load the real config in both the runner and worker. Only replace the
        // test/server settings so this check needs no application server.
        const generatedConfig = path.join(fixture, "playwright.config.ts");
        writeFileSync(
          generatedConfig,
          `
          import actual from ${JSON.stringify(path.join(repository, config))};
          import { writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          if (process.env.TEST_WORKER_INDEX === undefined)
            writeFileSync(${JSON.stringify(runnerFile)}, JSON.stringify({ tmp: tmpdir(), pid: process.pid }));
          export default { ...actual, webServer: undefined, globalSetup: undefined, globalTeardown: undefined,
            testDir: ${JSON.stringify(fixture)}, testMatch: "tmpdir.spec.ts", testIgnore: [], workers: 1,
            outputDir: ${JSON.stringify(path.join(root, "results"))},
            projects: [{ name: "tmpdir" }], reporter: "line" };
        `,
        );
        writeFileSync(
          path.join(fixture, "tmpdir.spec.ts"),
          `
          import { test, expect, chromium } from ${JSON.stringify(path.join(path.dirname(require.resolve("@playwright/test")), "index.mjs"))};
          import { spawn } from "node:child_process";
          import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
          import { tmpdir } from "node:os";
          import path from "node:path";
          test("worker inherits runner TMPDIR", async () => {
            const runner = JSON.parse(readFileSync(${JSON.stringify(runnerFile)}, "utf8"));
            expect(process.pid).not.toBe(runner.pid);
            expect(tmpdir()).toBe(runner.tmp);
            expect(process.env.${PRIVATE_TMPDIR_ENV}).toBe(runner.tmp);
            expect(process.env.${PARENT_TMPDIR_ENV}).toBe(${JSON.stringify(root)});
            const profile = path.join(tmpdir(), "playwright_chromiumdev_profile-Abc123");
            mkdirSync(profile);
            let pid;
            if (${outlives}) {
              const child = spawn(chromium.executablePath(), ["--headless", "--no-sandbox",
                "--disable-gpu", "--no-startup-window", "--remote-debugging-port=0", "--user-data-dir=" + profile],
                { stdio: "ignore", detached: true });
              pid = child.pid;
              child.unref();
              writeFileSync(${JSON.stringify(workerFile)}, JSON.stringify({ tmp: tmpdir(), pid }));
              await expect.poll(() => {
                try { return readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").length > 0; }
                catch { return false; }
              }).toBe(true);
            } else {
              const browser = await chromium.launch();
              await browser.close();
            }
            writeFileSync(${JSON.stringify(workerFile)}, JSON.stringify({ tmp: tmpdir(), pid }));
          });
        `,
        );
        const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root };
        for (const key of [
          PRIVATE_TMPDIR_ENV,
          PARENT_TMPDIR_ENV,
          KEEP_PRIVATE_TMPDIR_ENV,
          "JEST_WORKER_ID",
          "BUN_TEST_WORKER_ID",
        ])
          delete env[key];
        const result = spawnSync("bunx", ["playwright", "test", "--config", generatedConfig], {
          cwd: repository,
          env,
          encoding: "utf8",
          timeout: 45_000,
        });
        const runner = existsSync(runnerFile) ? JSON.parse(readFileSync(runnerFile, "utf8")) : null;
        const worker = existsSync(workerFile) ? JSON.parse(readFileSync(workerFile, "utf8")) : null;
        if (runner?.tmp && runner.tmp !== root) roots.push(runner.tmp);
        try {
          expect(result.stdout + result.stderr).toContain("1 passed");
          expect(result.status).toBe(0);
          expect(worker.tmp).toBe(runner.tmp);
          expect(existsSync(runner.tmp)).toBe(outlives);
        } finally {
          if (worker?.pid) {
            // Chromium children share the detached process group. Stop all of
            // them before afterEach removes the retained profile.
            try {
              process.kill(-worker.pid, "SIGKILL");
            } catch {
              /* already exited */
            }
          }
        }
      }, 60_000);
    }
  }
});
