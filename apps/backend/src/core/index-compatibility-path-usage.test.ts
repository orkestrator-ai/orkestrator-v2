import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import {
  compatibilityPathUsage,
  COMPATIBILITY_PATH_USAGE_STORE,
  type CompatibilityPathUsageSnapshot,
} from "./compatibility-path-usage.js";
import { openBackendDatabase } from "./storage-stores.js";

test("backend lifecycle persists compatibility counts, detaches on shutdown, and reads them after restart", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-compatibility-"));
  const createBackend = () =>
    new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: {
        start: async () => undefined,
        stop: async () => undefined,
        connection: () => ({ url: "http://127.0.0.1:43210/mcp", token: "test-token" }),
        revokeEnvironment: () => undefined,
      },
      startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
    });
  const first = createBackend();
  let second: OrkestratorBackend | undefined;
  try {
    await first.init();
    expect(first.hasCommand("get_compatibility_path_usage")).toBe(true);
    // A defined command drops unknown keys (plan item 7009) rather than refusing them.
    await expect(
      first.invoke("get_compatibility_path_usage", { unexpected: true }),
    ).resolves.toMatchObject({ version: 1 });
    const before = await first.invoke<CompatibilityPathUsageSnapshot>(
      "get_compatibility_path_usage",
    );
    const prior = before.paths["preview.legacy-loopback-route"]?.count ?? 0;
    compatibilityPathUsage.record("preview.legacy-loopback-route");
    // No snapshot: shutdown itself must persist the pending use.
    await first.shutdown();
    const database = openBackendDatabase(dataDir);
    try {
      expect(
        (
          database.readStore(COMPATIBILITY_PATH_USAGE_STORE)!
            .value as CompatibilityPathUsageSnapshot
        ).paths["preview.legacy-loopback-route"]?.count,
      ).toBe(prior + 1);
      compatibilityPathUsage.record("preview.legacy-loopback-route");
      expect(compatibilityPathUsage.snapshot().paths["preview.legacy-loopback-route"]?.count).toBe(
        1,
      );
      // Recording after shutdown must stay in memory, not reopen the database.
      expect(
        (
          database.readStore(COMPATIBILITY_PATH_USAGE_STORE)!
            .value as CompatibilityPathUsageSnapshot
        ).paths["preview.legacy-loopback-route"]?.count,
      ).toBe(prior + 1);
    } finally {
      database.close();
    }
    second = createBackend();
    await second.init();
    const restarted = await second.invoke<CompatibilityPathUsageSnapshot>(
      "get_compatibility_path_usage",
    );
    expect(restarted.paths["preview.legacy-loopback-route"]?.count).toBe(prior + 2);
    expect(Object.keys(restarted.paths["preview.legacy-loopback-route"]!).sort()).toEqual([
      "count",
      "firstSeenAt",
      "lastSeenAt",
    ]);
  } finally {
    await first.shutdown();
    await second?.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
