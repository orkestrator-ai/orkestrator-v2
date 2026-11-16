import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { KEEP_PRIVATE_TMPDIR_ENV, PRIVATE_TMPDIR_ENV } from "../private-tmpdir";
import { FIXTURE_SERVER_PROBE_INTERVAL_ENV } from "../playwright-fixture-server-watch";
import { PARENT_TMPDIR_ENV } from "../temp-sweep";

// From to-do 8200 (retired 2026-11-16): Playwright watches its `webServer`
// only while it starts, so a component suite run whose fixture server exited
// partway carried on, failing every later case against the dead port. This
// runs the component suite's real config and its real global setup
// (e2e/fixture-server-setup.ts) through a real Playwright runner. Only the
// server and the specs are stand-ins. The server is this test process's own,
// bound to port 0 and held until it goes, so no other process can take the
// port first; the run reuses it, as a person's run outside CI reuses a
// running Vite. It answers everything, as Vite does for the setup's ownership
// check, and closes once the first spec asks it to. Each later spec takes two
// seconds and then needs the server, as a page load would. Without the watch the run would take about a minute and fail
// every one of them; with it the runner stops itself within a few probes,
// says why, and leaves the rest "did not run".

const repository = path.resolve(import.meta.dir, "../..");
const componentConfig = path.join(repository, "e2e/playwright.config.ts");
const globalSetup = path.join(repository, "e2e/fixture-server-setup.ts");
const playwrightTest = path.join(path.dirname(require.resolve("@playwright/test")), "index.mjs");
/** Playwright's exit status for an interrupted run, what Ctrl+C gives. */
const PLAYWRIGHT_INTERRUPTED_EXIT_CODE = 130;
/** Short, so the test finishes quickly; the default is ten seconds. */
const PROBE_INTERVAL_MS = 200;
const SLOW_SPECS = 30;
const SLOW_SPEC_MS = 2_000;

