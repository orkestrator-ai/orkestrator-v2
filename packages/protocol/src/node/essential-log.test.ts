import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";

import {
  configureLogger,
  createLogger,
  formatLogError,
  parseLogRecordLine,
  resetLogger,
  type LogLevel,
  type LogRecord,
} from "../logger.js";
import { captureLogs } from "../testing/log-capture.js";
import { configureBridgeLogger } from "./logger-environment.js";
import {
  installProductionApplicationLogging,
  pruneExpiredApplicationLogs,
} from "./application-logging.js";
import {
  DEFAULT_ESSENTIAL_LOG_BOUNDS,
  installEssentialLog,
  type InstalledEssentialLog,
} from "./essential-log.js";

const temporaryDirectories: string[] = [];
const installed: InstalledEssentialLog[] = [];

async function dataDir(config?: { debugLogging: boolean }): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-essential-log-"));
  temporaryDirectories.push(directory);
  if (config) {
    await writeFile(path.join(directory, "config.json"), JSON.stringify({ global: config }));
  }
  return directory;
}

function install(options: Parameters<typeof installEssentialLog>[0]): InstalledEssentialLog {
  const log = installEssentialLog({ ...options });
  installed.push(log);
  return log;
}

async function entries(directory: string, file = "essential.jsonl"): Promise<LogRecord[]> {
  const text = await readFile(path.join(directory, "logs", "essential", file), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record = parseLogRecordLine(line);
      if (!record) throw new Error(`not a record: ${line}`);
      return record;
    });
}

const events = (records: LogRecord[]) => records.map((record) => record.event);

async function totalBytes(directory: string): Promise<number> {
  const root = path.join(directory, "logs", "essential");
  const names = await readdir(root);
  const sizes = await Promise.all(names.map((name) => stat(path.join(root, name))));
  return sizes.reduce((sum, file) => sum + file.size, 0);
}

