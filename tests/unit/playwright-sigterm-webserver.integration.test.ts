import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TEST_GROUP_TIMEOUT_MS_ENV,
  TEST_LOG_DIRECTORY_ENV,
  TEST_MAX_OUTPUT_BYTES_ENV,
  TEST_NO_PROGRESS_TIMEOUT_MS_ENV,
  defaultRunGroup,
} from "../../scripts/test-all";
import { KEEP_PRIVATE_TMPDIR_ENV, PRIVATE_TMPDIR_ENV } from "../private-tmpdir";
import { PARENT_TMPDIR_ENV } from "../temp-sweep";

// To-do 8040 (retired): `terminate` in scripts/test-all.ts sends SIGTERM to a group's
// process group and SIGKILL a second later. Playwright starts its `webServer`
// in a process group of its own, so neither signal reaches it, and the runner
// used to die of the SIGTERM without the teardown that stops it. This runs the
// real configs that declare a `webServer` through the real group runner, has
// the spec trip the runner's output budget once the server is up (the same
// `terminate` the watchdog and deadline use, without their timing), and
// checks that the server's process group is gone afterwards.

const repository = path.resolve(import.meta.dir, "../..");
const playwrightTest = path.join(path.dirname(require.resolve("@playwright/test")), "index.mjs");
/** Small enough that the spec's flood trips it, large enough for Playwright's own lines. */
const OUTPUT_BUDGET_BYTES = 64 * 1024;

const roots: string[] = [];
const servers: number[] = [];
afterEach(() => {
  // Only a server this file started, by the PID it recorded for itself.
  for (const pid of servers.splice(0)) {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

describe.skipIf(process.platform === "win32")("SIGTERM to the Playwright runner", () => {
  for (const config of ["e2e/playwright.config.ts", "e2e/public-site/playwright.config.ts"]) {
    test(`${config}: terminate also stops the webServer process group`, async () => {
      // In the parent TMPDIR, as in private-tmpdir-playwright: the runner's
      // private directory nests inside `root`.
      const parent = process.env[PARENT_TMPDIR_ENV] || tmpdir();
      const root = mkdtempSync(path.join(parent, "ork-pw-sigterm-"));
      roots.push(root);
      const fixture = path.join(root, "fixture");
      mkdirSync(fixture);
      writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
      const serverPidFile = path.join(root, "server.pid");
      const startedFile = path.join(root, "started");

      const serverFile = path.join(fixture, "server.ts");
      writeFileSync(
        serverFile,
        `
        import { writeFileSync } from "node:fs";
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
        writeFileSync(${JSON.stringify(serverPidFile)}, String(process.pid));
        // Playwright waits for this line rather than polling a port chosen in advance.
        console.log("fixture server listening on " + server.port);
        `,
      );
      // Load the real config, so its SIGTERM handling is what runs. Only the
      // server, tests and output move into this fixture.
      const generatedConfig = path.join(fixture, "playwright.config.ts");
      writeFileSync(
        generatedConfig,
        `
        import actual from ${JSON.stringify(path.join(repository, config))};
        export default { ...actual, globalSetup: undefined, globalTeardown: undefined,
          webServer: { command: ${JSON.stringify(`exec "${process.execPath}" "${serverFile}"`)},
            wait: { stdout: /fixture server listening on \\d+/ }, reuseExistingServer: false,
            timeout: 60_000 },
          testDir: ${JSON.stringify(fixture)}, testMatch: "flood.spec.ts", testIgnore: [], workers: 1,
          retries: 0, outputDir: ${JSON.stringify(path.join(root, "results"))},
          projects: [{ name: "flood" }], reporter: "line" };
        `,
      );
      writeFileSync(
        path.join(fixture, "flood.spec.ts"),
        `
        import { test } from ${JSON.stringify(playwrightTest)};
        import { writeFileSync } from "node:fs";
        test("floods its output once the server is up, then waits", async () => {
          test.setTimeout(120_000);
          writeFileSync(${JSON.stringify(startedFile)}, "started");
          process.stdout.write("x".repeat(${OUTPUT_BUDGET_BYTES * 4}) + "\\n");
          await new Promise(() => {});
        });
        `,
      );

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TMPDIR: root,
        [TEST_LOG_DIRECTORY_ENV]: path.join(root, "logs"),
        [TEST_MAX_OUTPUT_BYTES_ENV]: String(OUTPUT_BUDGET_BYTES),
        // Only the output budget should stop this run.
        [TEST_NO_PROGRESS_TIMEOUT_MS_ENV]: "120000",
        [TEST_GROUP_TIMEOUT_MS_ENV]: "120000",
      };
      for (const key of [
        PRIVATE_TMPDIR_ENV,
        PARENT_TMPDIR_ENV,
        KEEP_PRIVATE_TMPDIR_ENV,
        "JEST_WORKER_ID",
        "BUN_TEST_WORKER_ID",
        "TEST_WORKER_INDEX",
        "CI",
      ])
        delete env[key];

      const result = await defaultRunGroup(
        {
          name: "playwright sigterm",
          command: "bunx",
          args: ["playwright", "test", "--config", generatedConfig],
        },
        env,
      );
      const serverPid = existsSync(serverPidFile)
        ? Number(readFileSync(serverPidFile, "utf8"))
        : undefined;
      if (serverPid) servers.push(serverPid);

      // The run was stopped by `terminate`, after the server and spec started.
      expect(result.outputLimitExceeded, result.output).toBe(true);
      expect(existsSync(startedFile), result.output).toBe(true);
      expect(serverPid).toBeGreaterThan(0);
      // `exec` made the server the leader of the group Playwright created.
      // Playwright's own teardown SIGKILLs that group; allow it a moment.
      expect(await goneWithin(serverPid!, 3_000)).toBe(true);
      let groupGone = false;
      try {
        process.kill(-serverPid!, 0);
      } catch (error) {
        groupGone = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      expect(groupGone).toBe(true);
    }, 150_000);
  }
});
