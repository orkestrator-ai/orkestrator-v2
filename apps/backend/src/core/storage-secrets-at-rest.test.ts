import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openChangeLedgerDatabase } from "./change-tracking/ledger-schema.js";
import {
  BACKUP_DIRECTORY,
  listStorageSnapshots,
  snapshotBeforeMigration,
  takeHourlySnapshotIfDue,
  takeLedgerSnapshotIfDue,
} from "./storage-backups.js";
import { CHANGE_LEDGER_DATABASE_FILE, STORAGE_DATABASE_FILE } from "./storage-database.js";
import type { StorageDatabase } from "./storage-database.js";
import { MAX_JSON_BACKUPS } from "./storage-shared-core.js";
import { openBackendDatabase } from "./storage-stores.js";
import { storageDatabase } from "./storage-test-support.js";
import { StorageService } from "./storage.js";

// The accepted risk in docs/architecture/storage.md ("Provider secrets at rest")
// rests on these modes and on where the secrets live.

const FAKE_SECRETS = [
  "fake-github-token-at-rest",
  "fake-anthropic-key-at-rest",
  "fake-cursor-key-at-rest",
  "fake-opencode-key-at-rest",
];
const directories: string[] = [];
const open: StorageDatabase[] = [];
const services: StorageService[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-secrets-at-rest-"));
  directories.push(directory);
  return directory;
}

function opened(database: StorageDatabase): StorageDatabase {
  open.push(database);
  return database;
}

async function startedService(directory: string): Promise<StorageService> {
  const storage = new StorageService(directory);
  services.push(storage);
  await storage.init();
  return storage;
}

async function saveFakeSecrets(storage: StorageService, generation = 0): Promise<void> {
  const [github, anthropic, cursor, opencode] = FAKE_SECRETS;
  await storage.setGitHubToken(`${github}-${generation}`);
  await storage.setAnthropicApiKey(`${anthropic}-${generation}`);
  await storage.setCursorApiKey(`${cursor}-${generation}`);
  await storage.setOpenCodeZenApiKey(`${opencode}-${generation}`);
}