afterEach(async () => {
  for (const log of installed.splice(0)) await log.stop().catch(() => undefined);
  resetLogger();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("what is written", () => {
  test("with saving off an essential event and an error go to the file, and no saved log appears", async () => {
    const directory = await dataDir({ debugLogging: false });
    const capture = captureLogs();
    const saved = installProductionApplicationLogging({ dataDir: directory });
    const essential = install({ dataDir: directory, owner: "desktop" });
    createLogger("docker").warn("writer-lease.lost", { reason: "reclaimed" });
    createLogger("docker").error("login-keeper.pass-failed");
    createLogger("docker").warn("login-keeper.refresh-failed");
    await essential.flush();
    await saved.stop();
    capture.restore();

    expect(events(await entries(directory))).toEqual([
      "essential.started",
      "writer-lease.lost",
      "login-keeper.pass-failed",
    ]);
    expect(await readdir(path.join(directory, "logs"))).toEqual(["essential"]);
  });

  test("with saving on they go to both, and the saved log is unchanged", async () => {
    const directory = await dataDir({ debugLogging: true });
    configureLogger({ sink: ({ method, line }) => console[method](line) });
    const saved = installProductionApplicationLogging({ dataDir: directory });
    const essential = install({ dataDir: directory, owner: "backend" });
    createLogger("docker").warn("writer-lease.lost", { reason: "reclaimed" });
    createLogger("docker").warn("login-keeper.refresh-failed");
    await essential.flush();
    await saved.flush();
    await saved.stop();

    expect(events(await entries(directory))).toEqual(["essential.started", "writer-lease.lost"]);
    const logs = await readdir(path.join(directory, "logs"));
    const savedFile = logs.find((name) => name !== "essential")!;
    const text = await readFile(path.join(directory, "logs", savedFile), "utf8");
    expect(text).toContain("WARN [docker] writer-lease.lost reason=reclaimed");
    expect(text).toContain("WARN [docker] login-keeper.refresh-failed");
  });

  test("switching saving live changes only the saved log", async () => {
    const directory = await dataDir({ debugLogging: false });
    configureLogger({ sink: ({ method, line }) => console[method](line) });
    const saved = installProductionApplicationLogging({ dataDir: directory });
    const essential = install({ dataDir: directory, owner: "desktop" });
    const log = createLogger("docker");
    log.warn("writer-lease.lost", { reason: "reclaimed" });
    saved.updateSettings({ enabled: true, retentionDays: 7 });
    log.warn("writer-lease.lost", { reason: "unreadable" });
    saved.updateSettings({ enabled: false, retentionDays: 7 });
    log.warn("writer-lease.lost", { reason: "reclaimed" });
    await essential.flush();
    await saved.stop();

    const reasons = (await entries(directory))
      .filter((record) => record.event === "writer-lease.lost")
      .map((record) => record.fields?.reason);
    expect(reasons).toEqual(["reclaimed", "unreadable", "reclaimed"]);
    const logs = await readdir(path.join(directory, "logs"));
    const text = await readFile(
      path.join(
        directory,
        "logs",
        logs.find((name) => name !== "essential")!,
      ),
      "utf8",
    );
    expect(text).toContain("reason=unreadable");
    expect(text).not.toContain("reason=reclaimed");
  });

  test("an error's message never reaches the file, however it is attached", async () => {
    const directory = await dataDir();
    const capture = captureLogs();
    const essential = install({ dataDir: directory, owner: "desktop" });
    const secret = "/Users/someone/repo prompt text";
    createLogger("desktop").error("startup.failed", { error: formatLogError(new Error(secret)) });
    createLogger("storage").warn("snapshot.failed", {
      retryAt: null,
      error: formatLogError(new Error(secret)),
    });
    await essential.flush();
    capture.restore();

    const text = await readFile(path.join(essential.directory, "essential.jsonl"), "utf8");
    expect(text).not.toContain("someone");
    expect(text).not.toContain("prompt");
    expect(text).not.toContain("message");
    expect(text).toContain('"error.name":"Error"');
  });

  test("a stop and a start bracket a run, so a start with no stop means the writer died", async () => {
    const directory = await dataDir();
    const first = installEssentialLog({ dataDir: directory, owner: "desktop" });
    await first.stop();
    const second = install({ dataDir: directory, owner: "desktop" });
    await second.flush();
    expect(
      (await entries(directory)).map((record) => [record.event, record.fields?.owner]),
    ).toEqual([
      ["essential.started", "desktop"],
      ["essential.stopped", "desktop"],
      ["essential.started", "desktop"],
    ]);
  });
});

describe("how a process comes to relay", () => {
  test("a bridge whose output is read as records sends a filtered entry on, marked", () => {
    const capture = captureLogs();
    configureBridgeLogger({ ORKESTRATOR_BRIDGE_LOG_RELAY: "1", ORKESTRATOR_LOG_LEVEL: "error" });
    createLogger("bridge.pi").warn("session.resume-fell-back");
    capture.restore();
    expect(parseLogRecordLine(capture.lines[0]!)?.essentialOnly).toBe(true);
  });

  test("a container bridge, whose output nobody reads as records, sends nothing extra", () => {
    const capture = captureLogs();
    configureBridgeLogger({ ORKESTRATOR_LOG_LEVEL: "error" });
    createLogger("bridge.pi").warn("session.resume-fell-back");
    capture.restore();
    expect(capture.lines).toEqual([]);
  });
});

describe("the curated events", () => {
  const EVENT_ERROR = () => formatLogError(new Error("/secret/path"), { message: false });
  const CASES: Array<{
    area: Parameters<typeof createLogger>[0];
    event: string;
    level: LogLevel;
    fields: Record<string, never> | Record<string, unknown>;
    kept: Record<string, unknown>;
  }> = [
    {
      area: "backend",
      event: "starting",
      level: "info",
      fields: { version: "1.2.3" },
      kept: { version: "1.2.3" },
    },
    {
      area: "backend",
      event: "shutdown.signal-received",
      level: "info",
      fields: { signal: "SIGTERM" },
      kept: { signal: "SIGTERM" },
    },
    {
      area: "backend",
      event: "shutdown.finished",
      level: "info",
      fields: { code: 0 },
      kept: { code: 0 },
    },
    {
      area: "desktop",
      event: "backend.exited",
      level: "error",
      fields: {
        error: formatLogError(Object.assign(new Error("x"), { exitCode: 1, signal: "SIGKILL" }), {
          stack: false,
        }),
      },
      kept: { "error.name": "Error", "error.exitCode": 1, "error.signal": "SIGKILL" },
    },
    {
      area: "desktop",
      event: "backend.exited-recovering",
      level: "error",
      fields: { error: EVENT_ERROR() },
      kept: { "error.name": "Error" },
    },
    {
      area: "desktop",
      event: "backend.start-failed",
      level: "error",
      fields: { error: EVENT_ERROR() },
      kept: { "error.name": "Error" },
    },
    {
      area: "desktop",
      event: "main-thread.stalled",
      level: "error",
      fields: { lagMs: 12_000, endedAt: "2026", intervalMs: 500, openDialog: "picker" },
      kept: { lagMs: 12_000, intervalMs: 500 },
    },
    {
      area: "desktop",
      event: "uncaught-exception",
      level: "error",
      fields: { error: EVENT_ERROR() },
      kept: { "error.name": "Error" },
    },
    {
      area: "event-loop",
      event: "stalled",
      level: "error",
      fields: { lagMs: 15_000, endedAt: "2026", intervalMs: 500, folded: "some text" },
      kept: { lagMs: 15_000, intervalMs: 500 },
    },
    {
      area: "local-server",
      event: "bridge.started",
      level: "info",
      fields: { key: "codex:6e0a6a7e-1111-4e95-817f-084f44d18e8f", pid: 42 },
      kept: { key: "codex:6e0a6a7e-1111-4e95-817f-084f44d18e8f", pid: 42 },
    },
    {
      area: "local-server",
      event: "bridge.exited",
      level: "warn",
      fields: {
        key: "codex:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
        pid: 42,
        code: 1,
        signal: null,
        requested: false,
      },
      kept: {
        key: "codex:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
        pid: 42,
        code: 1,
        signal: null,
        requested: false,
      },
    },
    {
      area: "docker",
      event: "writer-lease.lost",
      level: "warn",
      fields: { reason: "reclaimed" },
      kept: { reason: "reclaimed" },
    },
    {
      area: "docker",
      event: "writer-lease.regained",
      level: "info",
      fields: { staleForMs: 45_000 },
      kept: { staleForMs: 45_000 },
    },
    {
      area: "docker",
      event: "writer-lease.not-acquired",
      level: "info",
      fields: { reason: "busy" },
      kept: { reason: "busy" },
    },
    {
      area: "docker",
      event: "bridge.launched",
      level: "info",
      fields: { provider: "claude", containerPort: 4096 },
      kept: { provider: "claude", containerPort: 4096 },
    },
    {
      area: "bridge.pi",
      event: "session.resume-fell-back",
      level: "warn",
      fields: { sessionId: "session-1", error: EVENT_ERROR() },
      kept: { "error.name": "Error" },
    },
    {
      area: "bridge.cursor",
      event: "session.resume-fell-back",
      level: "warn",
      fields: { sessionId: "session-1", error: EVENT_ERROR() },
      kept: { "error.name": "Error" },
    },
    {
      area: "storage",
      event: "migration.failed",
      level: "error",
      fields: { fromVersion: 3, toVersion: 4, step: "migrate", error: EVENT_ERROR() },
      kept: { fromVersion: 3, toVersion: 4, step: "migrate", "error.name": "Error" },
    },
    { area: "storage", event: "snapshot.integrity-failed", level: "warn", fields: {}, kept: {} },
    {
      area: "storage",
      event: "snapshot.failed",
      level: "warn",
      fields: { retryAt: "2026-11-04T10:00:00.000Z", error: EVENT_ERROR() },
      kept: { retryAt: "2026-11-04T10:00:00.000Z", "error.name": "Error" },
    },
    {
      area: "process",
      event: "rejection.unhandled",
      level: "error",
      fields: { error: EVENT_ERROR() },
      kept: { "error.name": "Error" },
    },
    {
      area: "process",
      event: "uncaught-exception",
      level: "error",
      fields: { origin: "uncaughtException", error: EVENT_ERROR() },
      kept: { origin: "uncaughtException", "error.name": "Error" },
    },
  ];

  test.each(CASES)(
    "$area $event reaches the file with only its declared fields, at any level setting",
    async ({ area, event, level, fields, kept }) => {
      const directory = await dataDir();
      const capture = captureLogs();
      const essential = install({ dataDir: directory, owner: "desktop" });
      // `error` is the strictest setting, and no level is below an `error` entry.
      configureLogger({ level: "error", areaLevels: { [area]: "error" } });
      const log = createLogger(area) as unknown as Record<
        LogLevel,
        (name: string, values: unknown) => void
      >;
      log[level](event, fields);
      await essential.flush();
      capture.restore();

      const written = (await entries(directory)).at(-1)!;
      expect(written.event).toBe(event);
      expect(written.area).toBe(area);
      expect(written.fields ?? {}).toEqual(kept as never);
    },
  );
});

describe("bounds", () => {
  test("the production cap is 4 MiB across 4 files", () => {
    const { maxFileBytes, rotatedFiles } = DEFAULT_ESSENTIAL_LOG_BOUNDS;
    expect(maxFileBytes * (rotatedFiles + 1)).toBe(4 * 1024 * 1024);
  });

  test("rotation holds the total under the hard cap and keeps the newest entries", async () => {
    const directory = await dataDir();
    const capture = captureLogs();
    const maxFileBytes = 2_048;
    const rotatedFiles = 2;
    const essential = install({
      dataDir: directory,
      owner: "desktop",
      bounds: { maxFileBytes, rotatedFiles, eventBurst: 10_000 },
    });
    const log = createLogger("backend");
    for (let index = 0; index < 400; index += 1) {
      log.info("shutdown.finished", { code: index });
    }
    await essential.flush();
    capture.restore();

    expect(await totalBytes(directory)).toBeLessThanOrEqual(maxFileBytes * (rotatedFiles + 1));
    expect((await readdir(essential.directory)).sort()).toEqual([
      "essential.1.jsonl",
      "essential.2.jsonl",
      "essential.jsonl",
    ]);
    const newest = await entries(directory);
    expect(newest.at(-1)?.fields?.code).toBe(399);
  });

  test("every file is mode 0600, rotated or not", async () => {
    const directory = await dataDir();
    const capture = captureLogs();
    const essential = install({
      dataDir: directory,
      owner: "desktop",
      bounds: { maxFileBytes: 512, eventBurst: 10_000 },
    });
    for (let index = 0; index < 20; index += 1) {
      createLogger("backend").info("shutdown.finished", { code: index });
    }
    await essential.flush();
    capture.restore();

    const names = await readdir(essential.directory);
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      const metadata = await stat(path.join(essential.directory, name));
      expect(metadata.mode & 0o777).toBe(0o600);
    }
  });

  test("a flood of one event cannot evict another, and the next entry says how many were cut", async () => {
    const directory = await dataDir();
    const capture = captureLogs();
    let at = Date.parse("2026-11-04T10:00:00.000Z");
    const essential = install({
      dataDir: directory,
      owner: "desktop",
      now: () => new Date(at),
      bounds: { eventBurst: 3, eventRefillMs: 60_000 },
    });
    createLogger("docker").warn("writer-lease.lost", { reason: "reclaimed" });
    const log = createLogger("local-server");
    for (let index = 0; index < 5_000; index += 1) {
      log.warn("bridge.exited", {
        key: "codex:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
        code: 1,
        signal: null,
        requested: false,
      });
    }
    at += 60_000;
    log.warn("bridge.exited", {
      key: "codex:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
      code: 1,
      signal: null,
      requested: false,
    });
    await essential.flush();
    capture.restore();

    const written = await entries(directory);
    const floods = written.filter((record) => record.event === "bridge.exited");
    expect(floods).toHaveLength(4);
    expect(floods.at(-1)?.fields?.suppressed).toBe(4_997);
    expect(written.some((record) => record.event === "writer-lease.lost")).toBe(true);
  });

  test("routine requested exits cannot spend the crash exit allowance", async () => {
    const directory = await dataDir();
    const capture = captureLogs();
    const essential = install({ dataDir: directory, owner: "backend" });
    const log = createLogger("local-server");
    for (let code = 0; code < 20; code += 1) log.info("bridge.exited", { code, requested: true });
    log.warn("bridge.exited", { code: 99, requested: false });
    await essential.flush();
    capture.restore();
    const exits = (await entries(directory)).filter((record) => record.event === "bridge.exited");
    expect(exits.filter((record) => record.level === "info")).toHaveLength(10);
    expect(exits.at(-1)?.fields).toEqual({ code: 99, requested: false });
  });

  test.each([false, true])(
    "rotation never overwrites a destination, synchronous flush: %s",
    async (sync) => {
      const directory = await dataDir();
      const capture = captureLogs();
      const maxFileBytes = 512;
      let renames = 0;
      const essential = install({
        dataDir: directory,
        owner: "backend",
        bounds: { maxFileBytes, eventBurst: 10_000 },
        io: {
          renameSync: (from, to) => {
            renames += 1;
            if (existsSync(to))
              throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
            renameSync(from, to);
          },
        },
      });
      for (let code = 0; code < 100; code += 1)
        createLogger("backend").info("shutdown.finished", { code });
      if (sync) essential.flushSync();
      await essential.flush();
      capture.restore();
      expect(renames).toBeGreaterThan(12);
      expect((await entries(directory)).at(-1)?.fields?.code).toBe(99);
      expect(await totalBytes(directory)).toBeLessThanOrEqual(4 * maxFileBytes);
      expect(
        capture.records().filter((record) => record.event === "essential.write-failed"),
      ).toEqual([]);
    },
  );

  test("a stop counts what no later entry reported", async () => {
    const directory = await dataDir();
    const capture = captureLogs();
    const first = installEssentialLog({
      dataDir: directory,
      owner: "desktop",
      bounds: { eventBurst: 1, eventRefillMs: 60_000 },
    });
    const log = createLogger("backend");
    for (let index = 0; index < 11; index += 1) log.info("shutdown.finished", { code: index });
    await first.stop();
    capture.restore();

    const marker = (await entries(directory)).find((record) => record.event === "entries.dropped");
    expect(marker?.fields).toEqual({ entries: 10, bytes: 0, reason: "rate-limited" });
  });

  test("a throttled fault cannot flood the file either", async () => {
    const directory = await dataDir();
    const capture = captureLogs();
    const essential = install({ dataDir: directory, owner: "backend" });
    const log = createLogger("process");
    for (let index = 0; index < 1_000; index += 1) {
      log.throttled("error", "rejection.unhandled", {
        error: new TypeError("boom"),
        fields: () => ({ error: formatLogError(new TypeError("boom"), { message: false }) }),
      });
    }
    await essential.flush();
    capture.restore();

    expect(
      (await entries(directory)).filter((record) => record.event === "rejection.unhandled"),
    ).toHaveLength(1);
  });
});

describe("a write that fails", () => {
  test("a stalled disk cannot hold the caller, grows nothing unbounded and is counted", async () => {
    const directory = await dataDir();
    const capture = captureLogs();
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let appends = 0;
    const essential = install({
      dataDir: directory,
      owner: "desktop",
      bounds: { maxPendingBytes: 1_024, eventBurst: 10_000 },
      beforeWrite: async () => {
        appends += 1;
        await stalled;
      },
    });
    const log = createLogger("backend");
    const started = performance.now();
    for (let index = 0; index < 1_000; index += 1) log.info("shutdown.finished", { code: index });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(appends).toBeLessThanOrEqual(1);
    release();
    await essential.flush();
    log.info("shutdown.finished", { code: -1 });
    await essential.flush();
    capture.restore();

    const written = await entries(directory);
    const marker = written.find((record) => record.event === "entries.dropped");
    expect(marker?.level).toBe("warn");
    expect(marker?.fields?.reason).toBe("queue-full");
    expect(Number(marker?.fields?.entries)).toBeGreaterThan(900);
    expect(written.at(-1)?.fields?.code).toBe(-1);
  });

  test("a directory it cannot create never throws, never recurses, and is reported at the next write that works", async () => {
    const directory = await dataDir();
    const capture = captureLogs();
    await mkdir(path.join(directory, "logs"));
    const blocker = path.join(directory, "logs", "essential");
    await writeFile(blocker, "a file where the directory goes");
    const essential = install({ dataDir: directory, owner: "desktop" });
    const log = createLogger("backend");
    expect(() => log.info("shutdown.finished", { code: 1 })).not.toThrow();
    expect(() => log.info("shutdown.finished", { code: 2 })).not.toThrow();
    await essential.flush();

    const reports = capture.records().filter((record) => record.event === "essential.write-failed");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.level).toBe("warn");
    expect(reports[0]?.fields?.error).not.toHaveProperty("message");

    await rm(blocker);
    log.info("shutdown.finished", { code: 3 });
    await essential.flush();
    capture.restore();

    const written = await entries(directory);
    expect(written[0]?.event).toBe("entries.dropped");
    expect(written[0]?.fields?.reason).toBe("write-failed");
    expect(written[0]?.fields?.entries).toBe(3);
    expect(written.at(-1)?.fields?.code).toBe(3);
    expect(capture.records().some((record) => record.event === "throttle.recovered")).toBe(true);
  });

  test("a rotation that fails drops the entry rather than passing the cap", async () => {
    const directory = await dataDir();
    const capture = captureLogs();
    const maxFileBytes = 256;
    const essential = install({
      dataDir: directory,
      owner: "desktop",
      bounds: { maxFileBytes, rotatedFiles: 1, eventBurst: 10_000 },
    });
    await essential.flush();
    // A directory with something in it cannot be replaced by a rename.
    await mkdir(path.join(essential.directory, "essential.1.jsonl", "held"), { recursive: true });
    for (let index = 0; index < 50; index += 1) {
      createLogger("backend").info("shutdown.finished", { code: index });
    }
    await essential.flush();
    capture.restore();

    const active = await stat(path.join(essential.directory, "essential.jsonl"));
    expect(active.size).toBeLessThanOrEqual(maxFileBytes);
    expect(capture.records().some((record) => record.event === "essential.write-failed")).toBe(
      true,
    );
  });
});

