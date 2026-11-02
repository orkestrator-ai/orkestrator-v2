import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { benchmarkTeardown, cleanupBenchmarkResources } from "./container-benchmark-teardown";

test("report failure still removes owned Docker resources and temporary data", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bench-teardown-"));
  const calls: string[][] = [];
  const docker = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "ps") return "runtime\ngateway";
    if (args[1] === "ls") return args[0] === "volume" ? "volume" : "network";
    return "";
  };
  const failure = new Error("disk full");
  try {
    await expect(
      benchmarkTeardown(
        async () => {
          throw failure;
        },
        () => cleanupBenchmarkResources(docker, "test-owner", dataDir),
      ),
    ).rejects.toBe(failure);
    expect(calls).toEqual([
      ["ps", "-aq", "--filter", "label=orkestrator-owner=test-owner"],
      ["rm", "-f", "runtime", "gateway"],
      ["volume", "ls", "-q", "--filter", "label=orkestrator-owner=test-owner"],
      ["volume", "rm", "volume"],
      ["network", "ls", "-q", "--filter", "label=orkestrator-owner=test-owner"],
      ["network", "rm", "network"],
    ]);
    expect(await fs.stat(dataDir).catch(() => null)).toBeNull();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("report and cleanup failures both survive", async () => {
  const report = new Error("report");
  const cleanup = new Error("cleanup");
  try {
    await benchmarkTeardown(
      async () => {
        throw report;
      },
      async () => {
        throw cleanup;
      },
    );
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([report, cleanup]);
  }
});