async function mode(file: string): Promise<number> {
  return (await fs.stat(file)).mode & 0o777;
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

afterEach(async () => {
  for (const database of open.splice(0)) database.close();
  for (const storage of services.splice(0)) storage.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("database files", () => {
  test.each([
    ["orkestrator.sqlite", STORAGE_DATABASE_FILE],
    ["change-tracking.sqlite", CHANGE_LEDGER_DATABASE_FILE],
  ] as const)("%s and its WAL and SHM are created 0600", async (_label, file) => {
    const directory = await dataDir();
    const database = opened(
      file === STORAGE_DATABASE_FILE
        ? openBackendDatabase(directory)
        : openChangeLedgerDatabase(directory),
    );
    database.db.exec("CREATE TABLE at_rest_probe (id INTEGER)");

    for (const suffix of ["", "-wal", "-shm"]) {
      expect(await mode(path.join(directory, `${file}${suffix}`))).toBe(0o600);
    }
  });

  test("every open tightens the database and companions that are already wide", async () => {
    const directory = await dataDir();
    // Held open so its WAL and SHM stay on disk for the second open to find.
    const first = opened(openBackendDatabase(directory));
    first.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Keep the WAL" }]);
    const database = path.join(directory, STORAGE_DATABASE_FILE);
    await fs.writeFile(`${database}-journal`, "");
    const files = ["", "-wal", "-shm", "-journal"].map((suffix) => `${database}${suffix}`);
    for (const file of files) await fs.chmod(file, 0o644);

    opened(openBackendDatabase(directory));

    for (const file of files) expect(await mode(file)).toBe(0o600);
  });

  test("an open leaves the target of a symlinked companion alone", async () => {
    const directory = await dataDir();
    const outside = path.join(directory, "outside");
    await fs.writeFile(outside, "");
    await fs.chmod(outside, 0o644);
    await fs.symlink(outside, path.join(directory, `${STORAGE_DATABASE_FILE}-journal`));

    // SQLite itself refuses a symlinked journal, so the open fails either way.
    expect(() => opened(openBackendDatabase(directory))).toThrow();

    expect(await mode(outside)).toBe(0o644);
  });
});

describe("config.json, which holds the provider secrets", () => {
  test("each save writes the file and every backup 0600", async () => {
    const directory = await dataDir();
    const storage = await startedService(directory);
    // One save per key per generation fills the ladder.
    for (let generation = 0; generation <= MAX_JSON_BACKUPS; generation += 1) {
      await saveFakeSecrets(storage, generation);
    }

    const config = path.join(directory, "config.json");
    expect(await mode(config)).toBe(0o600);
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      expect(await mode(`${config}.bak.${index}`)).toBe(0o600);
    }
  });

  test("a start tightens a wide file and its backups without waiting for a save", async () => {
    const directory = await dataDir();
    const first = await startedService(directory);
    for (let generation = 0; generation < 2; generation += 1) {
      await saveFakeSecrets(first, generation);
    }
    first.close();
    const config = path.join(directory, "config.json");
    const files = [config, `${config}.bak.1`, `${config}.bak.2`];
    for (const file of files) await fs.chmod(file, 0o644);
    const untouched = await fs.readFile(config, "utf8");

    await startedService(directory);

    for (const file of files) expect(await mode(file)).toBe(0o600);
    expect(await fs.readFile(config, "utf8")).toBe(untouched);
  });

  test("a start does not fail when the file or its backups do not exist", async () => {
    const directory = await dataDir();
    await startedService(directory);
    await expect(fs.stat(path.join(directory, "config.json"))).rejects.toThrow();
  });

  test("a backup whose mode cannot be set stops neither the start nor the others", async () => {
    const directory = await dataDir();
    const config = path.join(directory, "config.json");
    await fs.writeFile(config, "{}", { mode: 0o644 });
    await fs.writeFile(`${config}.bak.2`, "{}", { mode: 0o644 });
    await fs.symlink(`${config}.bak.1`, `${config}.bak.1`);

    await startedService(directory);

    expect(await mode(config)).toBe(0o600);
    expect(await mode(`${config}.bak.2`)).toBe(0o600);
  });

  test("clearing a key leaves its old value in the backups, still 0600", async () => {
    const directory = await dataDir();
    const storage = await startedService(directory);
    await storage.setAnthropicApiKey(FAKE_SECRETS[1]!);
    await storage.setAnthropicApiKey(null);

    const config = path.join(directory, "config.json");
    expect(await fs.readFile(config, "utf8")).not.toContain(FAKE_SECRETS[1]!);
    const backups = await Promise.all(
      [1, 2].map(async (index) => ({
        text: await fs.readFile(`${config}.bak.${index}`, "utf8").catch(() => ""),
        file: `${config}.bak.${index}`,
      })),
    );
    const holding = backups.find((backup) => backup.text.includes(FAKE_SECRETS[1]!));
    expect(holding).toBeDefined();
    expect(await mode(holding!.file)).toBe(0o600);
  });
});

describe("where the provider secrets are", () => {
  test("only config.json and its backups hold them, never a database or snapshot", async () => {
    const directory = await dataDir();
    const storage = await startedService(directory);
    for (let generation = 0; generation < 2; generation += 1) {
      await saveFakeSecrets(storage, generation);
    }
    const database = storageDatabase(storage);
    database.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Worth a snapshot" }]);
    opened(openChangeLedgerDatabase(directory));
    expect(await takeHourlySnapshotIfDue(database, directory)).not.toBeNull();
    expect(await takeLedgerSnapshotIfDue(database, directory)).not.toBeNull();
    snapshotBeforeMigration(database, directory, 6);

    const holding: string[] = [];
    const files = await filesUnder(directory);
    for (const file of files) {
      const bytes = await fs.readFile(file);
      if (FAKE_SECRETS.some((secret) => bytes.includes(secret))) holding.push(file);
    }

    // Not vacuous: the scan did see the database and every kind of snapshot.
    expect(files).toContain(path.join(directory, STORAGE_DATABASE_FILE));
    expect(new Set(listStorageSnapshots(directory).map((entry) => entry.kind))).toEqual(
      new Set(["hourly", "ledger", "pre-migration"]),
    );
    expect(holding.map((file) => path.relative(directory, file)).sort()).toEqual([
      "config.json",
      "config.json.bak.1",
      "config.json.bak.2",
      "config.json.bak.3",
      "config.json.bak.4",
      "config.json.bak.5",
    ]);
    for (const file of holding) expect(await mode(file)).toBe(0o600);
  });
});

describe("database snapshots", () => {
  test("every kind is 0600 inside a 0700 directory, which a check also tightens", async () => {
    const directory = await dataDir();
    const main = opened(openBackendDatabase(directory));
    const ledger = opened(openChangeLedgerDatabase(directory));
    main.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Snapshot me" }]);
    const backups = path.join(directory, BACKUP_DIRECTORY);
    await fs.mkdir(backups, { recursive: true });
    await fs.chmod(backups, 0o755);

    await takeHourlySnapshotIfDue(main, directory);
    expect(await mode(backups)).toBe(0o700);
    await takeLedgerSnapshotIfDue(main, directory);
    snapshotBeforeMigration(main, directory, 6);
    snapshotBeforeMigration(ledger, directory, 1, Date.now(), "change-tracking-pre-migration");

    const snapshots = listStorageSnapshots(directory);
    expect(new Set(snapshots.map((entry) => entry.kind))).toEqual(
      new Set(["hourly", "ledger", "pre-migration", "ledger-pre-migration"]),
    );
    for (const entry of snapshots) expect(await mode(entry.file)).toBe(0o600);
  });
});
