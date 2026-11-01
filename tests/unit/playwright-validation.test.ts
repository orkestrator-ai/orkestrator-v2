import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const configPath = path.join(root, "e2e/playwright.config.ts");
const { JEST_WORKER_ID: _jest, BUN_TEST_WORKER_ID: _worker, ...childEnv } = process.env;

// Loading the actual config in a child avoids module-cache and env leakage.
test.each([
  { cores: 8, grant: "2", review: "1", workers: 2, retries: 1 },
  { cores: 8, grant: "8", review: "1", workers: 4, retries: 1 },
  { cores: 1, grant: "8", review: "1", workers: 1, retries: 1 },
  { cores: 8, grant: "", review: "", workers: null, retries: 0 },
  { cores: 8, grant: "0", review: "", workers: null, retries: 0 },
  { cores: 8, grant: "invalid", review: "", workers: null, retries: 0 },
])("Playwright worker cap and retry policy: %j", ({ cores, grant, review, workers, retries }) => {
  const run = spawnSync(
    process.execPath,
    [
      "-e",
      `
    import os from "node:os";
    // Keep real entries: Playwright reads cpu.model on macOS while loading.
    const cpu = os.cpus()[0];
    os.cpus = () => Array(${cores}).fill(cpu);
    const { default: config } = await import(${JSON.stringify(configPath)});
    process.stdout.write(JSON.stringify({ workers: config.workers ?? null, retries: config.retries }));
  `,
    ],
    {
      cwd: root,
      env: {
        ...childEnv,
        ORKESTRATOR_VALIDATION_GRANTED_WORKERS: grant,
        ORKESTRATOR_REVIEW_VALIDATION: review,
        // The per-package bound must never influence browser workers.
        ORKESTRATOR_TEST_WORKERS: "1",
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({ workers, retries });
});

test("line reporter exposes complete Electron diagnostics and review retry evidence", async () => {
  // Stay under the checkout so generated specs resolve @playwright/test.
  const fixture = await mkdtemp(path.join(root, "output/playwright-validation-"));
  try {
    await writeFile(
      path.join(fixture, "playwright.config.ts"),
      `
      import base from ${JSON.stringify(configPath)};
      export default { ...base, testDir: ${JSON.stringify(fixture)}, testMatch: "probe.spec.ts",
        testIgnore: [], globalSetup: undefined, webServer: undefined,
        projects: [{ name: "probe" }], workers: 1, outputDir: ${JSON.stringify(path.join(fixture, "results"))} };
    `,
    );
    await writeFile(
      path.join(fixture, "probe.spec.ts"),
      `
      import { test } from "@playwright/test";
      import { EventEmitter } from "node:events";
      import { attachElectronDiagnostics, markTestStart, recordProcessOutput }
        from ${JSON.stringify(path.join(root, "e2e/agent-testing/electron-diagnostics.ts"))};
      test("retries once", async ({}, info) => {
        if (info.retry === 0) throw new Error("retry probe");
      });
      test("diagnostic failure after startup", async ({}, info) => {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
        markTestStart(info.title);
        recordProcessOutput("electron", child);
        child.stdout.emit("data", Buffer.from("Vite banner " + "x".repeat(400) + "\\n"));
        child.stderr.emit("data", Buffer.from("latest Electron renderer failure\\n"));
        await attachElectronDiagnostics(info);
        throw new Error("intentional diagnostic failure");
      });
    `,
    );
    const run = spawnSync(
      "bunx",
      ["playwright", "test", "--config", path.join(fixture, "playwright.config.ts")],
      {
        cwd: root,
        env: { ...childEnv, ORKESTRATOR_REVIEW_VALIDATION: "1", FORCE_COLOR: "0" },
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1); // One intentional failure, one flaky retry.
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).toContain("1 flaky");
    expect(output).toContain("retry #1");
    const diagnosticPaths = output.match(/\S+electron-diagnostics-[a-f0-9]+\.txt/g) ?? [];
    expect(diagnosticPaths.length).toBeGreaterThan(0);
    const contents = await readFile(path.resolve(root, diagnosticPaths[0]!), "utf8");
    expect(contents.length).toBeGreaterThan(300);
    expect(contents).toContain("latest Electron renderer failure");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 90000);
