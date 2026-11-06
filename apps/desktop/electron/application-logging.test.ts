import { installControlledTimeout } from "../../../tests/helpers/controlled-timeout";
import { configureLogger, createLogger, resetLogger } from "@orkestrator/protocol/logger";
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFile,
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
  readApplicationLogPolicy,
  readApplicationLogSettings,
  readStoredApplicationLogPolicy,
  registerApplicationLoggingShutdown,
  type ApplicationLogFileOperations,
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

  test("installs but writes nothing while saving is off", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ global: { debugLogging: false } }),
    );
    const logging = installProductionApplicationLogging({ dataDir });
    try {
      console.log("not saved");
      await logging.flush();
      expect(logging.settings()).toEqual({ enabled: false, retentionDays: 7 });
      expect(await readdir(dataDir)).toEqual(["config.json"]);
    } finally {
      await logging.stop();
    }
  });
});

describe("production application log writing", () => {
  test("keeps formats separate across same-day restarts in both directions", async () => {
    const dataDir = await enabledDataDir();
    const now = () => new Date("2026-08-25T18:00:00.000Z");
    let logging: InstalledApplicationLogging | null = null;
    try {
      // Both formats resume their own file on the second launch.
      for (const format of ["text", "json", "text", "json"] as const) {
        configureLogger({ format });
        logging = installProductionApplicationLogging({ dataDir, now });
        console.log(`launch in ${format}`);
        await logging?.stop();
      }
      const logDirectory = path.join(dataDir, "logs");
      expect((await readdir(logDirectory)).sort()).toEqual([
        "orkestrator-ai-2026-08-25.jsonl",
        "orkestrator-ai-2026-08-25.log",
      ]);
      const text = await readFile(path.join(logDirectory, "orkestrator-ai-2026-08-25.log"), "utf8");
      expect(text.match(/LOG launch in text/g)).toHaveLength(2);
      expect(text).not.toContain("launch in json");
      const json = await readFile(
        path.join(logDirectory, "orkestrator-ai-2026-08-25.jsonl"),
        "utf8",
      );
      const records = json
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.filter((record) => record.message === "launch in json")).toHaveLength(2);
      expect(records.every((record) => record.orklog === 1)).toBe(true);
      expect(json).not.toContain("launch in text");
    } finally {
      await logging?.stop();
      resetLogger();
    }
  });

  test("keeps queued entries in their format's destination", async () => {
    const dataDir = await enabledDataDir();
    const logging = installProductionApplicationLogging({
      dataDir,
      now: () => new Date("2026-08-25T18:00:00.000Z"),
    });
    try {
      console.log("text before");
      configureLogger({ format: "json" });
      console.log("json between");
      configureLogger({ format: "text" });
      console.log("text after");
      await logging?.stop();
      const text = await readFile(
        path.join(dataDir, "logs", "orkestrator-ai-2026-08-25.log"),
        "utf8",
      );
      expect(text).toContain("LOG text before");
      expect(text).toContain("LOG text after");
      expect(text).not.toContain("json between");
      const json = await readFile(
        path.join(dataDir, "logs", "orkestrator-ai-2026-08-25.jsonl"),
        "utf8",
      );
      expect(JSON.parse(json)).toMatchObject({ message: "json between" });
    } finally {
      await logging?.stop();
      resetLogger();
    }
  });

  test("rolls JSON files separately and resumes their latest roll on restart", async () => {
    const dataDir = await enabledDataDir();
    const options = {
      dataDir,
      now: () => new Date("2026-08-25T18:00:00.000Z"),
      bounds: { maxFileBytes: 400 },
    };
    let logging: InstalledApplicationLogging | null = null;
    configureLogger({ format: "json" });
    try {
      logging = installProductionApplicationLogging(options);
      for (let index = 0; index < 8; index += 1) console.log(`entry ${index} ${"y".repeat(60)}`);
      await logging?.stop();
      const logDirectory = path.join(dataDir, "logs");
      const beforeRestart = await readdir(logDirectory);
      expect(beforeRestart).toContain("orkestrator-ai-2026-08-25.1.jsonl");
      const baseFile = path.join(logDirectory, "orkestrator-ai-2026-08-25.jsonl");
      const original = await readFile(baseFile, "utf8");
      logging = installProductionApplicationLogging(options);
      console.log("after JSON restart");
      await logging?.stop();
      expect(await readFile(baseFile, "utf8")).toBe(original);
      const records: Array<Record<string, unknown>> = [];
      for (const file of await readdir(logDirectory)) {
        expect(file.endsWith(".jsonl")).toBe(true);
        const contents = await readFile(path.join(logDirectory, file), "utf8");
        expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(400);
        records.push(
          ...contents
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
      }
      expect(records).toContainEqual(expect.objectContaining({ message: "after JSON restart" }));
    } finally {
      await logging?.stop();
      resetLogger();
    }
  });

  test.each([false, true])(
    "escapes Unicode separators in raw JSON entries (truncated: %s)",
    async (truncated) => {
      const dataDir = await enabledDataDir();
      configureLogger({ format: "json" });
      const logging = installProductionApplicationLogging({
        dataDir,
        now: () => new Date("2026-08-25T18:00:00.000Z"),
        bounds: { maxEntryBytes: 400 },
      });
      const message = "first\u2028second\u2029third" + (truncated ? "x".repeat(1000) : "");
      try {
        console.log(message);
        await logging?.stop();
        const json = await readFile(
          path.join(dataDir, "logs", "orkestrator-ai-2026-08-25.jsonl"),
          "utf8",
        );
        const lines = json.trim().split(/\r\n|\n|\r|\u2028|\u2029/);
        expect(lines).toHaveLength(2);
        const records = lines.map((line) => JSON.parse(line));
        expect(records[1]).toMatchObject({
          message: truncated ? message.slice(0, 50) : message,
          ...(truncated ? { truncated: true } : {}),
        });
        expect(lines.every((line) => Buffer.byteLength(line) <= 400)).toBe(true);
      } finally {
        await logging?.stop();
        resetLogger();
      }
    },
  );

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
    expect(contents).toContain("[logging] capture.started directory=");
    expect(contents).toContain("WARN diagnostic { code: 42 }");
  });

  test("writes valid JSON lines in JSON mode, including console output and drop markers", async () => {
    const dataDir = await enabledDataDir();
    configureLogger({ format: "json" });
    try {
      const logger = installProductionApplicationLogging({
        dataDir,
        now: () => new Date("2026-08-25T18:00:00.000Z"),
        bounds: { maxPendingBytes: 700 },
      });
      createLogger("updater").warn("check.failed", { attempt: 2 });
      console.error("[Backend] unmigrated\nsecond line");
      console.log("z".repeat(800));
      await logger?.stop();

      const contents = await readFile(
        path.join(dataDir, "logs", "orkestrator-ai-2026-08-25.jsonl"),
        "utf8",
      );
      const entries = contents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries.every((entry) => entry.orklog === 1)).toBe(true);
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          area: "updater",
          event: "check.failed",
          fields: { attempt: 2 },
        }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({ level: "error", message: "[Backend] unmigrated\nsecond line" }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          area: "logging",
          event: "entries.dropped",
          fields: expect.objectContaining({ entries: 1 }),
        }),
      );
    } finally {
      resetLogger();
    }
  });

  test("keeps a JSON line parseable when the entry bound cuts it", async () => {
    const dataDir = await enabledDataDir();
    configureLogger({ format: "json" });
    try {
      const logger = installProductionApplicationLogging({
        dataDir,
        now: () => new Date("2026-08-25T18:00:00.000Z"),
        bounds: { maxEntryBytes: 400 },
      });
      console.log("x".repeat(4000));
      await logger?.stop();
      const contents = await readFile(
        path.join(dataDir, "logs", "orkestrator-ai-2026-08-25.jsonl"),
        "utf8",
      );
      const last = JSON.parse(contents.trim().split("\n").at(-1)!) as Record<string, unknown>;
      expect(last.truncated).toBe(true);
      expect(Buffer.byteLength(contents.trim().split("\n").at(-1)!)).toBeLessThanOrEqual(400);
    } finally {
      resetLogger();
    }
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
    expect(contents).toMatch(
      /WARN \[logging\] entries\.dropped entries=2 bytes=\d+ reason=queue-full/,
    );
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
    expect(contents).toMatch(
      /WARN \[logging\] entries\.dropped entries=1 bytes=\d+ reason=queue-full/,
    );
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

describe("production application log batching", () => {
  const LOG_FILE = "orkestrator-ai-2026-08-25.log";
  const now = () => new Date("2026-08-25T18:00:00.000Z");

  /** The real filesystem, counted, with room for a test to fail or hold a call. */
  function countedFiles(overrides: Partial<ApplicationLogFileOperations> = {}) {
    const calls = { mkdir: 0, appendFile: 0 };
    const files: ApplicationLogFileOperations = {
      mkdir(directory, options) {
        calls.mkdir += 1;
        return overrides.mkdir ? overrides.mkdir(directory, options) : mkdir(directory, options);
      },
      appendFile(target, data, options) {
        calls.appendFile += 1;
        return overrides.appendFile
          ? overrides.appendFile(target, data, options)
          : appendFile(target, data, options);
      },
    };
    return { calls, files };
  }

  function failure(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: simulated`), { code });
  }

  async function savedLines(dataDir: string, file = LOG_FILE): Promise<string[]> {
    const contents = await readFile(path.join(dataDir, "logs", file), "utf8");
    return contents.split("\n").filter((line) => line.includes("line-"));
  }

  function numbersIn(lines: string[]): number[] {
    return lines.map((line) => Number(line.match(/line-(\d+)/)?.[1]));
  }

  /** Captures what the writer reports, which goes to the console it was installed over. */
  function captureConsoleError() {
    const original = console.error;
    const reported: string[] = [];
    console.error = (...args: unknown[]) => void reported.push(args.join(" "));
    return { reported, restore: () => void (console.error = original) };
  }

  test("mixed formats retain rollover reservations before any append", async () => {
    const dataDir = await enabledDataDir();
    const logging = installProductionApplicationLogging({
      dataDir,
      now,
      bounds: { maxFileBytes: 400 },
    });
    try {
      console.log(`line-0 ${"x".repeat(220)}`);
      console.log(`line-1 ${"x".repeat(220)}`);
      configureLogger({ format: "json" });
      console.log("line-2");
      configureLogger({ format: "text" });
      console.log(`line-3 ${"x".repeat(220)}`);
      await logging.flush();
      const textFiles = (await readdir(path.join(dataDir, "logs"))).filter((file) =>
        file.endsWith(".log"),
      );
      // The base file precedes the numbered files regardless of lexical order.
      textFiles.sort(
        (a, b) =>
          Number(a.match(/\.(\d+)\.log$/)?.[1] ?? 0) - Number(b.match(/\.(\d+)\.log$/)?.[1] ?? 0),
      );
      expect(textFiles.length).toBeGreaterThanOrEqual(3);
      const lines: string[] = [];
      for (const file of textFiles) {
        expect((await stat(path.join(dataDir, "logs", file))).size).toBeLessThanOrEqual(400);
        lines.push(...(await savedLines(dataDir, file)));
      }
      expect(numbersIn(lines)).toEqual([0, 1, 3]);
      expect(numbersIn(await savedLines(dataDir, LOG_FILE.replace(".log", ".jsonl")))).toEqual([2]);
    } finally {
      await logging.stop();
      resetLogger();
    }
  });

  for (const code of ["ENOENT", "ENOSPC", "ENOENT-twice"]) {
    test(`a later run failing with ${code} preserves earlier success and permits later batches`, async () => {
      const dataDir = await enabledDataDir();
      const capture = captureConsoleError();
      const attempts: string[] = [];
      let remainingFailures = code === "ENOENT-twice" ? 2 : 1;
      const { calls, files } = countedFiles({
        async appendFile(target, data, options) {
          attempts.push(data.toString());
          if (data.toString().includes("line-1") && remainingFailures > 0) {
            remainingFailures -= 1;
            throw failure(code === "ENOSPC" ? "ENOSPC" : "ENOENT");
          }
          await appendFile(target, data, options);
        },
      });
      const logging = installProductionApplicationLogging({ dataDir, now, files });
      try {
        console.log("line-0");
        configureLogger({ format: "json" });
        console.log("line-1");
        console.log("line-2");
        configureLogger({ format: "text" });
        console.log("line-3");
        await logging.flush();
        const recovered = code === "ENOENT";
        expect(attempts.filter((data) => data.includes("line-0"))).toHaveLength(1);
        expect(attempts.filter((data) => data.includes("line-1"))).toHaveLength(
          code === "ENOSPC" ? 1 : 2,
        );
        expect(calls.appendFile).toBe(recovered ? 4 : code === "ENOSPC" ? 2 : 3);
        const reports = capture.reported.filter((line) => line.includes("write.failed"));
        expect(reports).toHaveLength(recovered ? 0 : 1);
        if (!recovered) {
          expect(reports[0]).toContain("entries=3");
          const lostBytes = attempts.find((data) => data.includes("line-1"))!;
          // The failed JSON run plus the unattempted text run are reported.
          const textBytes = Buffer.byteLength(`${now().toISOString()} LOG line-3\n`);
          expect(reports[0]).toContain(`bytes=${Buffer.byteLength(lostBytes) + textBytes}`);
        }
        expect(numbersIn(await savedLines(dataDir))).toEqual(recovered ? [0, 3] : [0]);
        if (recovered) {
          expect(numbersIn(await savedLines(dataDir, LOG_FILE.replace(".log", ".jsonl")))).toEqual([
            1, 2,
          ]);
        } else {
          expect(
            (await readdir(path.join(dataDir, "logs"))).filter((file) => file.endsWith(".jsonl")),
          ).toEqual([]);
        }
        console.log("line-4");
        await logging.flush();
        expect(numbersIn(await savedLines(dataDir))).toEqual(recovered ? [0, 3, 4] : [0, 4]);
        expect(calls.mkdir).toBe(recovered ? 2 : code === "ENOSPC" ? 2 : 3);
      } finally {
        await logging.stop();
        capture.restore();
        resetLogger();
      }
    });
  }

  test("a burst makes one mkdir and far fewer appends than lines", async () => {
    const dataDir = await enabledDataDir();
    const { calls, files } = countedFiles();
    const logging = installProductionApplicationLogging({ dataDir, now, files });
    const lines = 2_000;
    for (let index = 0; index < lines; index += 1) console.log(`line-${index}`);
    await logging.stop();

    expect(calls.mkdir).toBe(1);
    expect(calls.appendFile).toBeLessThan(5);
    expect(await savedLines(dataDir)).toHaveLength(lines);
  });

  test("keeps every line in order across batches and lines logged mid-write", async () => {
    const dataDir = await enabledDataDir();
    const { calls, files } = countedFiles();
    const logging = installProductionApplicationLogging({
      dataDir,
      now,
      files,
      bounds: { maxBatchBytes: 256 },
    });
    let index = 0;
    for (let round = 0; round < 20; round += 1) {
      for (let line = 0; line < 25; line += 1) console.log(`line-${index++}`);
      // Lets some of the writer's work run between the bursts of lines.
      await new Promise((resolve) => setImmediate(resolve));
    }
    await logging.stop();

    expect(numbersIn(await savedLines(dataDir))).toEqual(
      Array.from({ length: index }, (_, n) => n),
    );
    expect(calls.appendFile).toBeGreaterThan(1);
    expect(calls.appendFile).toBeLessThan(index);
    expect(logging.dropStats()).toEqual({ droppedEntries: 0, droppedBytes: 0 });
  });

  test("never passes the batch bound unless a single entry does", async () => {
    const dataDir = await enabledDataDir();
    const sizes: number[] = [];
    const { files } = countedFiles({
      appendFile(target, data, options) {
        sizes.push(data.byteLength);
        return appendFile(target, data, options);
      },
    });
    const logging = installProductionApplicationLogging({
      dataDir,
      now,
      files,
      bounds: { maxBatchBytes: 512 },
    });
    await logging.flush();
    sizes.length = 0;
    for (let index = 0; index < 40; index += 1) console.log(`line-${index} ${"y".repeat(40)}`);
    console.log(`line-40 ${"z".repeat(2_000)}`);
    await logging.stop();

    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.at(-1)).toBeGreaterThan(2_000);
    for (const size of sizes.slice(0, -1)) expect(size).toBeLessThanOrEqual(512);
    expect(numbersIn(await savedLines(dataDir))).toEqual(Array.from({ length: 41 }, (_, n) => n));
  });

  test("a line reaches the file within a few event-loop turns, with nothing asking", async () => {
    const dataDir = await enabledDataDir();
    let written = "";
    const { files } = countedFiles({
      mkdir: async () => undefined,
      appendFile: async (_target, data) => {
        written += data.toString();
      },
    });
    const logging = installProductionApplicationLogging({ dataDir, now, files });
    try {
      // The first write sizes the file on the real disk, which takes no fixed
      // number of turns. Every later one has nothing to wait for but the writer.
      await logging.flush();
      console.log("line-bounded");
      expect(written).not.toContain("line-bounded");
      // Counted in turns, not milliseconds, so a loaded host cannot fail it.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(written).toContain("line-bounded");
    } finally {
      await logging.stop();
    }
  });

  test("stop waits for every queued line and an append in flight", async () => {
    const dataDir = await enabledDataDir();
    const held = Promise.withResolvers<void>();
    let holding = true;
    const { files } = countedFiles({
      async appendFile(target, data, options) {
        if (holding) await held.promise;
        await appendFile(target, data, options);
      },
    });
    const logging = installProductionApplicationLogging({ dataDir, now, files });
    console.log("line-0");
    await new Promise((resolve) => setImmediate(resolve));
    console.log("line-1");

    let stopped = false;
    const stopping = logging.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    holding = false;
    held.resolve();
    await stopping;
    expect(numbersIn(await savedLines(dataDir))).toEqual([0, 1]);
  });

  test("the quit hold leaves queued lines on disk before the app quits", async () => {
    const dataDir = await enabledDataDir();
    const logging = installProductionApplicationLogging({ dataDir, now });
    const quit = Promise.withResolvers<void>();
    let listener: ((event: { preventDefault(): void }) => void) | undefined;
    const host: ApplicationLoggingQuitHost = {
      on(_event, next) {
        listener = next;
        return host;
      },
      quit: () => quit.resolve(),
    };
    registerApplicationLoggingShutdown(host, logging, 30_000);

    for (let index = 0; index < 100; index += 1) console.log(`line-${index}`);
    listener?.({ preventDefault: () => {} });
    await quit.promise;

    expect(numbersIn(await savedLines(dataDir))).toEqual(Array.from({ length: 100 }, (_, n) => n));
  });

  test("flush covers every line logged before it, however many pieces they take", async () => {
    const dataDir = await enabledDataDir();
    const logging = installProductionApplicationLogging({
      dataDir,
      now,
      bounds: { maxBatchBytes: 64 },
    });
    try {
      for (let index = 0; index < 50; index += 1) console.log(`line-${index}`);
      await logging.flush();
      expect(numbersIn(await savedLines(dataDir))).toEqual(Array.from({ length: 50 }, (_, n) => n));
    } finally {
      await logging.stop();
    }
  });

  test("recovers when the log folder is removed while running", async () => {
    const dataDir = await enabledDataDir();
    const { calls, files } = countedFiles();
    const logging = installProductionApplicationLogging({ dataDir, now, files });
    try {
      console.log("line-0");
      await logging.flush();
      expect(calls.mkdir).toBe(1);

      await rm(path.join(dataDir, "logs"), { recursive: true, force: true });
      console.log("line-1");
      console.log("line-2");
      await logging.flush();

      expect(calls.mkdir).toBe(2);
      expect(numbersIn(await savedLines(dataDir))).toEqual([1, 2]);
      // Back to the first file, sized from what is there now, not numbered on
      // from the file that went away.
      expect(await readdir(path.join(dataDir, "logs"))).toEqual([LOG_FILE]);

      console.log("line-3");
      await logging.flush();
      expect(calls.mkdir).toBe(2);
      expect(numbersIn(await savedLines(dataDir))).toEqual([1, 2, 3]);
    } finally {
      await logging.stop();
    }
  });

  test("a folder that cannot be recreated reports once per batch and retries next time", async () => {
    const dataDir = await enabledDataDir();
    let failing = true;
    const { calls, files } = countedFiles({
      mkdir(directory, options) {
        if (failing) return Promise.reject(failure("EACCES"));
        return mkdir(directory, options);
      },
    });
    const capture = captureConsoleError();
    const logging = installProductionApplicationLogging({ dataDir, now, files });
    try {
      console.log("line-0");
      await logging.flush();
      expect(calls.appendFile).toBe(0);
      expect(capture.reported.filter((line) => line.includes("write.failed"))).toHaveLength(1);
      expect(capture.reported.join("\n")).toMatch(/write\.failed .*entries=\d+ bytes=\d+/);

      failing = false;
      console.log("line-1");
      await logging.flush();
      expect(numbersIn(await savedLines(dataDir))).toEqual([1]);
    } finally {
      await logging.stop();
      capture.restore();
    }
  });

  test("a failed append does not throw to the caller, and writing carries on", async () => {
    const dataDir = await enabledDataDir();
    let failures = 1;
    const { calls, files } = countedFiles({
      async appendFile(target, data, options) {
        if (failures > 0) {
          failures -= 1;
          throw failure("ENOSPC");
        }
        await appendFile(target, data, options);
      },
    });
    const capture = captureConsoleError();
    const logging = installProductionApplicationLogging({ dataDir, now, files });
    try {
      expect(() => console.log("line-0")).not.toThrow();
      await expect(logging.flush()).resolves.toBeUndefined();
      expect(capture.reported.join("\n")).toContain("write.failed");
      // ENOSPC is not retried, or a partial write could appear twice.
      expect(calls.appendFile).toBe(1);

      console.log("line-1");
      await logging.flush();
      expect(numbersIn(await savedLines(dataDir))).toEqual([1]);
      // The directory is proved again after any failed write.
      expect(calls.mkdir).toBe(2);
    } finally {
      await logging.stop();
      capture.restore();
    }
  });

  test("a report that throws cannot break the write chain", async () => {
    const dataDir = await enabledDataDir();
    let failures = 1;
    const { files } = countedFiles({
      async appendFile(target, data, options) {
        if (failures > 0) {
          failures -= 1;
          throw failure("EIO");
        }
        await appendFile(target, data, options);
      },
    });
    const original = console.error;
    console.error = () => {
      throw new Error("console is gone");
    };
    const logging = installProductionApplicationLogging({ dataDir, now, files });
    try {
      console.log("line-0");
      await logging.flush();
      console.log("line-1");
      await logging.stop();
      expect(numbersIn(await savedLines(dataDir))).toEqual([1]);
    } finally {
      await logging.stop();
      console.error = original;
    }
  });

  test("pending bytes stay bounded while the disk is stalled, and the gap is announced", async () => {
    const dataDir = await enabledDataDir();
    const held = Promise.withResolvers<void>();
    let written = 0;
    const { files } = countedFiles({
      async appendFile(target, data, options) {
        await held.promise;
        written += data.byteLength;
        await appendFile(target, data, options);
      },
    });
    const maxPendingBytes = 2_048;
    const logging = installProductionApplicationLogging({
      dataDir,
      now,
      files,
      bounds: { maxPendingBytes },
    });
    for (let index = 0; index < 500; index += 1) {
      console.log(`line-${index} ${"x".repeat(100)}`);
      if (index % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    expect(logging.dropStats().droppedEntries).toBeGreaterThan(0);

    held.resolve();
    await logging.flush();
    expect(written).toBeLessThanOrEqual(maxPendingBytes);

    console.log("line-after");
    await logging.stop();
    const contents = await readFile(path.join(dataDir, "logs", LOG_FILE), "utf8");
    expect(contents).toMatch(/entries\.dropped entries=\d+ bytes=\d+ reason=queue-full/);
    expect(contents).toContain("line-after");
  });

  test("pending entries stay bounded by count as well as by bytes", async () => {
    const dataDir = await enabledDataDir();
    const logging = installProductionApplicationLogging({
      dataDir,
      now,
      bounds: { maxPendingEntries: 10 },
    });
    // The capture.started line holds one of the ten.
    for (let index = 0; index < 50; index += 1) console.log(`line-${index}`);
    expect(logging.dropStats().droppedEntries).toBe(41);
    await logging.stop();
    expect(numbersIn(await savedLines(dataDir))).toEqual(Array.from({ length: 9 }, (_, n) => n));
    const contents = await readFile(path.join(dataDir, "logs", LOG_FILE), "utf8");
    expect(contents).toMatch(/entries\.dropped entries=41 /);
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
  /**
   * The re-issued quit is its own `setTimeout(0)`, scheduled only once the hold
   * settles. When a loaded host stalls the event loop past a test's fixed sleep,
   * that sleep's timer is already due and runs before the quit timer that the
   * same wake-up schedules, so wait for the quit itself, with a bound.
   */
  async function waitForQuits(app: { quitCount: number }, count: number): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (app.quitCount < count && Date.now() < deadline) await Bun.sleep(1);
  }

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
    const stopped = Promise.withResolvers<void>();
    let stopCalls = 0;
    const logging = {
      logDirectory: "/tmp/logs",
      settings: () => ({ enabled: true, retentionDays: 7 }),
      updateSettings: () => {},
      flush: async () => {},
      dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      stop: () => {
        stopCalls += 1;
        return stopped.promise;
      },
    } satisfies InstalledApplicationLogging;

    registerApplicationLoggingShutdown(app.host, logging, 5_000);
    app.emit();
    expect(app.preventedCount).toBe(1);
    await Bun.sleep(5);
    expect(app.quitCount).toBe(0);

    stopped.resolve();
    await waitForQuits(app, 1);
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
      settings: () => ({ enabled: true, retentionDays: 7 }),
      updateSettings: () => {},
      flush: async () => {},
      dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      stop: () => new Promise<void>(() => {}),
    } satisfies InstalledApplicationLogging;

    registerApplicationLoggingShutdown(app.host, logging, 10);
    app.emit();
    await waitForQuits(app, 1);
    expect(app.quitCount).toBe(1);
  });

  test("quits anyway when the flush rejects", async () => {
    const app = fakeApp();
    const logging = {
      logDirectory: "/tmp/logs",
      settings: () => ({ enabled: true, retentionDays: 7 }),
      updateSettings: () => {},
      flush: async () => {},
      dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      stop: () => Promise.reject(new Error("disk gone")),
    } satisfies InstalledApplicationLogging;

    registerApplicationLoggingShutdown(app.host, logging, 5_000);
    app.emit();
    await waitForQuits(app, 1);
    expect(app.quitCount).toBe(1);
  });

  test("re-quits after will-quit dispatch returns when the queue is already idle", async () => {
    // Electron drains microtasks before `will-quit` dispatch returns, ignores a
    // quit issued while it still considers itself quitting, and only then
    // applies `preventDefault` by clearing that flag.
    let listener: ((event: { preventDefault(): void }) => void) | undefined;
    let quitting = false;
    let effectiveQuits = 0;
    const host: ApplicationLoggingQuitHost = {
      on(_event, next) {
        listener = next;
        return host;
      },
      quit() {
        if (!quitting) effectiveQuits += 1;
      },
    };
    const logging = {
      logDirectory: "/tmp/logs",
      settings: () => ({ enabled: true, retentionDays: 7 }),
      updateSettings: () => {},
      flush: async () => {},
      dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      stop: async () => {},
    } satisfies InstalledApplicationLogging;

    registerApplicationLoggingShutdown(host, logging, 5_000);
    quitting = true;
    let prevented = false;
    listener?.({ preventDefault: () => (prevented = true) });
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    if (prevented) quitting = false;
    expect(effectiveQuits).toBe(0);

    await Bun.sleep(5);
    expect(effectiveQuits).toBe(1);
  });

  test("closes the log only after pending output settles", async () => {
    // The backend's drain is logged through Electron: closing the log as the
    // quit began lost exactly the lines that said how it ended.
    const app = fakeApp();
    const backend = Promise.withResolvers<void>();
    const order: string[] = [];
    const logging = {
      logDirectory: "/tmp/logs",
      settings: () => ({ enabled: true, retentionDays: 7 }),
      updateSettings: () => {},
      flush: async () => {},
      dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      stop: async () => {
        order.push("log-closed");
      },
    } satisfies InstalledApplicationLogging;

    registerApplicationLoggingShutdown(app.host, logging, 5_000, {
      settled: () => backend.promise.then(() => void order.push("backend-stopped")),
      timeoutMs: 5_000,
    });
    app.emit();
    await Bun.sleep(5);
    expect(order).toEqual([]);

    backend.resolve();
    await waitForQuits(app, 1);
    expect(order).toEqual(["backend-stopped", "log-closed"]);
    expect(app.quitCount).toBe(1);
  });

  test("closes the log anyway when pending output outlives its own bound", async () => {
    const app = fakeApp();
    let closed = false;
    const logging = {
      logDirectory: "/tmp/logs",
      settings: () => ({ enabled: true, retentionDays: 7 }),
      updateSettings: () => {},
      flush: async () => {},
      dropStats: () => ({ droppedEntries: 0, droppedBytes: 0 }),
      stop: async () => {
        closed = true;
      },
    } satisfies InstalledApplicationLogging;

    const outputDeadline = installControlledTimeout(10, { label: "pending output deadline" });
    const quitTask = installControlledTimeout(0, { label: "deferred quit" });
    try {
      registerApplicationLoggingShutdown(app.host, logging, 5_000, {
        settled: () => new Promise<void>(() => {}),
        timeoutMs: 10,
      });
      app.emit();
      expect(closed).toBe(false);
      expect(outputDeadline.advance()).toBe(1);
      // Drain the hold's promise chain without depending on a shared host's
      // timer scheduling. Quit must still wait for a separate macrotask.
      for (let tick = 0; tick < 20; tick++) await Promise.resolve();
      expect(closed).toBe(true);
      expect(app.quitCount).toBe(0);
      expect(quitTask.advance()).toBe(1);
      expect(app.quitCount).toBe(1);
      outputDeadline.assertDrained();
      quitTask.assertDrained();
    } finally {
      quitTask.restore();
      outputDeadline.restore();
    }
  });

  test("registers nothing when logging was not installed", () => {
    const app = fakeApp();
    registerApplicationLoggingShutdown(app.host, null);
    app.emit();
    expect(app.preventedCount).toBe(0);
    expect(app.quitCount).toBe(0);
  });
});

describe("live settings", () => {
  async function savedLines(dataDir: string): Promise<string> {
    const logDirectory = path.join(dataDir, "logs");
    const files = await readdir(logDirectory);
    const contents = await Promise.all(
      files.map((file) => readFile(path.join(logDirectory, file), "utf8")),
    );
    return contents.join("");
  }

  test("turning saving on and off takes effect at once, with its own markers", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ global: { debugLogging: false } }),
    );
    const logging = installProductionApplicationLogging({ dataDir });
    try {
      console.log("off before");
      logging.updateSettings({ enabled: true, retentionDays: 7 });
      console.log("on");
      logging.updateSettings({ enabled: false, retentionDays: 7 });
      console.log("off after");
      await logging.flush();
      const saved = await savedLines(dataDir);
      expect(saved).toContain("on");
      expect(saved).toContain("capture.started");
      expect(saved).toContain("capture.stopped");
      expect(saved).not.toContain("off before");
      expect(saved).not.toContain("off after");
      expect(logging.settings().enabled).toBe(false);
    } finally {
      await logging.stop();
    }
  });

  test("turning saving off announces a drop it would otherwise never report", async () => {
    const dataDir = await enabledDataDir();
    const logging = installProductionApplicationLogging({
      dataDir,
      bounds: { maxPendingBytes: 1 },
    });
    try {
      console.log("does not fit");
      expect(logging.dropStats().droppedEntries).toBeGreaterThan(0);
      logging.updateSettings({ enabled: false, retentionDays: 7 });
      expect(logging.dropStats()).toEqual({ droppedEntries: 0, droppedBytes: 0 });
      await logging.flush();
      expect(await savedLines(dataDir)).toContain("entries.dropped");
    } finally {
      await logging.stop();
    }
  });

  test("a shorter retention sweeps straight away, and a sweep follows saving", async () => {
    const dataDir = await enabledDataDir();
    const logDirectory = path.join(dataDir, "logs");
    await mkdir(logDirectory, { recursive: true });
    const old = path.join(logDirectory, "orkestrator-ai-2026-01-01.log");
    await writeFile(old, "old\n");
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(old, threeDaysAgo, threeDaysAgo);
    const logging = installProductionApplicationLogging({ dataDir });
    const exists = () =>
      stat(old).then(
        () => true,
        () => false,
      );
    try {
      await logging.flush();
      expect(await exists()).toBe(true);

      logging.updateSettings({ enabled: false, retentionDays: 1 });
      await Bun.sleep(30);
      expect(await exists()).toBe(true);

      logging.updateSettings({ enabled: true, retentionDays: 1 });
      for (let waited = 0; waited < 2_000 && (await exists()); waited += 10) await Bun.sleep(10);
      expect(await exists()).toBe(false);
      expect(logging.settings().retentionDays).toBe(1);
    } finally {
      await logging.stop();
    }
  });

  test("reads both settings, applying the upgrade to a config from before the split", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ global: { debugLogging: true, debugLogRetentionDays: 30 } }),
    );
    expect(readApplicationLogPolicy(dataDir)).toEqual({
      saving: { enabled: true, retentionDays: 30 },
      detail: { level: "info", areaLevels: { bridge: "debug" } },
    });
    await writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({
        global: { debugLogging: true, logDetail: { level: "warn", areaLevels: {} } },
      }),
    );
    expect(readApplicationLogPolicy(dataDir).detail).toEqual({ level: "warn", areaLevels: {} });
  });

  test("a running process keeps its settings when the file cannot be read", async () => {
    const dataDir = await temporaryDirectory();
    expect(readStoredApplicationLogPolicy(dataDir)).toBeNull();
    await writeFile(path.join(dataDir, "config.json"), "{ torn");
    expect(readStoredApplicationLogPolicy(dataDir)).toBeNull();
  });
});
