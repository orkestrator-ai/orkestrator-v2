import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  installProductionApplicationLogging,
  pruneExpiredApplicationLogs,
  readApplicationLogSettings,
  registerApplicationLoggingShutdown,
  type ApplicationLoggingQuitHost,
  type InstalledApplicationLogging,
} from "./application-logging";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-logging-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function enabledDataDir(retentionDays = 7): Promise<string> {
  const dataDir = await temporaryDirectory();
  await writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ global: { debugLogging: true, debugLogRetentionDays: retentionDays } }),
  );
  return dataDir;
}

async function backdate(target: string, iso: string): Promise<void> {
  await utimes(target, new Date(iso), new Date(iso));
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    // A test that made a directory read-only has to hand permissions back or
    // the cleanup itself fails.
    await chmod(directory, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

describe("production application log settings", () => {
  test("loads the enabled flag and normalized retention from config", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ global: { debugLogging: true, debugLogRetentionDays: 30 } }),
    );
    expect(readApplicationLogSettings(dataDir)).toEqual({ enabled: true, retentionDays: 30 });
  });

  test("falls back to disabled for a missing config file", async () => {
    const dataDir = await temporaryDirectory();
    expect(readApplicationLogSettings(dataDir)).toEqual({ enabled: false, retentionDays: 7 });
  });

  test("falls back to disabled for malformed JSON", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(path.join(dataDir, "config.json"), "{ not json");
    expect(readApplicationLogSettings(dataDir)).toEqual({ enabled: false, retentionDays: 7 });
  });

  test("ignores a global block that is not an object", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ global: "on" }));
    expect(readApplicationLogSettings(dataDir)).toEqual({ enabled: false, retentionDays: 7 });
  });

  test("treats a truthy non-boolean debugLogging as disabled and normalizes bad retention", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ global: { debugLogging: "yes", debugLogRetentionDays: -4 } }),
    );
    expect(readApplicationLogSettings(dataDir)).toEqual({ enabled: false, retentionDays: 7 });
  });

  test("does not install when logging is disabled", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ global: { debugLogging: false } }),
    );
    const originalLog = console.log;
    expect(installProductionApplicationLogging({ dataDir })).toBeNull();
    expect(console.log).toBe(originalLog);
    expect(await readdir(dataDir)).toEqual(["config.json"]);
  });
});

