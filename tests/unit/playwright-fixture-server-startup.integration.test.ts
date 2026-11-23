import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FIXTURE_IDENTITY_HEADER,
  FIXTURE_IDENTITY_PATH,
  FIXTURE_OUT_DIR_ENV,
} from "../../e2e/fixture-server-identity";
import { FIXTURE_SERVER_ENV } from "../../e2e/fixture-server-mode";
import { freeLoopbackPort } from "../../scripts/loopback-network";
import { KEEP_PRIVATE_TMPDIR_ENV, PRIVATE_TMPDIR_ENV } from "../private-tmpdir";
import { PARENT_TMPDIR_ENV } from "../temp-sweep";

const repository = path.resolve(import.meta.dir, "../..");
const configPath = path.join(repository, "e2e/playwright.config.ts");
const setupPath = path.join(repository, "e2e/fixture-server-setup.ts");
const playwrightTest = path.join(path.dirname(require.resolve("@playwright/test")), "index.mjs");
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await close(server);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(process.env[PARENT_TMPDIR_ENV] || tmpdir(), "ork-pw-start-"));
  roots.push(root);
  return root;
}

async function run(command: string[], env = process.env) {
  const runner = Bun.spawn(command, { cwd: repository, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(runner.stdout).text(),
    new Response(runner.stderr).text(),
    runner.exited,
  ]);
  return { output: `${stdout}\n${stderr}`, exitCode };
}

const specMarker = "FIXTURE_STARTUP_SPEC_RAN";

async function runPlaywright({
  root,
  port,
  mode = "build",
  temp = root,
  webServer = "actual.webServer",
  spec = "",
}: {
  root: string;
  port: number;
  mode?: "build" | "dev";
  temp?: string;
  webServer?: string;
  spec?: string;
}) {
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    path.join(root, "playwright.config.ts"),
    `
    import actual from ${JSON.stringify(configPath)};
    export default { ...actual, globalSetup: ${JSON.stringify(setupPath)},
      webServer: ${webServer},
      testDir: ".", testMatch: "startup.spec.ts", testIgnore: [], workers: 1, retries: 0,
      outputDir: "./results", projects: [{ name: "fixture-startup" }], reporter: "line" };
    `,
  );
  writeFileSync(
    path.join(root, "startup.spec.ts"),
    `
    import { expect, test } from ${JSON.stringify(playwrightTest)};
    import { existsSync } from "node:fs";
    import path from "node:path";
    test("${specMarker}", async ({ baseURL }) => {
      ${spec}
    });
    `,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: temp,
    ORKESTRATOR_E2E_PORT: String(port),
    ORKESTRATOR_FIXTURE_TEST_DOLLAR: "expanded-by-shell",
    [FIXTURE_SERVER_ENV]: mode,
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
  ]) {
    delete env[key];
  }
  return run(
    [
      "bunx",
      "playwright",
      "test",
      "--config",
      path.join(root, "playwright.config.ts"),
      "--global-timeout=90000",
    ],
    env,
  );
}

describe.skipIf(process.platform === "win32")("component fixture startup", () => {
  test("dev mode refuses to reuse a Vite preview that serves the SPA fallback", async () => {
    const root = tempRoot();
    const dist = path.join(root, "dist");
    mkdirSync(dist);
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>Static fixture</title>");
    const port = await freeLoopbackPort();
    // Playwright starts a real preview first. The actual dev webServer then
    // sees an occupied URL and takes the reuse path.
    const result = await runPlaywright({
      root,
      port,
      mode: "dev",
      webServer: `[{
        ...actual.webServer,
        command: "bunx vite preview --config vite.fixture.config.ts --host 127.0.0.1 --port ${port} --strictPort",
        env: { ${FIXTURE_OUT_DIR_ENV}: ${JSON.stringify(dist)} },
        reuseExistingServer: false,
      }, actual.webServer]`,
    });
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain("Expected the fixture dev server for this checkout.");
    expect(result.output).not.toContain(specMarker);
  }, 120_000);

  test("a listener that binds after the build command starts cannot release any specs", async () => {
    const root = tempRoot();
    const port = await freeLoopbackPort();
    let foreignPort: number | undefined;
    const foreign = createServer((request, response) => {
      if (request.url === FIXTURE_IDENTITY_PATH) {
        response.writeHead(204, { [FIXTURE_IDENTITY_HEADER]: "build-another-run" }).end();
        return;
      }
      response.end("foreign fixture");
    });
    servers.push(foreign);
    const control = createServer(async (_request, response) => {
      try {
        foreignPort = await listen(foreign, port);
        response.end("bound");
      } catch {
        response.writeHead(500).end();
      }
    });
    servers.push(control);
    const controlPort = await listen(control);
    writeFileSync(
      path.join(root, "hold-build.ts"),
      `
      const response = await fetch("http://127.0.0.1:${controlPort}");
      if (!response.ok) throw new Error("Could not bind the foreign listener");
      setInterval(() => {}, 1000);
      `,
    );
    // Stand in for the build step so the bind always occurs after Playwright's
    // initial probe and before our preview can bind.
    const result = await runPlaywright({
      root,
      port,
      webServer: `{ ...actual.webServer,
        command: "bun hold-build.ts && " + actual.webServer.command,
        cwd: ${JSON.stringify(root)},
      }`,
    });
    expect(foreignPort, result.output).toBe(port);
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain(`Port ${port} is already in use`);
    expect(result.output).toContain("Expected the fixture preview for this run.");
    expect(result.output).not.toContain(specMarker);
  }, 120_000);

  // macOS deliberately replaces long custom temp roots with /private/tmp.
  test.skipIf(process.platform === "darwin")(
    "build and preview share the owned output directory with a literal dollar sign",
    async () => {
      const root = tempRoot();
      const temp = path.join(root, "$ORKESTRATOR_FIXTURE_TEST_DOLLAR");
      mkdirSync(temp);
      const result = await runPlaywright({
        root,
        port: await freeLoopbackPort(),
        temp,
        spec: `
        const tmp = process.env[${JSON.stringify(PRIVATE_TMPDIR_ENV)}];
        expect(tmp).toContain("$ORKESTRATOR_FIXTURE_TEST_DOLLAR");
        expect(existsSync(path.join(tmp, "component-fixture/index.html"))).toBe(true);
        const response = await fetch(baseURL);
        expect(response.ok).toBe(true);
        expect(await response.text()).toContain("Orkestrator browser fixtures");
      `,
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("1 passed");
    },
    120_000,
  );
});

const legacyRevision = "6e072c3cf";
const hasLegacyRevision =
  Bun.spawnSync(["git", "cat-file", "-e", `${legacyRevision}^{commit}`], { cwd: repository })
    .exitCode === 0;

test.skipIf(!hasLegacyRevision || process.platform === "win32")(
  "the design benchmark builds a fresh archive that predates the fixture registry",
  async () => {
    const dist = path.join(tempRoot(), "dist");
    const result = await run([
      process.execPath,
      "e2e/perf/design-canvas-perf.ts",
      "--rev",
      legacyRevision,
      "--dist",
      dist,
      "--port",
      String(await freeLoopbackPort()),
      "--skip-canvas",
      "--skip-library",
    ]);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain(`web code from ${legacyRevision}`);
    expect(await Bun.file(path.join(dist, "index.html")).exists()).toBe(true);
  },
  180_000,
);
