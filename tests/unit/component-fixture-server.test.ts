import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { FIXTURE_SERVER_ENV, fixtureServerMode } from "../../e2e/fixture-server-mode";

// The component suite builds its fixture page and serves the build, because
// the dev server's unbundled page loads were half the suite's time
// (docs/development/testing-guide.md, "The fixture server").

const root = path.resolve(import.meta.dir, "../..");
const configPath = path.join(root, "e2e/playwright.config.ts");
const { JEST_WORKER_ID: _jest, BUN_TEST_WORKER_ID: _worker, ...childEnv } = process.env;

interface WebServer {
  command: string;
  cwd: string;
  url: string;
  env?: Record<string, string>;
  reuseExistingServer: boolean;
}

/** The real config's `webServer`, loaded in a child so its TMPDIR and handlers stay there. */
function webServerFor(env: Record<string, string>): WebServer {
  const run = spawnSync(
    process.execPath,
    [
      "-e",
      `const { default: config } = await import(${JSON.stringify(configPath)});
       process.stdout.write(JSON.stringify(config.webServer));`,
    ],
    { cwd: root, env: { ...childEnv, ...env }, encoding: "utf8", timeout: 10_000 },
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as WebServer;
}

describe("fixtureServerMode", () => {
  test("builds by default and accepts the dev server on request", () => {
    expect(fixtureServerMode({})).toBe("build");
    expect(fixtureServerMode({ [FIXTURE_SERVER_ENV]: "" })).toBe("build");
    expect(fixtureServerMode({ [FIXTURE_SERVER_ENV]: "dev" })).toBe("dev");
  });

  test("refuses an unknown mode rather than guessing", () => {
    expect(() => fixtureServerMode({ [FIXTURE_SERVER_ENV]: "static" })).toThrow(
      /Unsupported ORKESTRATOR_E2E_FIXTURE_SERVER/,
    );
  });
});

describe("the component suite's fixture server", () => {
  test("a run builds the fixture in development mode and never reuses a server", () => {
    const server = webServerFor({ [FIXTURE_SERVER_ENV]: "", CI: "" });
    expect(server.command).toMatch(
      /^bunx vite build \.\.\/\.\.\/e2e\/fixture --config vite\.fixture\.config\.ts --outDir "[^"]+" --emptyOutDir && bunx vite preview /,
    );
    expect(server.command).toContain("--strictPort");
    // A dev server would serve React's development build; so must the build.
    expect(server.env).toEqual({ NODE_ENV: "development" });
    // Reusing a server could serve another checkout's build, or a stale one.
    expect(server.reuseExistingServer).toBe(false);
    // Built into the runner's private TMPDIR, never a directory runs share.
    const outDir = /--outDir "([^"]+)"/.exec(server.command)![1]!;
    expect(path.basename(path.dirname(outDir))).toStartWith("ork-test-tmp-");
  });

  test("the dev server mode is reused outside CI, as before", () => {
    const server = webServerFor({ [FIXTURE_SERVER_ENV]: "dev", CI: "" });
    expect(server.command).toStartWith(
      "bunx vite ../../e2e/fixture --config vite.fixture.config.ts --host 127.0.0.1",
    );
    expect(server.reuseExistingServer).toBe(true);
    expect(webServerFor({ [FIXTURE_SERVER_ENV]: "dev", CI: "1" }).reuseExistingServer).toBe(false);
  });

  test("component specs reach app modules through the fixture, not the dev server's /@fs/", () => {
    // Only Vite's dev server answers `/@fs/` paths. The build serves the same
    // modules through `window.__fixtureModules` (e2e/fixture/fixture-modules.ts).
    const excluded = new Set(["agent-testing", "preview", "public-site", "fixture", "fixtures"]);
    const offenders: string[] = [];
    const visit = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const file = path.join(directory, name);
        if (statSync(file).isDirectory()) {
          if (!excluded.has(name)) visit(file);
        } else if (name.endsWith(".spec.ts") && readFileSync(file, "utf8").includes("/@fs")) {
          offenders.push(path.relative(root, file));
        }
      }
    };
    visit(path.join(root, "e2e"));
    expect(offenders).toEqual([]);
  });
});