describe("production application log writing", () => {
  test("writes console output to a daily production log", async () => {
    const dataDir = await enabledDataDir(14);
    const logger = installProductionApplicationLogging({
      dataDir,
      now: () => new Date("2026-08-25T18:00:00.000Z"),
    });
    expect(logger).not.toBeNull();
    console.warn("diagnostic", { code: 42 });
    await logger?.stop();

    const contents = await readFile(
      path.join(dataDir, "logs", "orkestrator-ai-2026-08-25.log"),
      "utf8",
    );
    expect(contents).toContain("Saving logs to");
    expect(contents).toContain("WARN diagnostic { code: 42 }");
  });

  test("truncates an entry past the per-entry byte bound", async () => {
    const dataDir = await enabledDataDir();
    const logger = installProductionApplicationLogging({
      dataDir,
      now: () => new Date("2026-08-25T18:00:00.000Z"),
      bounds: { maxEntryBytes: 120 },
    });
    console.log("x".repeat(4000));
    await logger?.stop();

    const contents = await readFile(
      path.join(dataDir, "logs", "orkestrator-ai-2026-08-25.log"),
      "utf8",
    );
    expect(contents).toContain("[log entry truncated]");
    // Every line is bounded, including the installer's own banner.
    for (const line of contents.split("\n")) expect(line.length).toBeLessThanOrEqual(120);
  });

  test("announces dropped entries instead of leaving an unmarked gap", async () => {
    const dataDir = await enabledDataDir();
    const logger = installProductionApplicationLogging({
      dataDir,
      now: () => new Date("2026-08-25T18:00:00.000Z"),
      bounds: { maxPendingBytes: 300 },
    });
    // Each of these exceeds the queue bound on its own, so the drop does not
    // depend on how far the write chain has drained.
    console.log("z".repeat(500));
    console.log("z".repeat(500));
    expect(logger?.dropStats()).toEqual({ droppedEntries: 2, droppedBytes: expect.any(Number) });
    expect(logger?.dropStats().droppedBytes).toBeGreaterThan(0);

    await logger?.flush();
    console.log("kept");
    await logger?.stop();

    const contents = await readFile(
      path.join(dataDir, "logs", "orkestrator-ai-2026-08-25.log"),
      "utf8",
    );
    expect(contents).toContain("2 entries (");
    expect(contents).toContain("dropped: log queue full");
    expect(contents).toContain("kept");
    expect(logger?.dropStats()).toEqual({ droppedEntries: 0, droppedBytes: 0 });
  });

  test("reports a drop that happens in the final window on stop", async () => {
    const dataDir = await enabledDataDir();
    const logger = installProductionApplicationLogging({
      dataDir,
      now: () => new Date("2026-08-25T18:00:00.000Z"),
      bounds: { maxPendingBytes: 300 },
    });
    console.log("z".repeat(500));
    await logger?.stop();

    const contents = await readFile(
      path.join(dataDir, "logs", "orkestrator-ai-2026-08-25.log"),
      "utf8",
    );
    expect(contents).toContain("1 entry (");
    expect(contents).toContain("dropped: log queue full");
  });

  test("rolls over to a numbered file once one passes the per-file bound", async () => {
    const dataDir = await enabledDataDir();
    const logger = installProductionApplicationLogging({
      dataDir,
      now: () => new Date("2026-08-25T18:00:00.000Z"),
      bounds: { maxFileBytes: 200 },
    });
    for (let index = 0; index < 8; index += 1) console.log(`entry ${index} ${"y".repeat(60)}`);
    await logger?.stop();

    const logDirectory = path.join(dataDir, "logs");
    const files = (await readdir(logDirectory)).sort();
    expect(files.length).toBeGreaterThan(1);
    expect(files[0]).toBe("orkestrator-ai-2026-08-25.1.log");
    expect(files).toContain("orkestrator-ai-2026-08-25.log");
    for (const file of files) {
      expect((await stat(path.join(logDirectory, file))).size).toBeLessThanOrEqual(400);
    }
  });

  test("resumes at the highest existing index after a restart", async () => {
    const dataDir = await enabledDataDir();
    const logDirectory = path.join(dataDir, "logs");
    await mkdir(logDirectory, { recursive: true });
    await writeFile(path.join(logDirectory, "orkestrator-ai-2026-08-25.log"), "a".repeat(300));
    await writeFile(path.join(logDirectory, "orkestrator-ai-2026-08-25.1.log"), "b");

    const logger = installProductionApplicationLogging({
      dataDir,
      now: () => new Date("2026-08-25T18:00:00.000Z"),
      bounds: { maxFileBytes: 4096 },
    });
    console.log("after restart");
    await logger?.stop();

    // The pre-existing index-0 file is left alone; writing continues in .1.
    expect(await readFile(path.join(logDirectory, "orkestrator-ai-2026-08-25.log"), "utf8")).toBe(
      "a".repeat(300),
    );
    expect(
      await readFile(path.join(logDirectory, "orkestrator-ai-2026-08-25.1.log"), "utf8"),
    ).toContain("after restart");
  });
});

