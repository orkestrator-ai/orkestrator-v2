import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  installStandaloneBackendLogging,
  stopStandaloneBackendLogging,
} from "./standalone-logging.js";

const temporaryDirectories: string[] = [];

async function dataDirWithDebugLogging(enabled: boolean): Promise<string> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-backend-logging-"));
  temporaryDirectories.push(dataDir);
  await writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ global: { debugLogging: enabled } }),
  );
  return dataDir;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("standalone backend logging", () => {
  test("writes console output to its own daily file when Debug logging is on", async () => {
    const dataDir = await dataDirWithDebugLogging(true);
    const logging = installStandaloneBackendLogging({ dataDir, runtimeFlavor: "production" }, {});
    expect(logging).not.toBeNull();
    try {
      console.warn("[local-server] Stopping claude:env-1 (pid 42): replacing bridge");
      await logging?.flush();
    } finally {
      await stopStandaloneBackendLogging(logging);
    }

    const files = await readdir(path.join(dataDir, "logs"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^orkestrator-backend-\d{4}-\d{2}-\d{2}\.log$/);
    const contents = await readFile(path.join(dataDir, "logs", files[0]!), "utf8");
    expect(contents).toContain("WARN [local-server] Stopping claude:env-1 (pid 42)");
  });

  test("stays off under Electron, which already records this process's output", async () => {
    const dataDir = await dataDirWithDebugLogging(true);
    expect(
      installStandaloneBackendLogging(
        { dataDir, runtimeFlavor: "production" },
        { ORKESTRATOR_DESKTOP_SUPERVISED: "1" },
      ),
    ).toBeNull();
  });

  test("stays off for isolated test profiles and when Debug logging is off", async () => {
    const enabled = await dataDirWithDebugLogging(true);
    expect(
      installStandaloneBackendLogging({ dataDir: enabled, runtimeFlavor: "agent-test" }, {}),
    ).toBeNull();
    const disabled = await dataDirWithDebugLogging(false);
    expect(
      installStandaloneBackendLogging({ dataDir: disabled, runtimeFlavor: "production" }, {}),
    ).toBeNull();
  });

  test("a stalled flush cannot hold shutdown open", async () => {
    const never = new Promise<void>(() => {});
    const started = Date.now();
    await stopStandaloneBackendLogging(
      {
        logDirectory: "/unused",
        retentionDays: 1,
        flush: () => never,
        stop: () => never,
        dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      },
      20,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
