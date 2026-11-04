import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("Playwright's resolved headless config passes the real no-display preflight", async () => {
  if (process.platform !== "linux") return;
  const directory = await mkdtemp(path.join(os.tmpdir(), "ork-display-config-"));
  const reporter = path.join(directory, "preflight.mts");
  const setup = path.join(import.meta.dirname, "electron-display-setup.ts");
  const {
    DISPLAY: _display,
    WAYLAND_DISPLAY: _wayland,
    JEST_WORKER_ID: _jest,
    BUN_TEST_WORKER_ID: _worker,
    ...env
  } = process.env;
  try {
    await writeFile(
      reporter,
      `import setup from ${JSON.stringify(setup)};
      export default class {
        onBegin(config) { try { setup(config); console.log("resolved-preflight-passed"); }
          catch (error) { console.error(error.message); throw error; } }
        onError(error) { console.error(error); }
      };`,
    );
    for (const [config, allowed] of [
      ["playwright.electron-headless.config.ts", true],
      ["playwright.electron.config.ts", false],
    ] as const) {
      // Keep the real config's projects/testMatch and resolve only an empty testDir;
      // listing tests still calls the reporter with Playwright's FullConfig.
      const wrapper = path.join(directory, "playwright.config.mts");
      await writeFile(
        wrapper,
        `import config from ${JSON.stringify(path.join(import.meta.dirname, config))};
        export default { ...config, testDir: ${JSON.stringify(directory)} };`,
      );
      const run = spawnSync(
        "bunx",
        [
          "playwright",
          "test",
          "--config",
          wrapper,
          "--list",
          "--pass-with-no-tests",
          "--reporter",
          reporter,
        ],
        {
          env: { ...env, ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON: "1" },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      if (allowed) {
        expect(run.stderr).toBe("");
        expect({ status: run.status, stdout: run.stdout }).toEqual({
          status: 0,
          stdout: expect.stringContaining("resolved-preflight-passed"),
        });
        expect(run.stdout).toContain("resolved-preflight-passed");
      } else {
        expect(run.stdout + run.stderr).toContain("neither DISPLAY nor WAYLAND_DISPLAY");
        expect(run.stdout).not.toContain("resolved-preflight-passed");
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 150_000);
