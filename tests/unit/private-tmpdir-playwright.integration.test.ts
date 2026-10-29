import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KEEP_PRIVATE_TMPDIR_ENV, PRIVATE_TMPDIR_ENV } from "../private-tmpdir";
import { PARENT_TMPDIR_ENV } from "../temp-sweep";

const repository = path.resolve(import.meta.dir, "../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Playwright private TMPDIR wiring", () => {
  for (const config of ["e2e/playwright.config.ts", "e2e/public-site/playwright.config.ts"]) {
    for (const outlives of [false, true]) {
      test(`${config}: runner and worker share a directory that is ${outlives ? "retained for a live browser" : "removed on exit"}`, async () => {
        const root = mkdtempSync(path.join(tmpdir(), "ork-pw-tmp-test-"));
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
          export default { ...actual, webServer: undefined, globalSetup: undefined,
            testDir: ${JSON.stringify(fixture)}, testIgnore: [], workers: 1,
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
