import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  installProductionApplicationLogging,
  pruneExpiredApplicationLogs,
  readApplicationLogSettings,
} from "./application-logging";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-logging-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  }
});

describe("production application logging", () => {
  test("loads the enabled flag and normalized retention from config", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ global: { debugLogging: true, debugLogRetentionDays: 30 } }),
    );
    expect(readApplicationLogSettings(dataDir)).toEqual({ enabled: true, retentionDays: 30 });
  });

  test("writes console output to an unbounded daily production log", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ global: { debugLogging: true, debugLogRetentionDays: 14 } }),
    );
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

  test("prunes expired files recursively and keeps recent logs", async () => {
    const dataDir = await temporaryDirectory();
    const logDirectory = path.join(dataDir, "logs");
    const nested = path.join(logDirectory, "codex-raw");
    await mkdir(nested, { recursive: true });
    const expired = path.join(logDirectory, "old.log");
    const recent = path.join(nested, "recent.jsonl");
    await Promise.all([writeFile(expired, "old"), writeFile(recent, "new")]);
    await utimes(expired, new Date("2026-08-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
    await utimes(recent, new Date("2026-08-24T00:00:00Z"), new Date("2026-08-24T00:00:00Z"));

    await pruneExpiredApplicationLogs(logDirectory, 7, new Date("2026-08-25T00:00:00Z").getTime());

    expect(await readdir(logDirectory)).toEqual(["codex-raw"]);
    expect((await stat(recent)).size).toBe(3);
  });
});