describe("retention leaves it alone", () => {
  test("the age sweep and the directory budget skip it, and take what is beside it", async () => {
    const directory = await dataDir();
    const logs = path.join(directory, "logs");
    const essential = path.join(logs, "essential");
    const nested = path.join(logs, "codex-raw");
    await mkdir(essential, { recursive: true });
    await mkdir(nested);
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    for (const file of [
      path.join(essential, "essential.jsonl"),
      path.join(logs, "orkestrator-ai-old.log"),
      path.join(nested, "raw.jsonl"),
    ]) {
      await writeFile(file, "x".repeat(32));
      await utimes(file, old, old);
    }
    await pruneExpiredApplicationLogs(logs, 7);
    expect(await readdir(logs)).toEqual(["essential"]);
    expect(await readdir(essential)).toEqual(["essential.jsonl"]);

    const recent = path.join(logs, "orkestrator-ai-new.log");
    await writeFile(recent, "x".repeat(32));
    await pruneExpiredApplicationLogs(logs, 7, Date.now(), { maxDirectoryBytes: 1 });
    expect(await readdir(logs)).toEqual(["essential"]);
    expect(await readdir(essential)).toEqual(["essential.jsonl"]);
  });

  test("a file that is merely called essential is not protected", async () => {
    const directory = await dataDir();
    const logs = path.join(directory, "logs");
    await mkdir(logs);
    const decoy = path.join(logs, "essential");
    await writeFile(decoy, "not the directory");
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await utimes(decoy, old, old);
    await pruneExpiredApplicationLogs(logs, 7);
    expect(await readdir(logs)).toEqual([]);
  });
});
