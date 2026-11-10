import { constants, Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

/**
 * Which SQLite database a host OpenCode process Orkestrator starts opens.
 *
 * The pinned OpenCode 1.x and a user's own OpenCode 2.x both default to
 * `opencode.db` in OpenCode's data directory. 1.x refuses to start ("Database
 * is not empty and has no session table") on a database whose tables include
 * no `session`. 2.x can leave exactly that behind: in a database first written
 * by an early 2.x build (one that applied `20260730195856_optional_session_title`),
 * its migration `20260804233008_loose_psylocke` renames `session` to
 * `session_v2`. A database 2.2.5 creates, and a 1.x database it migrates, keep
 * `session` and stay usable, so only the database's own tables decide.
 *
 * The user's database is never moved, rewritten or deleted. When it is one 1.x
 * cannot open, every host OpenCode Orkestrator starts uses its own database,
 * {@link ORKESTRATOR_OPENCODE_DB_FILE}, beside it instead. That choice is
 * sticky: once the file exists it is used whatever the shared database later
 * becomes, because Orkestrator's sessions live in it.
 *
 * Containers are not involved: their OpenCode has a database of its own
 * (`container-state-layout.ts`).
 */

/**
 * Orkestrator's own OpenCode 1.x database. Relative on purpose: OpenCode
 * resolves a relative `OPENCODE_DB` against its own data directory, so the
 * process and this module cannot disagree about where it is.
 */
export const ORKESTRATOR_OPENCODE_DB_FILE = "opencode-orkestrator.db";
/** OpenCode 1.x's database file for the release channel the toolchain pins. */
const SHARED_OPENCODE_DB_FILE = "opencode.db";

const log = createLogger("native-agent.opencode");

export type SharedOpenCodeDatabaseState =
  /** No database yet; OpenCode 1.x creates a compatible one. */
  | "missing"
  /** Empty, or it has the `session` table OpenCode 1.x requires. */
  | "compatible"
  /** Tables, but no `session`: OpenCode 1.x refuses to start on it. */
  | "incompatible"
  /** It could not be read; OpenCode is left to report its own error. */
  | "unreadable";

export type HostOpenCodeDatabase =
  /** The caller's environment already names a database; it is left alone. */
  | { kind: "configured" }
  /** OpenCode's default, shared with the user's own OpenCode. */
  | { kind: "shared"; state: Exclude<SharedOpenCodeDatabaseState, "incompatible"> }
  /** Orkestrator's own database, {@link ORKESTRATOR_OPENCODE_DB_FILE}. */
  | { kind: "orkestrator"; reason: "existing" | "shared-incompatible" };

/**
 * OpenCode's data directory for a process started with `env`: the
 * `xdg-basedir` rule OpenCode itself uses, `$XDG_DATA_HOME/opencode`, else
 * `~/.local/share/opencode`.
 */
export function openCodeDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim();
  const base = dataHome ? dataHome : path.join(env.HOME?.trim() || os.homedir(), ".local", "share");
  return path.join(base, "opencode");
}

/**
 * Apply OpenCode 1.x's own start-up test to `file` without changing it: a
 * database is accepted when it has no tables (other than SQLite's internal
 * ones) or has a `session` table.
 */
export function inspectSharedOpenCodeDatabase(file: string): SharedOpenCodeDatabaseState {
  if (!existsSync(file)) return "missing";
  let tables: string[];
  try {
    tables = readTableNames(file);
  } catch (error) {
    log.warn("host-database.unreadable", { error: formatLogError(error, { message: false }) });
    return "unreadable";
  }
  return tables.length === 0 || tables.includes("session") ? "compatible" : "incompatible";
}

/**
 * The user tables in `file`, read without writing anything beside it. A
 * read-only connection can CREATE `-wal` and `-shm` on Linux, while on a
 * read-only directory it fails with `SQLITE_CANTOPEN`. Try an immutable read
 * first only when there is no WAL to ignore. Since another process can open
 * the database meanwhile, accept that snapshot only if its file metadata and
 * absent WAL stayed stable; otherwise use SQLite's normal locking and WAL.
 */
function readTableNames(file: string): string[] {
  if (!hasWriteAheadLog(file)) {
    const before = statSync(file, { bigint: true });
    try {
      const tables = queryTableNames(
        new Database(
          `${pathToFileURL(file).href}?immutable=1`,
          constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
        ),
      );
      const after = statSync(file, { bigint: true });
      if (
        !hasWriteAheadLog(file) &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs
      ) {
        return tables;
      }
    } catch {
      // A concurrent write can invalidate an immutable snapshot. Re-read with
      // normal locking instead of classifying a transient schema as final.
    }
  }
  return queryTableNames(new Database(file, { readonly: true }));
}

function queryTableNames(database: Database): string[] {
  try {
    return database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((table) => table.name);
  } finally {
    database.close();
  }
}

function hasWriteAheadLog(file: string): boolean {
  try {
    return statSync(`${file}-wal`).size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Decide which database a host OpenCode started with `env` should open. */
export function resolveHostOpenCodeDatabase(
  env: NodeJS.ProcessEnv = process.env,
): HostOpenCodeDatabase {
  if (env.OPENCODE_DB?.trim()) return { kind: "configured" };
  const dataDirectory = openCodeDataDirectory(env);
  if (existsSync(path.join(dataDirectory, ORKESTRATOR_OPENCODE_DB_FILE))) {
    return { kind: "orkestrator", reason: "existing" };
  }
  const state = inspectSharedOpenCodeDatabase(path.join(dataDirectory, SHARED_OPENCODE_DB_FILE));
  if (state === "incompatible") {
    log.info("host-database.separated", { reason: "shared-incompatible" });
    return { kind: "orkestrator", reason: "shared-incompatible" };
  }
  return { kind: "shared", state };
}

/**
 * The variables to add to `env` for a host OpenCode process: `OPENCODE_DB`
 * when it must use Orkestrator's own database, otherwise nothing.
 */
export function hostOpenCodeDatabaseEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return resolveHostOpenCodeDatabase(env).kind === "orkestrator"
    ? { OPENCODE_DB: ORKESTRATOR_OPENCODE_DB_FILE }
    : {};
}