describe("production application log pruning", () => {
  test("prunes expired files recursively and keeps recent logs", async () => {
    const dataDir = await temporaryDirectory();
    const logDirectory = path.join(dataDir, "logs");
    const nested = path.join(logDirectory, "codex-raw");
    await mkdir(nested, { recursive: true });
    const expired = path.join(logDirectory, "old.log");
    const recent = path.join(nested, "recent.jsonl");
    await Promise.all([writeFile(expired, "old"), writeFile(recent, "new")]);
    await backdate(expired, "2026-08-01T00:00:00Z");
    await backdate(recent, "2026-08-24T00:00:00Z");

    await pruneExpiredApplicationLogs(logDirectory, 7, new Date("2026-08-25T00:00:00Z").getTime());

    expect(await readdir(logDirectory)).toEqual(["codex-raw"]);
    expect((await stat(recent)).size).toBe(3);
  });

  test("removes a subdirectory it empties without aborting the rest of the sweep", async () => {
    const dataDir = await temporaryDirectory();
    const logDirectory = path.join(dataDir, "logs");
    // `a-` sorts first, so the sweep reaches the emptied directory before the
    // sibling. `fs.rm` without `recursive` used to reject here with
    // ERR_FS_EISDIR, taking the sibling's expired file down with it.
    const first = path.join(logDirectory, "a-emptied");
    const second = path.join(logDirectory, "b-sibling");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const firstFile = path.join(first, "old.jsonl");
    const secondFile = path.join(second, "old.jsonl");
    await Promise.all([writeFile(firstFile, "x"), writeFile(secondFile, "y")]);
    await backdate(firstFile, "2026-08-01T00:00:00Z");
    await backdate(secondFile, "2026-08-01T00:00:00Z");

    await pruneExpiredApplicationLogs(logDirectory, 7, new Date("2026-08-25T00:00:00Z").getTime());

    expect(await readdir(logDirectory)).toEqual([]);
  });

  test("keeps the log root itself even when it is emptied", async () => {
    const dataDir = await temporaryDirectory();
    const logDirectory = path.join(dataDir, "logs");
    await mkdir(logDirectory, { recursive: true });
    const expired = path.join(logDirectory, "old.log");
    await writeFile(expired, "old");
    await backdate(expired, "2026-08-01T00:00:00Z");

    await pruneExpiredApplicationLogs(logDirectory, 7, new Date("2026-08-25T00:00:00Z").getTime());

    expect(await readdir(logDirectory)).toEqual([]);
  });

  test("treats a missing log directory as nothing to do", async () => {
    const dataDir = await temporaryDirectory();
    await pruneExpiredApplicationLogs(path.join(dataDir, "logs"), 7, Date.now());
  });

  test("does not follow symlinks out of the log directory", async () => {
    const dataDir = await temporaryDirectory();
    const logDirectory = path.join(dataDir, "logs");
    await mkdir(logDirectory, { recursive: true });
    const external = path.join(dataDir, "external.log");
    await writeFile(external, "keep");
    await backdate(external, "2026-08-01T00:00:00Z");
    await (await import("node:fs/promises")).symlink(external, path.join(logDirectory, "link.log"));

    await pruneExpiredApplicationLogs(logDirectory, 7, new Date("2026-08-25T00:00:00Z").getTime());

    expect(await readFile(external, "utf8")).toBe("keep");
    expect(await readdir(logDirectory)).toEqual(["link.log"]);
  });

  test("drops oldest files first once the directory budget is exceeded", async () => {
    const dataDir = await temporaryDirectory();
    const logDirectory = path.join(dataDir, "logs");
    await mkdir(logDirectory, { recursive: true });
    // All three are inside the retention window, so only the byte budget can
    // evict them.
    const oldest = path.join(logDirectory, "oldest.log");
    const middle = path.join(logDirectory, "middle.log");
    const newest = path.join(logDirectory, "newest.log");
    await Promise.all([
      writeFile(oldest, "a".repeat(100)),
      writeFile(middle, "b".repeat(100)),
      writeFile(newest, "c".repeat(100)),
    ]);
    await backdate(oldest, "2026-08-24T01:00:00Z");
    await backdate(middle, "2026-08-24T02:00:00Z");
    await backdate(newest, "2026-08-24T03:00:00Z");

    await pruneExpiredApplicationLogs(logDirectory, 7, new Date("2026-08-25T00:00:00Z").getTime(), {
      maxDirectoryBytes: 150,
    });

    expect((await readdir(logDirectory)).sort()).toEqual(["newest.log"]);
  });

  test("reports failures it could not act on after visiting every entry", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dataDir = await temporaryDirectory();
    const logDirectory = path.join(dataDir, "logs");
    const locked = path.join(logDirectory, "locked");
    await mkdir(locked, { recursive: true });
    const lockedFile = path.join(locked, "old.log");
    const sweepable = path.join(logDirectory, "z-sweepable.log");
    await Promise.all([writeFile(lockedFile, "old"), writeFile(sweepable, "old")]);
    await backdate(lockedFile, "2026-08-01T00:00:00Z");
    await backdate(sweepable, "2026-08-01T00:00:00Z");
    await chmod(locked, 0o500);

    try {
      await expect(
        pruneExpiredApplicationLogs(logDirectory, 7, new Date("2026-08-25T00:00:00Z").getTime()),
      ).rejects.toThrow(/Failed to prune/);
      // The point of the aggregate: the sibling was still swept.
      expect(await readdir(logDirectory)).toEqual(["locked"]);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  test("sweeps again on the cleanup interval and survives a prune failure", async () => {
    const dataDir = await enabledDataDir();
    const logDirectory = path.join(dataDir, "logs");
    await mkdir(logDirectory, { recursive: true });
    const stale = path.join(logDirectory, "stale.log");
    await writeFile(stale, "stale");
    await backdate(stale, "2000-01-01T00:00:00Z");

    const logger = installProductionApplicationLogging({ dataDir, cleanupIntervalMs: 5 });
    try {
      await Bun.sleep(60);
      expect(await readdir(logDirectory)).not.toContain("stale.log");
      // Removing the directory out from under the timer must not produce an
      // unhandled rejection or stop later sweeps.
      await rm(logDirectory, { recursive: true, force: true });
      await Bun.sleep(30);
    } finally {
      await logger?.stop();
    }
  });
});

describe("application logging shutdown", () => {
  function fakeApp(): {
    host: ApplicationLoggingQuitHost;
    emit: () => void;
    preventedCount: number;
    quitCount: number;
  } {
    const state = { preventedCount: 0, quitCount: 0 };
    let listener: ((event: { preventDefault(): void }) => void) | null = null;
    const host: ApplicationLoggingQuitHost = {
      on(_event, next) {
        listener = next;
        return host;
      },
      quit() {
        state.quitCount += 1;
      },
    };
    return {
      host,
      emit: () => listener?.({ preventDefault: () => (state.preventedCount += 1) }),
      get preventedCount() {
        return state.preventedCount;
      },
      get quitCount() {
        return state.quitCount;
      },
    };
  }

  test("holds the quit open until the flush completes, then quits once", async () => {
    const app = fakeApp();
    let released: (() => void) | null = null;
    let stopCalls = 0;
    const logging = {
      logDirectory: "/tmp/logs",
      retentionDays: 7,
      flush: async () => {},
      dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      stop: () => {
        stopCalls += 1;
        return new Promise<void>((resolve) => (released = resolve));
      },
    } satisfies InstalledApplicationLogging;

    registerApplicationLoggingShutdown(app.host, logging, 5_000);
    app.emit();
    expect(app.preventedCount).toBe(1);
    await Bun.sleep(5);
    expect(app.quitCount).toBe(0);

    released?.();
    await Bun.sleep(5);
    expect(app.quitCount).toBe(1);

    // The re-entrant will-quit that our own `app.quit()` triggers must fall
    // straight through rather than parking the app again.
    app.emit();
    expect(app.preventedCount).toBe(1);
    expect(stopCalls).toBe(1);
  });

  test("quits anyway when the flush outlives its deadline", async () => {
    const app = fakeApp();
    const logging = {
      logDirectory: "/tmp/logs",
      retentionDays: 7,
      flush: async () => {},
      dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      stop: () => new Promise<void>(() => {}),
    } satisfies InstalledApplicationLogging;

    registerApplicationLoggingShutdown(app.host, logging, 10);
    app.emit();
    await Bun.sleep(60);
    expect(app.quitCount).toBe(1);
  });

  test("quits anyway when the flush rejects", async () => {
    const app = fakeApp();
    const logging = {
      logDirectory: "/tmp/logs",
      retentionDays: 7,
      flush: async () => {},
      dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      stop: () => Promise.reject(new Error("disk gone")),
    } satisfies InstalledApplicationLogging;

    registerApplicationLoggingShutdown(app.host, logging, 5_000);
    app.emit();
    await Bun.sleep(10);
    expect(app.quitCount).toBe(1);
  });

  test("registers nothing when logging was not installed", () => {
    const app = fakeApp();
    registerApplicationLoggingShutdown(app.host, null);
    app.emit();
    expect(app.preventedCount).toBe(0);
    expect(app.quitCount).toBe(0);
  });
});
