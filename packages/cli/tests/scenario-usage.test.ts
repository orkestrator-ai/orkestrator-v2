import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UsageHistoryReport, UsageTotals } from "@orkestrator/protocol/usage-history";
import { RunManifest, type IsolatedBackend } from "../scenarios/harness.js";
import { formatRunUsage, readRunUsage, summarizeUsageReport } from "../scenarios/usage.js";
import { runScenarios } from "../scripts/run-scenarios.js";
import { scenarioOptions, scenarioRuntime } from "./support/scenario-runner.js";

/**
 * A live scenario's manifest records the token usage its backend recorded
 * (to-do 0014 task 4), read through the backend's own usage report.
 */

const TOKEN = "scenario-token-0123456789abcdef";
const backend = {
  descriptor: { url: "http://127.0.0.1:40123/", authFile: "/private/auth.json" },
} as unknown as Pick<IsolatedBackend, "descriptor">;

function report(turns: number): UsageHistoryReport {
  const line: UsageTotals = {
    inputTokens: 120 * turns,
    outputTokens: 30 * turns,
    cacheReadTokens: 400 * turns,
    cacheWriteTokens: 10 * turns,
    reasoningTokens: 0,
    totalTokens: 560 * turns,
    costUsd: 0.002 * turns,
    costSource: "estimate",
    unpricedTokens: 0,
    turns,
  };
  return {
    generatedAt: "2026-11-11T00:00:00.000Z",
    fromDay: "2026-11-10",
    toDay: "2026-11-11",
    days: [],
    totals: line,
    sessions: turns > 0 ? 1 : 0,
    platforms: [],
    models:
      turns > 0 ? [{ platform: "claude", modelId: "claude-model", totals: line, sessions: 1 }] : [],
    environments: [{ environmentId: "env-1", name: "live-claude", totals: line, sessions: 1 }],
    recordedPlatforms: turns > 0 ? ["claude"] : [],
  };
}