const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The stand-in fixture server; resolves with its URL once it is listening. */
async function startFixtureServer(onExit: () => void): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== "/__exit") {
      response.end("ok");
      return;
    }
    // Gone the way the run on omarchy-hp saw it: no line, no warning.
    response.end("ok", () => {
      server.close();
      server.closeAllConnections();
      onExit();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe.skipIf(process.platform === "win32")("the component suite's fixture server", () => {
  test("a real Node probe times out without interrupting and recovers on the next tick", async () => {
    // A separate Node process avoids the Bun suite's happy-dom fetch/AbortSignal
    // replacements and uses the same runtime as Playwright's runner.
    const script = `
      import assert from "node:assert/strict";
      import { createServer } from "node:http";
      import { probeFixtureServer, watchFixtureServer } from ${JSON.stringify(path.join(repository, "tests/playwright-fixture-server-watch.ts"))};
      let answer = false;
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        if (answer) response.end("ok");
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const url = "http://127.0.0.1:" + server.address().port;
      let tick;
      let pending;
      let signals = 0;
      let result;
      let mode = "refused";
      const watch = watchFixtureServer({
        url, intervalMs: 100,
        setInterval(callback) { tick = callback; return 1; },
        clearInterval() {},
        target: { pid: ${fakePid(2)}, listenerCount: () => 1, kill() { signals++; } },
        log() {},
        probe(url, timeout) {
          pending = (async () => {
            result = mode === "refused"
              ? { outcome: "refused", detail: "ECONNREFUSED" }
              : await probeFixtureServer(url, timeout);
            return result;
          })();
          return pending;
        }
      });
      async function step() { tick(); await pending; await Promise.resolve(); }
      try {
        await step(); await step();
        mode = "network";
        const started = Date.now();
        await step();
        assert.equal(requests, 1, "server must accept the hanging request");
        assert.deepEqual(result, { outcome: "inconclusive" });
        assert.ok(Date.now() - started < 3000, "probe must finish within its deadline budget");
        assert.equal(signals, 0);
        assert.equal(watch.stopReason, undefined);
        answer = true;
        await step();
        assert.deepEqual(result, { outcome: "up" });
        assert.equal(requests, 2, "the next tick must issue another request");
        mode = "refused";
        await step(); await step();
        assert.equal(signals, 0, "successful recovery must clear the earlier refusals");
        assert.equal(watch.stopReason, undefined);
      } finally {
        watch.stop();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `;
    const runner = Bun.spawn(["node", "--input-type=module", "--eval", script], {
      cwd: repository,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 8_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(runner.stdout).text(),
      new Response(runner.stderr).text(),
      runner.exited,
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  }, 15_000);

  test("a run whose fixture server exits stops within a few probes and says why", async () => {
    // The real config names the setup this test loads by absolute path. Read
    // as text: importing the config here would install its runner-only
    // SIGTERM handler and private TMPDIR in this test process.
    expect(readFileSync(componentConfig, "utf8")).toContain(
      `globalSetup: "./${path.basename(globalSetup)}"`,
    );

    const parent = process.env[PARENT_TMPDIR_ENV] || tmpdir();
    const root = mkdtempSync(path.join(parent, "ork-pw-fixture-exit-"));
    roots.push(root);
    const fixture = path.join(root, "fixture");
    mkdirSync(fixture);
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    let serverExitedAt: number | undefined;
    const baseURL = await startFixtureServer(() => (serverExitedAt = Date.now()));
    writeFileSync(
      path.join(fixture, "exit.spec.ts"),
      `
      import { expect, test } from ${JSON.stringify(playwrightTest)};
      test("asks the fixture server to exit", async ({ baseURL }) => {
        expect((await fetch(baseURL + "/__exit")).ok).toBe(true);
      });
      `,
    );
    writeFileSync(
      path.join(fixture, "slow.spec.ts"),
      `
      import { expect, test } from ${JSON.stringify(playwrightTest)};
      for (let index = 0; index < ${SLOW_SPECS}; index += 1) {
        test("needs the fixture server " + index, async ({ baseURL }) => {
          await new Promise((resolve) => setTimeout(resolve, ${SLOW_SPEC_MS}));
          expect((await fetch(baseURL)).ok).toBe(true);
        });
      }
      `,
    );
    // Load the real config, so its global setup, SIGTERM handling and
    // private TMPDIR are what run. Only the server, specs and output move
    // into this fixture; one worker keeps the order of the specs fixed. The
    // server is already up, so Playwright reuses it and never runs the
    // command, which fails loudly should it ever be run.
    const generatedConfig = path.join(fixture, "playwright.config.ts");
    writeFileSync(
      generatedConfig,
      `
      import actual from ${JSON.stringify(componentConfig)};
      export default { ...actual, globalSetup: ${JSON.stringify(globalSetup)},
        webServer: { command: "exit 1", url: ${JSON.stringify(baseURL)},
          reuseExistingServer: true, timeout: 60_000 },
        use: { ...actual.use, baseURL: ${JSON.stringify(baseURL)} },
        testDir: ${JSON.stringify(fixture)}, testMatch: "*.spec.ts", testIgnore: [], workers: 1,
        retries: 0, outputDir: ${JSON.stringify(path.join(root, "results"))},
        projects: [{ name: "fixture-exit" }], reporter: "line" };
      `,
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: root,
      [FIXTURE_SERVER_PROBE_INTERVAL_ENV]: String(PROBE_INTERVAL_MS),
    };
    for (const key of [
      PRIVATE_TMPDIR_ENV,
      PARENT_TMPDIR_ENV,
      KEEP_PRIVATE_TMPDIR_ENV,
      "JEST_WORKER_ID",
      "BUN_TEST_WORKER_ID",
      "TEST_WORKER_INDEX",
      "CI",
      "ORKESTRATOR_REVIEW_VALIDATION",
      "ORKESTRATOR_VALIDATION_GRANTED_WORKERS",
    ])
      delete env[key];

    const runner = Bun.spawn(["bunx", "playwright", "test", "--config", generatedConfig], {
      cwd: repository,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(runner.stdout).text(),
      new Response(runner.stderr).text(),
      runner.exited,
    ]);
    const finishedAt = Date.now();
    const output = `${stdout}\n${stderr}`;

    // The server came up, passed the ownership check, and then exited.
    expect(serverExitedAt, output).toBeGreaterThan(0);
    // The run ended as an interrupted one, not by running out of cases...
    expect(exitCode, output).toBe(PLAYWRIGHT_INTERRUPTED_EXIT_CODE);
    // ...well before the minute the remaining cases would have taken...
    expect(finishedAt - serverExitedAt!, output).toBeLessThan((SLOW_SPECS * SLOW_SPEC_MS) / 2);
    // ...naming the server and why the run stopped...
    expect(output).toContain(`The fixture server at ${baseURL} stopped answering`);
    expect(output).toContain("net::ERR_CONNECTION_REFUSED");
    // ...with the cases it never reached reported as such.
    const didNotRun = /(\d+) did not run/.exec(output);
    expect(didNotRun, output).not.toBeNull();
    expect(Number(didNotRun![1])).toBeGreaterThan(SLOW_SPECS / 2);
  }, 120_000);
});
