import { describe, expect, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const { createCommandRegistry, createTempDir, fs, path } = await createCommandFixtures();

import type { CommandContext } from "./command-fixtures";

describe("log storage commands", () => {
  function logStorageContext(logDirectory: string): CommandContext {
    return { storage: { getLogDirectory: () => logDirectory } } as unknown as CommandContext;
  }

  test("reports the size and file count of the log directory", async () => {
    const dataDir = await createTempDir("ork-log-storage-stats-");
    const logDirectory = path.join(dataDir, "logs");
    await fs.mkdir(path.join(logDirectory, "codex-raw"), { recursive: true });
    await fs.writeFile(path.join(logDirectory, "app.log"), "1234");
    await fs.writeFile(path.join(logDirectory, "codex-raw", "raw.jsonl"), "123456");
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_log_storage_stats")?.({}, logStorageContext(logDirectory)),
    ).resolves.toEqual({ totalBytes: 10, fileCount: 2, essentialBytes: 0, essentialFileCount: 0 });
  });

  test("reports zero for a log directory that was never created", async () => {
    const dataDir = await createTempDir("ork-log-storage-missing-");
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_log_storage_stats")?.({}, logStorageContext(path.join(dataDir, "logs"))),
    ).resolves.toEqual({ totalBytes: 0, fileCount: 0, essentialBytes: 0, essentialFileCount: 0 });
  });

  test("deletes every stored log and returns the emptied stats", async () => {
    const dataDir = await createTempDir("ork-log-storage-cleanup-");
    const logDirectory = path.join(dataDir, "logs");
    await fs.mkdir(path.join(logDirectory, "nested"), { recursive: true });
    await fs.writeFile(path.join(logDirectory, "app.log"), "app");
    await fs.writeFile(path.join(logDirectory, "nested", "raw.jsonl"), "raw");
    const commands = createCommandRegistry();

    await expect(
      commands.get("cleanup_logs")?.({}, logStorageContext(logDirectory)),
    ).resolves.toEqual({ totalBytes: 0, fileCount: 0, essentialBytes: 0, essentialFileCount: 0 });
    expect(await fs.readdir(logDirectory)).toEqual([]);
  });

  test("ignores arguments neither command reads", async () => {
    const dataDir = await createTempDir("ork-log-storage-args-");
    const logDirectory = path.join(dataDir, "logs");
    await fs.mkdir(logDirectory, { recursive: true });
    await fs.writeFile(path.join(logDirectory, "app.log"), "app");
    const context = logStorageContext(logDirectory);
    const commands = createCommandRegistry();

    // Both are defined commands with no arguments (plan item 7003): an unknown
    // key is dropped (§11.4), never read as a path, so only the log
    // directory is measured and cleaned.
    await expect(
      commands.get("get_log_storage_stats")?.({ path: "/etc" }, context),
    ).resolves.toMatchObject({ totalBytes: 3, fileCount: 1 });
    await expect(commands.get("cleanup_logs")?.({ path: "/etc" }, context)).resolves.toMatchObject({
      totalBytes: 0,
      fileCount: 0,
    });
    expect(await fs.readdir(logDirectory)).toEqual([]);
  });

  test("surfaces a cleanup the process is not permitted to perform", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dataDir = await createTempDir("ork-log-storage-denied-");
    const logDirectory = path.join(dataDir, "logs");
    await fs.mkdir(logDirectory, { recursive: true });
    await fs.writeFile(path.join(logDirectory, "app.log"), "app");
    await fs.chmod(logDirectory, 0o500);
    const commands = createCommandRegistry();

    try {
      await expect(
        commands.get("cleanup_logs")?.({}, logStorageContext(logDirectory)),
      ).rejects.toThrow();
    } finally {
      await fs.chmod(logDirectory, 0o700);
    }
  });
});

describe("database and diagnostics commands", () => {
  test("get_database_stats reports through the backend's diagnostics and drops arguments", () => {
    const commands = createCommandRegistry();
    const stats = { generatedAt: "now", leaseWaits: {} };
    const context = {
      diagnostics: { databaseStats: () => stats },
    } as unknown as CommandContext;
    expect(commands.get("get_database_stats")?.({}, context) as unknown).toEqual(stats);
    // A defined command drops unknown keys (plan item 7009) rather than refusing them.
    expect(commands.get("get_database_stats")?.({ path: "/etc" }, context) as unknown).toEqual(
      stats,
    );
  });

  test("get_artifact_metrics exposes the counters, and is empty without artifacts", () => {
    const commands = createCommandRegistry();
    expect(
      commands.get("get_artifact_metrics")?.({}, {} as unknown as CommandContext) as unknown,
    ).toEqual({ counters: {}, droppedSeries: 0 });
    const counters = { counters: { repairs: 2 }, droppedSeries: 0 };
    expect(
      commands.get("get_artifact_metrics")?.({}, {
        transcriptArtifacts: { metrics: { snapshot: () => counters } },
      } as unknown as CommandContext) as unknown,
    ).toEqual(counters);
  });

  test("get_progressive_read_metrics answers from the native agent service", () => {
    const commands = createCommandRegistry();
    const samples = [{ domain: "state", cacheTier: "memory", outcome: "cached", durationMs: 1 }];
    expect(
      commands.get("get_progressive_read_metrics")?.({}, {
        nativeAgents: { progressiveReadSamples: () => samples },
      } as unknown as CommandContext) as unknown,
    ).toEqual({ samples });
  });

  test("a workspace client cannot read this machine's diagnostics", async () => {
    const { grantAdmits } = await import("../src/core/nodes/workspace-grant-test-support");
    for (const command of [
      "get_database_stats",
      "plan_diagnostics_bundle",
      "read_diagnostics_bundle",
    ]) {
      expect(grantAdmits(command)).toBe(false);
    }
  });
});