function fakeFetch(answers: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetchImpl: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
      return answer();
    },
  };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("readRunUsage", () => {
  test("reads the backend's usage report over the gateway with its own token", async () => {
    const fetcher = fakeFetch([json({ result: report(2) })]);
    const tokenFiles: string[] = [];
    const record = await readRunUsage(backend, {
      fetchImpl: fetcher.fetchImpl,
      readToken: async (file) => {
        tokenFiles.push(file);
        return TOKEN;
      },
    });
    expect(tokenFiles).toEqual(["/private/auth.json"]);
    expect(fetcher.calls).toHaveLength(1);
    const call = fetcher.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:40123/__orkestrator/invoke");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(call.init.body))).toEqual({
      command: "get_usage_history",
      args: { days: 2 },
    });
    expect(record).toEqual({
      usage: {
        turns: 2,
        inputTokens: 240,
        outputTokens: 60,
        cacheReadTokens: 800,
        cacheWriteTokens: 20,
        reasoningTokens: 0,
        totalTokens: 1120,
        costUsd: 0.004,
        unpricedTokens: 0,
        costSource: "estimate",
        sessions: 1,
        models: [
          {
            platform: "claude",
            modelId: "claude-model",
            sessions: 1,
            turns: 2,
            inputTokens: 240,
            outputTokens: 60,
            cacheReadTokens: 800,
            cacheWriteTokens: 20,
            reasoningTokens: 0,
            totalTokens: 1120,
            costUsd: 0.004,
            unpricedTokens: 0,
            costSource: "estimate",
          },
        ],
      },
    });
    // Environment names stay out of the manifest.
    expect(JSON.stringify(record)).not.toContain("live-claude");
    expect(JSON.stringify(record)).not.toContain(TOKEN);
  });

  test("reads once more after a pause when the first read counted no turns", async () => {
    const fetcher = fakeFetch([json({ result: report(0) }), json({ result: report(1) })]);
    const sleeps: number[] = [];
    const record = await readRunUsage(backend, {
      fetchImpl: fetcher.fetchImpl,
      readToken: async () => TOKEN,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      settleMs: 250,
    });
    expect(sleeps).toEqual([250]);
    expect(fetcher.calls).toHaveLength(2);
    expect(record.usage?.turns).toBe(1);
  });

  test("a run with no recorded usage is recorded as zero, not as an error", async () => {
    const fetcher = fakeFetch([json({ result: report(0) })]);
    const record = await readRunUsage(backend, {
      fetchImpl: fetcher.fetchImpl,
      readToken: async () => TOKEN,
      sleep: async () => {},
    });
    expect(fetcher.calls).toHaveLength(2);
    expect(record.usage).toMatchObject({ turns: 0, totalTokens: 0, models: [] });
    expect(formatRunUsage(record)).toBe(
      "usage: 0 turns, 0 in, 0 out, 0 cache read, 0 cache write, 0 total, $0.0000",
    );
  });

  test("a refused, malformed or unreachable read is a readError, never a throw", async () => {
    for (const [answer, expected] of [
      [json({ error: "denied" }, 500), "usage read answered HTTP 500"],
      [() => new Response("not json"), "JSON"],
      [json({}), "usage read returned no report"],
      [
        () => {
          throw new Error("connect ECONNREFUSED");
        },
        "connect ECONNREFUSED",
      ],
    ] as const) {
      const record = await readRunUsage(backend, {
        fetchImpl: fakeFetch([answer]).fetchImpl,
        readToken: async () => TOKEN,
        sleep: async () => {},
      });
      expect(record.usage).toBeNull();
      expect("readError" in record && record.readError).toContain(expected);
    }
    const unreadable = await readRunUsage(backend, {
      fetchImpl: fakeFetch([json({ result: report(1) })]).fetchImpl,
      readToken: async () => {
        throw new Error("The credential file could not be read");
      },
    });
    expect(unreadable).toEqual({
      usage: null,
      readError: "The credential file could not be read",
    });
    expect(formatRunUsage(unreadable)).toBe(
      "usage: unavailable (The credential file could not be read)",
    );
  });

  test("the summary is bounded and drops malformed counts", () => {
    const models = Array.from({ length: 40 }, (_, index) => ({
      platform: "codex",
      modelId: `m${index}`,
      sessions: 1,
      totals: { turns: 1, inputTokens: -5, outputTokens: Number.NaN, totalTokens: "9" },
    }));
    const summary = summarizeUsageReport({
      totals: { turns: 40 } as never,
      models: models as never,
    });
    expect(summary.models).toHaveLength(32);
    expect(summary.models[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(summary.sessions).toBe(0);
  });
});

describe("runner usage record", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("a live scenario's result carries its usage, read before the backend stops", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-usage-manifest-"));
    directories.push(root);
    const manifest = new RunManifest(path.join(root, "manifest.json"));
    const runtime = scenarioRuntime();
    const order: string[] = [];
    const startBackend = runtime.dependencies.startIsolatedBackend;
    runtime.dependencies.startIsolatedBackend = async (options) => {
      const started = await startBackend(options);
      const stop = started.stop.bind(started);
      started.stop = async () => {
        order.push("stop");
        return stop();
      };
      return started;
    };
    const usage = summarizeUsageReport(report(1));
    runtime.dependencies.readRunUsage = async () => {
      order.push("usage");
      return { usage };
    };
    const exit = await runScenarios(
      [
        {
          name: "live-fixture",
          description: "fixture",
          live: true,
          async run(context) {
            context.cleanup.push({
              label: "environment",
              async run() {
                order.push("cleanup");
              },
            });
            throw new Error("turn failed");
          },
        },
        { name: "credential-free", description: "fixture", async run() {} },
      ],
      { ...scenarioOptions, provider: "claude" },
      manifest,
      "usage-run",
      runtime.dependencies,
    );
    expect(exit).toBe(1);
    // Read once, for the live scenario only, and even though it failed.
    expect(order).toEqual(["usage", "cleanup", "stop", "stop"]);
    const output = JSON.parse(await readFile(manifest.file!, "utf8"));
    expect(output.results[0]).toMatchObject({
      name: "live-fixture",
      passed: false,
      usage: { usage },
    });
    expect(output.results[1]).not.toHaveProperty("usage");
  });
});
