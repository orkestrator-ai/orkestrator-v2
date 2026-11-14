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
import { RUNNER_SIGTERM_EXIT_CODE } from "../playwright-runner-sigterm";
import { PARENT_TMPDIR_ENV } from "../temp-sweep";

// To-do 8040 (retired): `terminate` in scripts/test-all.ts sends SIGTERM to a group's
// process group and SIGKILL a second later. Playwright starts its `webServer`
// in a process group of its own, so neither signal reaches it, and the runner
// used to die of the SIGTERM without the teardown that stops it. This runs the
// real configs that declare a `webServer` through the real group runner, has
// the spec trip the runner's output budget once the server is up (the same
// `terminate` the watchdog and deadline use, without their timing), and
// checks that the server's process group is gone afterwards.
//
// Each config runs twice, once per shutdown path of the handler:
// - "sigint": Playwright's own SIGINT teardown stops the server, and the
//   runner exits 130 (interrupted).
// - "exit fallback": a global teardown that never settles holds back the
//   `webServer` teardown, which Playwright runs after it. Only the handler's
//   500 ms `exit(143)` can then stop the server, through playwright-core's
//   `exit` handler, before `terminate`'s SIGKILL a second after the SIGTERM.
//
// The server is started the way the production commands start Vite: a shell
// leads the group and runs a launcher (`bunx`) that spawns the server, so the
// server is a grandchild and not the group leader that Playwright recorded.

const repository = path.resolve(import.meta.dir, "../..");
const playwrightTest = path.join(path.dirname(require.resolve("@playwright/test")), "index.mjs");
const sigtermModule = path.join(repository, "tests/playwright-runner-sigterm.ts");
/** Small enough that the spec's flood trips it, large enough for Playwright's own lines. */
const OUTPUT_BUDGET_BYTES = 64 * 1024;
/** Playwright's exit status for an interrupted run, the SIGINT path. */
const PLAYWRIGHT_INTERRUPTED_EXIT_CODE = 130;

type ShutdownPath = "sigint" | "exit fallback";

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

function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function goneWithin(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

function readNumber(file: string): number | undefined {
  return existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : undefined;
}

describe.skipIf(process.platform === "win32")("SIGTERM to the Playwright runner", () => {
  const cases: Array<[string, ShutdownPath]> = [];
  for (const config of ["e2e/playwright.config.ts", "e2e/public-site/playwright.config.ts"]) {
    cases.push([config, "sigint"], [config, "exit fallback"]);
  }
  for (const [config, shutdown] of cases) {
    test(`${config}: terminate stops the webServer process group (${shutdown})`, async () => {
      // In the parent TMPDIR, as in private-tmpdir-playwright: the runner's
      // private directory nests inside `root`.
      const parent = process.env[PARENT_TMPDIR_ENV] || tmpdir();
      const root = mkdtempSync(path.join(parent, "ork-pw-sigterm-"));
      roots.push(root);
      const fixture = path.join(root, "fixture");
      mkdirSync(fixture);
      writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
      const serverPidFile = path.join(root, "server.pid");
      const serverPgidFile = path.join(root, "server.pgid");
      const startedFile = path.join(root, "started");
      const runnerExitFile = path.join(root, "runner.exit");
      const teardownStartedFile = path.join(root, "teardown-started");

      const serverFile = path.join(fixture, "server.ts");
      writeFileSync(
        serverFile,
        `
        import { writeFileSync } from "node:fs";
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
        const pgid = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)]).stdout.toString().trim();
        writeFileSync(${JSON.stringify(serverPgidFile)}, pgid);
        writeFileSync(${JSON.stringify(serverPidFile)}, String(process.pid));
        // Playwright waits for this line rather than polling a port chosen in advance.
        console.log("fixture server listening on " + server.port);
        `,
      );
      // Stands in for \`bunx vite\`: a process between the shell and the server.
      const launcherFile = path.join(fixture, "launcher.ts");
      writeFileSync(
        launcherFile,
        `
        const child = Bun.spawn([process.execPath, ${JSON.stringify(serverFile)}], { stdio: ["ignore", "inherit", "inherit"] });
        process.exitCode = await child.exited;
        `,
      );
      // \`&& true\` keeps the shell from exec'ing the launcher, so the shell
      // stays the group leader, as in the public-site \`bun check && ...\` chain.
      const serverCommand = `"${process.execPath}" "${launcherFile}" && true`;
      const teardownFile = path.join(fixture, "stall-teardown.ts");
      writeFileSync(
        teardownFile,
        `
        import { writeFileSync } from "node:fs";
        export default async function stallTeardown() {
          writeFileSync(${JSON.stringify(teardownStartedFile)}, "started");
          await new Promise(() => {});
        }
        `,
      );
      // Load the real config, so its SIGTERM handling is what runs. Only the
      // server, tests and output move into this fixture. The runner records
      // its exit status, which tells the two shutdown paths apart.
      const generatedConfig = path.join(fixture, "playwright.config.ts");
      const globalTeardown =
        shutdown === "exit fallback" ? JSON.stringify(teardownFile) : "undefined";
      writeFileSync(
        generatedConfig,
        `
        import { writeFileSync } from "node:fs";
        import actual from ${JSON.stringify(path.join(repository, config))};
        import { isPlaywrightRunnerProcess } from ${JSON.stringify(sigtermModule)};
        if (isPlaywrightRunnerProcess()) {
          process.on("exit", (code) => writeFileSync(${JSON.stringify(runnerExitFile)}, String(code)));
        }
        export default { ...actual, globalSetup: undefined, globalTeardown: ${globalTeardown},
          webServer: { command: ${JSON.stringify(serverCommand)},
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
      const serverPid = readNumber(serverPidFile);
      if (serverPid) servers.push(serverPid);
      const serverPgid = readNumber(serverPgidFile);

      // The run was stopped by `terminate`, after the server and spec started.
      expect(result.outputLimitExceeded, result.output).toBe(true);
      expect(existsSync(startedFile), result.output).toBe(true);
      expect(serverPid).toBeGreaterThan(0);
      // The server is a grandchild in a group the shell leads.
      expect(serverPgid).toBeGreaterThan(0);
      expect(serverPgid).not.toBe(serverPid);

      // Which path stopped the run: the runner's own exit status.
      if (shutdown === "sigint") {
        expect(readNumber(runnerExitFile), result.output).toBe(PLAYWRIGHT_INTERRUPTED_EXIT_CODE);
      } else {
        expect(existsSync(teardownStartedFile), result.output).toBe(true);
        expect(readNumber(runnerExitFile), result.output).toBe(RUNNER_SIGTERM_EXIT_CODE);
      }

      // Playwright SIGKILLs the group it created; allow the signal a moment.
      expect(await goneWithin(() => !alive(serverPid!), 3_000)).toBe(true);
      expect(await goneWithin(() => groupGone(serverPgid!), 3_000)).toBe(true);
    }, 150_000);
  }
});
