import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupLogStorage, getLogStorageStats } from "./log-storage.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-log-storage-"));
  temporaryDirectories.push(directory);
  return directory;
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    // A test that revoked write permission has to restore it before cleanup.
    await chmod(directory, 0o700).catch(() => {});
    await chmod(path.join(directory, "logs"), 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
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

  test("treats a missing directory as nothing to clean up", async () => {
    const root = await temporaryDirectory();
    await expect(cleanupLogStorage(path.join(root, "missing"))).resolves.toEqual({
      totalBytes: 0,
      fileCount: 0,
    });
  });

  test("refuses to walk a directory past the entry bound", async () => {
    const root = await temporaryDirectory();
    const logs = path.join(root, "logs");
    await mkdir(logs, { recursive: true });
    await Promise.all([
      writeFile(path.join(logs, "a.log"), "a"),
      writeFile(path.join(logs, "b.log"), "b"),
      writeFile(path.join(logs, "c.log"), "c"),
    ]);

    await expect(getLogStorageStats(logs, 2)).rejects.toThrow(/too many entries/);
    // The bound counts entries, not files, so a tree that fits is unaffected.
    await expect(getLogStorageStats(logs, 3)).resolves.toEqual({ totalBytes: 3, fileCount: 3 });
  });

  test("counts nested directory entries against the same bound", async () => {
    const root = await temporaryDirectory();
    const logs = path.join(root, "logs");
    await mkdir(path.join(logs, "nested"), { recursive: true });
    await Promise.all([
      writeFile(path.join(logs, "a.log"), "a"),
      writeFile(path.join(logs, "nested", "b.log"), "b"),
    ]);

    // `logs` holds two entries (a.log, nested/) and nested holds one.
    await expect(getLogStorageStats(logs, 2)).rejects.toThrow(/too many entries/);
    await expect(getLogStorageStats(logs, 3)).resolves.toEqual({ totalBytes: 2, fileCount: 2 });
  });

  test("counts an empty directory as zero without failing", async () => {
    const root = await temporaryDirectory();
    const logs = path.join(root, "logs");
    await mkdir(logs, { recursive: true });
    await expect(getLogStorageStats(logs)).resolves.toEqual({ totalBytes: 0, fileCount: 0 });
  });

  test.skipIf(isRoot)("surfaces a removal it is not permitted to perform", async () => {
    const root = await temporaryDirectory();
    const logs = path.join(root, "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, "app.log"), "app");
    // Revoking write on the parent is what blocks the unlink; the caller must
    // see the failure rather than a stats object claiming the logs are gone.
    await chmod(logs, 0o500);

    try {
      await expect(cleanupLogStorage(logs)).rejects.toThrow();
      expect(await readFile(path.join(logs, "app.log"), "utf8")).toBe("app");
    } finally {
      await chmod(logs, 0o700);
    }
  });
});
