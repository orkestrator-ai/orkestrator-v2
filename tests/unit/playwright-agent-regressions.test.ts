import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

test("Playwright settles annotation rejections promptly and sanitizes JSON after reporters finish", async () => {
  const parent = path.join(repositoryRoot, "output", "agent-testing");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "reporter-regression-"));
  const runId = path.basename(root);
  const resultsFile = path.join(root, "browser", "results.json");
  const cookie = "synthetic-reporter-cookie";
  const browserConfig = path.join(repositoryRoot, "e2e/agent-testing/playwright.browser.config.ts");
  const liveHelper = path.join(repositoryRoot, "e2e/agent-testing/web-annotations-live.ts");
  const observer = path.join(root, "observe-reporter.ts");
  try {
    // This observer runs before the sanitizer's onExit, but after the JSON
    // reporter's onEnd. Retain only a boolean proving the raw cookie existed.
    await writeFile(
      observer,
      `
      import { readFile, writeFile } from "node:fs/promises";
      export default class Observer {
        async onExit() {
          const text = await readFile(${JSON.stringify(resultsFile)}, "utf8");
          await writeFile(${JSON.stringify(path.join(root, "observed.json"))},
            JSON.stringify({ rawCookieSeen: text.includes(${JSON.stringify(`orkestrator_gateway_auth=${cookie}`)}) }));
        }
      }
    `,
    );
    await writeFile(
      path.join(root, "playwright.config.ts"),
      `
      import base from ${JSON.stringify(browserConfig)};
      export default {
        ...base,
        testDir: ${JSON.stringify(root)},
        testMatch: "regression.fixture.spec.ts",
        timeout: 10000,
        retries: 0,
        reporter: [...base.reporter.slice(0, -1), [${JSON.stringify(observer)}], ...base.reporter.slice(-1)],
      };
    `,
    );
    await writeFile(
      path.join(root, "regression.fixture.spec.ts"),
      `
      import { test, expect } from "@playwright/test";
      import { waitForLiveAnnotationRequest } from ${JSON.stringify(liveHelper)};
      for (const [name, reason] of [
        ["signed out", "sign-in required"],
        ["rejected", "provider unavailable"],
        ["missing reason", null],
      ]) {
        test(name, async ({}, testInfo) => {
          let reads = 0;
          try {
            await waitForLiveAnnotationRequest({
              agent: "codex", profile: "synthetic", testInfo,
              readRequest: async () => {
                reads++;
                return { state: "queued", blockedReason: "dispatch-rejected", stateReason: reason };
              },
            });
            throw new Error("rejection unexpectedly returned");
          } finally {
            expect(reads).toBe(1);
          }
        });
      }
      test("ready for review", async ({}, testInfo) => {
        expect(await waitForLiveAnnotationRequest({
          agent: "codex", profile: "synthetic", testInfo,
          readRequest: async () => ({ state: "awaiting-review", blockedReason: null, stateReason: null }),
        })).toBe("awaiting-review");
      });
      test("cookie-bearing error", () => {
        throw new Error("request failed; cookie: orkestrator_gateway_auth=${cookie}; theme=dark");
      });
    `,
    );
    // Bun workers look like Jest to Playwright unless these markers are removed.
    const { JEST_WORKER_ID: _jest, BUN_TEST_WORKER_ID: _worker, ...env } = process.env;
    const run = spawnSync(
      "bunx",
      ["playwright", "test", "--config", path.join(root, "playwright.config.ts")],
      {
        cwd: repositoryRoot,
        env: {
          ...env,
          ORKESTRATOR_AGENT_TEST_PROFILE: runId,
          ORKESTRATOR_AGENT_TEST_RUN_ID: runId,
        },
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1); // Three intentional failures, one skip, one pass.
    expect(JSON.parse(await readFile(path.join(root, "observed.json"), "utf8"))).toEqual({
      rawCookieSeen: true,
    });
    const text = await readFile(resultsFile, "utf8");
    expect(text).not.toContain(cookie);
    expect(text).toContain("orkestrator_gateway_auth=[REDACTED]");
    type Result = {
      status: string;
      duration: number;
      errors: Array<{ message?: string }>;
      annotations: Array<{ type: string; description?: string }>;
    };
    type Suite = {
      suites?: Suite[];
      specs?: Array<{ title: string; tests: Array<{ results: Result[] }> }>;
    };
    const report = JSON.parse(text) as { suites: Suite[]; errors: unknown[] };
    expect(report.errors).toEqual([]);
    const cases = new Map<string, Result>();
    function collect(suites: Suite[]) {
      for (const suite of suites) {
        for (const spec of suite.specs ?? []) cases.set(spec.title, spec.tests[0]!.results[0]!);
        collect(suite.suites ?? []);
      }
    }
    collect(report.suites);
    expect(cases.size).toBe(5);
    expect(cases.get("signed out")?.status).toBe("skipped");
    expect(cases.get("signed out")?.annotations).toContainEqual(
      expect.objectContaining({
        type: "skip",
        description: expect.stringContaining("no usable codex credential"),
      }),
    );
    for (const [name, reason] of [
      ["rejected", "provider unavailable"],
      ["missing reason", "no reason recorded"],
    ]) {
      const result = cases.get(name!);
      expect(result?.status).toBe("failed");
      expect(result?.duration).toBeLessThan(3_000);
      expect(result?.errors[0]?.message).toContain(
        `codex rejected the annotation request: ${reason}`,
      );
      expect(result?.annotations).toContainEqual({
        type: "live-request-state",
        description: `queued: ${reason}`,
      });
    }
    expect(cases.get("ready for review")?.status).toBe("passed");
    expect(cases.get("cookie-bearing error")?.status).toBe("failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
