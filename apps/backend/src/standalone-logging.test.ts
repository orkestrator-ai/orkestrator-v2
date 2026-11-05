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

    const files = (await readdir(path.join(dataDir, "logs"))).filter(
      (name) => name !== "essential",
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^orkestrator-backend-\d{4}-\d{2}-\d{2}\.log$/);
    const contents = await readFile(path.join(dataDir, "logs", files[0]!), "utf8");
    expect(contents).toContain("WARN [local-server] Stopping claude:env-1 (pid 42)");
  });

  test("stays off under Electron, which already records this process's output", async () => {
    const dataDir = await dataDirWithDebugLogging(true);
    const env: NodeJS.ProcessEnv = { ORKESTRATOR_DESKTOP_SUPERVISED: "1", PATH: "/test/bin" };
    expect(
      installStandaloneBackendLogging({ dataDir, runtimeFlavor: "production" }, env),
    ).toBeNull();
    expect(env).toEqual({ PATH: "/test/bin" });
  });

  test("stays off for isolated test profiles", async () => {
    const enabled = await dataDirWithDebugLogging(true);
    expect(
      installStandaloneBackendLogging({ dataDir: enabled, runtimeFlavor: "agent-test" }, {}),
    ).toBeNull();
  });

  test("installs with saving off, so turning it on needs no restart", async () => {
    const dataDir = await dataDirWithDebugLogging(false);
    const logging = installStandaloneBackendLogging({ dataDir, runtimeFlavor: "production" }, {});
    expect(logging).not.toBeNull();
    try {
      console.warn("before saving was on");
      logging!.updateSettings({ enabled: true, retentionDays: 7 });
      console.warn("after saving was on");
      await logging!.flush();
      const files = (await readdir(path.join(dataDir, "logs"))).filter((name) =>
        /^orkestrator-backend-\d{4}-\d{2}-\d{2}\.log$/.test(name),
      );
      expect(files).toHaveLength(1);
      const contents = await readFile(path.join(dataDir, "logs", files[0]!), "utf8");
      expect(contents).toContain("after saving was on");
      expect(contents).not.toContain("before saving was on");
    } finally {
      await logging!.stop();
    }
  });

  test("shutdown leaves every queued line in the file", async () => {
    const dataDir = await dataDirWithDebugLogging(true);
    const logging = installStandaloneBackendLogging({ dataDir, runtimeFlavor: "production" }, {});
    for (let index = 0; index < 100; index += 1) console.warn(`queued line ${index}.`);
    await stopStandaloneBackendLogging(logging, 30_000);

    const files = (await readdir(path.join(dataDir, "logs"))).filter(
      (name) => name !== "essential",
    );
    const contents = await readFile(path.join(dataDir, "logs", files[0]!), "utf8");
    for (let index = 0; index < 100; index += 1) {
      expect(contents).toContain(`queued line ${index}.`);
    }
  });

  test("a stalled flush cannot hold shutdown open", async () => {
    const never = new Promise<void>(() => {});
    const started = Date.now();
    await stopStandaloneBackendLogging(
      {
        logDirectory: "/unused",
        settings: () => ({ enabled: true, retentionDays: 1 }),
        updateSettings: () => {},
        flush: () => never,
        stop: () => never,
        dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      },
      20,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("owns the essential log, which follows no setting", async () => {
    const dataDir = await dataDirWithDebugLogging(false);
    const logging = installStandaloneBackendLogging({ dataDir, runtimeFlavor: "production" }, {});
    await stopStandaloneBackendLogging(logging);

    const lines = await readFile(
      path.join(dataDir, "logs", "essential", "essential.jsonl"),
      "utf8",
    );
    expect(lines).toContain('"event":"essential.started"');
    expect(lines).toContain('"owner":"backend"');
    expect(lines).toContain('"event":"essential.stopped"');
  });

  test("leaves the essential log to the desktop when it supervises this process", async () => {
    const dataDir = await dataDirWithDebugLogging(true);
    const logging = installStandaloneBackendLogging(
      { dataDir, runtimeFlavor: "production" },
      { ORKESTRATOR_DESKTOP_SUPERVISED: "1" },
    );
    expect(logging).toBeNull();
    await expect(readdir(path.join(dataDir, "logs"))).rejects.toThrow();
  });
});
