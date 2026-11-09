import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  hostOpenCodeDatabaseEnvironment,
  inspectSharedOpenCodeDatabase,
  openCodeDataDirectory,
  ORKESTRATOR_OPENCODE_DB_FILE,
  resolveHostOpenCodeDatabase,
} from "./opencode-host-database.js";

/**
 * A user's own OpenCode 2 can leave `opencode.db` without the `session` table
 * the pinned OpenCode 1.x requires, and 1.x then refuses to start ("Database is
 * not empty and has no session table", 2026-11-08). These build each database
 * shape with real SQLite under a temporary XDG data directory.
 */
describe("host OpenCode database", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let dataDirectory: string;
  let shared: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-opencode-host-db-"));
    env = { HOME: path.join(root, "home"), XDG_DATA_HOME: path.join(root, "data") };
    dataDirectory = path.join(root, "data", "opencode");
    shared = path.join(dataDirectory, "opencode.db");
    await fs.mkdir(dataDirectory, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function writeDatabase(file: string, tables: string[]): void {
    const database = new Database(file, { create: true });
    try {
      database.run("PRAGMA journal_mode = WAL");
      for (const table of tables) database.run(`CREATE TABLE \`${table}\` (id TEXT PRIMARY KEY)`);
      // Materialise the WAL header even when the fixture has no schema writes.
      // Otherwise macOS SQLite cannot reopen that empty WAL database read-only.
      database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
  }

  test("reads OpenCode's data directory from XDG_DATA_HOME, else HOME", () => {
    expect(openCodeDataDirectory(env)).toBe(dataDirectory);
    expect(openCodeDataDirectory({ HOME: "/home/someone" })).toBe(
      "/home/someone/.local/share/opencode",
    );
  });

  test("shares the database when there is none yet", () => {
    expect(resolveHostOpenCodeDatabase(env)).toEqual({ kind: "shared", state: "missing" });
    expect(hostOpenCodeDatabaseEnvironment(env)).toEqual({});
  });

  test("shares an empty database and an OpenCode 1 database", () => {
    writeDatabase(shared, []);
    expect(inspectSharedOpenCodeDatabase(shared)).toBe("compatible");
    writeDatabase(shared, ["migration", "project", "session", "message", "part"]);
    expect(resolveHostOpenCodeDatabase(env)).toEqual({ kind: "shared", state: "compatible" });
    expect(hostOpenCodeDatabaseEnvironment(env)).toEqual({});
  });

  test("reads a database OpenCode closed cleanly without leaving files beside it", async () => {
    // A clean close checkpoints and removes the -wal and -shm files, and a
    // read-only open of such a WAL database used to fail with SQLITE_CANTOPEN,
    // which read as "unreadable" and kept sharing an incompatible database.
    const database = new Database(shared, { create: true });
    database.run("PRAGMA journal_mode = WAL");
    database.run("CREATE TABLE `session_v2` (id TEXT PRIMARY KEY)");
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close();
    await fs.rm(`${shared}-wal`, { force: true });
    await fs.rm(`${shared}-shm`, { force: true });
    expect(inspectSharedOpenCodeDatabase(shared)).toBe("incompatible");
    expect((await fs.readdir(dataDirectory)).sort()).toEqual(["opencode.db"]);
  });

  test("shares a database OpenCode 2 created or migrated that kept `session`", () => {
    writeDatabase(shared, ["migration", "session", "session_v2", "session_message"]);
    expect(hostOpenCodeDatabaseEnvironment(env)).toEqual({});
  });

  test("uses its own database beside one OpenCode 2 renamed `session` in, leaving it untouched", async () => {
    writeDatabase(shared, ["migration", "project", "session_v2", "session_message"]);
    const before = await fs.readFile(shared);

    expect(resolveHostOpenCodeDatabase(env)).toEqual({
      kind: "orkestrator",
      reason: "shared-incompatible",
    });
    expect(hostOpenCodeDatabaseEnvironment(env)).toEqual({
      OPENCODE_DB: ORKESTRATOR_OPENCODE_DB_FILE,
    });
    expect(await fs.readFile(shared)).toEqual(before);
    expect(await fs.readdir(dataDirectory)).not.toContain(ORKESTRATOR_OPENCODE_DB_FILE);
  });

  test("keeps using its own database once it exists, whatever the shared one is", () => {
    writeDatabase(shared, ["session"]);
    writeDatabase(path.join(dataDirectory, ORKESTRATOR_OPENCODE_DB_FILE), ["session"]);

    expect(resolveHostOpenCodeDatabase(env)).toEqual({ kind: "orkestrator", reason: "existing" });
    expect(hostOpenCodeDatabaseEnvironment(env)).toEqual({
      OPENCODE_DB: ORKESTRATOR_OPENCODE_DB_FILE,
    });
  });

  test("leaves a database the environment already names alone", () => {
    writeDatabase(shared, ["session_v2"]);
    const configured = { ...env, OPENCODE_DB: "/elsewhere/opencode.db" };

    expect(resolveHostOpenCodeDatabase(configured)).toEqual({ kind: "configured" });
    expect(hostOpenCodeDatabaseEnvironment(configured)).toEqual({});
  });

  test("leaves an unreadable database to OpenCode's own error", async () => {
    await fs.writeFile(shared, "not a sqlite database, but long enough to have a header....");

    expect(resolveHostOpenCodeDatabase(env)).toEqual({ kind: "shared", state: "unreadable" });
    expect(hostOpenCodeDatabaseEnvironment(env)).toEqual({});
  });
});
