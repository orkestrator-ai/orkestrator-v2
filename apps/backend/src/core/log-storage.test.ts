import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupLogStorage, getLogStorageStats } from "./log-storage.js";

const temporaryDirectories: string[] = [];

const stats = (
  totalBytes: number,
  fileCount: number,
  essentialBytes = 0,
  essentialFileCount = 0,
) => ({
  totalBytes,
  fileCount,
  essentialBytes,
  essentialFileCount,
});

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

    await expect(getLogStorageStats(logs)).resolves.toEqual(stats(10, 2));
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

    await expect(cleanupLogStorage(logs)).resolves.toEqual(stats(0, 0));
    expect(await readFile(external, "utf8")).toBe("keep");
  });

  test("treats a missing directory as empty", async () => {
    const root = await temporaryDirectory();
    await expect(getLogStorageStats(path.join(root, "missing"))).resolves.toEqual(stats(0, 0));
  });

  test("treats a missing directory as nothing to clean up", async () => {
    const root = await temporaryDirectory();
    await expect(cleanupLogStorage(path.join(root, "missing"))).resolves.toEqual(stats(0, 0));
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
    await expect(getLogStorageStats(logs, 3)).resolves.toEqual(stats(3, 3));
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
    await expect(getLogStorageStats(logs, 3)).resolves.toEqual(stats(2, 2));
  });

  test("counts an empty directory as zero without failing", async () => {
    const root = await temporaryDirectory();
    const logs = path.join(root, "logs");
    await mkdir(logs, { recursive: true });
    await expect(getLogStorageStats(logs)).resolves.toEqual(stats(0, 0));
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

describe("the essential log", () => {
  async function logsWithEssential(): Promise<string> {
    const logs = path.join(await temporaryDirectory(), "logs");
    await mkdir(path.join(logs, "essential"), { recursive: true });
    await writeFile(path.join(logs, "essential", "essential.jsonl"), "1234567");
    await writeFile(path.join(logs, "essential", "essential.1.jsonl"), "123");
    await writeFile(path.join(logs, "orkestrator-ai-2026-11-04.log"), "12");
    return logs;
  }

  test("is reported separately, and not in the figures Clean up logs acts on", async () => {
    await expect(getLogStorageStats(await logsWithEssential())).resolves.toEqual(
      stats(2, 1, 10, 2),
    );
  });

  test("survives Clean up logs, which still removes everything beside it", async () => {
    const logs = await logsWithEssential();
    await expect(cleanupLogStorage(logs)).resolves.toEqual(stats(0, 0, 10, 2));
    expect(await readFile(path.join(logs, "essential", "essential.jsonl"), "utf8")).toBe("1234567");
  });

  test("does not follow an essential root symlink or spend its budget on outside entries", async () => {
    const root = await temporaryDirectory();
    const logs = path.join(root, "logs");
    const external = path.join(root, "external");
    await mkdir(logs);
    await mkdir(external);
    await writeFile(path.join(logs, "debug.log"), "123");
    await writeFile(path.join(external, "private.log"), "external bytes");
    await symlink(external, path.join(logs, "essential"));
    await expect(getLogStorageStats(logs, 2)).resolves.toEqual(stats(3, 1));
    await expect(cleanupLogStorage(logs)).resolves.toEqual(stats(0, 0));
    expect(await readFile(path.join(external, "private.log"), "utf8")).toBe("external bytes");
  });

  test("counts a regular file called essential as debug storage and cleans it safely", async () => {
    const logs = path.join(await temporaryDirectory(), "logs");
    await mkdir(logs);
    await writeFile(path.join(logs, "essential"), "1234");
    await expect(getLogStorageStats(logs)).resolves.toEqual(stats(4, 1));
    await expect(cleanupLogStorage(logs)).resolves.toEqual(stats(0, 0));
  });

  test("only protects the directory at the top, not a name that happens to match", async () => {
    const logs = path.join(await temporaryDirectory(), "logs");
    await mkdir(path.join(logs, "nested", "essential"), { recursive: true });
    await writeFile(path.join(logs, "nested", "essential", "raw.log"), "1234");
    await expect(getLogStorageStats(logs)).resolves.toEqual(stats(4, 1));
    await cleanupLogStorage(logs);
    await expect(getLogStorageStats(logs)).resolves.toEqual(stats(0, 0));
  });
});
