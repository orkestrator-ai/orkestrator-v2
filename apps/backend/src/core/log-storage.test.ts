import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupLogStorage, getLogStorageStats } from "./log-storage.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-log-storage-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("log storage", () => {
  test("reports regular files recursively without following symlinks", async () => {
    const root = await temporaryDirectory();
    const logs = path.join(root, "logs");
    const nested = path.join(logs, "codex-raw");
    const external = path.join(root, "external.log");
    await mkdir(nested, { recursive: true });
    await Promise.all([
      writeFile(path.join(logs, "app.log"), "1234"),
      writeFile(path.join(nested, "session.jsonl"), "123456"),
      writeFile(external, "secret"),
    ]);
    await symlink(external, path.join(logs, "external-link"));

    await expect(getLogStorageStats(logs)).resolves.toEqual({ totalBytes: 10, fileCount: 2 });
  });

  test("removes every log entry without deleting symlink targets", async () => {
    const root = await temporaryDirectory();
    const logs = path.join(root, "logs");
    const external = path.join(root, "external.log");
    await mkdir(path.join(logs, "nested"), { recursive: true });
    await Promise.all([
      writeFile(path.join(logs, "app.log"), "app"),
      writeFile(path.join(logs, "nested", "raw.jsonl"), "raw"),
      writeFile(external, "keep"),
    ]);
    await symlink(external, path.join(logs, "external-link"));

    await expect(cleanupLogStorage(logs)).resolves.toEqual({ totalBytes: 0, fileCount: 0 });
    expect(await readFile(external, "utf8")).toBe("keep");
  });

  test("treats a missing directory as empty", async () => {
    const root = await temporaryDirectory();
    await expect(getLogStorageStats(path.join(root, "missing"))).resolves.toEqual({
      totalBytes: 0,
      fileCount: 0,
    });
  });
});
