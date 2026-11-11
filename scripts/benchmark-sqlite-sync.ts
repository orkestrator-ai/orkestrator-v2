/**
 * SQLite sync-cost probe (docs/architecture/storage.md, "Durability and
 * deletion"; to-do 5180 task 3, retired: `git show
 * 498b68766:docs/todo/cross-cutting/5180-sqlite-durability-tiers.md`).
 *
 * Answers, for the SQLite library Bun links on this host: which sync settings a
 * fresh connection has (`fullfsync`, `checkpoint_fullfsync`), and what a commit
 * and a truncating checkpoint cost under each setting the storage layer could
 * choose. To tell which system call a commit pays for without root (fs_usage
 * and dtruss need it), it also times the raw calls through FFI: `fsync`,
 * `fcntl(F_FULLFSYNC)` and `fcntl(F_BARRIERFSYNC)` on macOS, `fsync` and
 * `fdatasync` elsewhere, interleaved with the commits. A commit that costs what
 * a raw `fsync` costs did not flush the drive cache; one that costs what
 * `F_FULLFSYNC` costs did. Timing is evidence, not proof: on macOS confirm the
 * call from the library itself with
 * `dyld_info -disassemble /usr/lib/libsqlite3.dylib` (function `_unixSync`;
 * 0x33 is `F_FULLFSYNC`, 0x55 `F_BARRIERFSYNC`). Interposing `fcntl` with
 * DYLD_INSERT_LIBRARIES does not see these calls: the system SQLite reaches
 * libc inside the shared cache.
 *
 * Every database is a throwaway file in a fresh directory under `--dir`
 * (default: the system temporary directory), removed afterwards. Point `--dir`
 * at the disk the data directory lives on; a tmpfs hides every sync cost.
 *
 *   bun scripts/benchmark-sqlite-sync.ts [--dir=<path>] [--commits=200]
 *     [--checkpoints=20] [--json]
 */
import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { release, tmpdir } from "node:os";
import path from "node:path";

const F_FULLFSYNC = 51;
const F_BARRIERFSYNC = 85;

function argument(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found === undefined ? fallback : found.slice(prefix.length);
}

const options = {
  dir: argument("dir", tmpdir()),
  commits: Number(argument("commits", "200")),
  checkpoints: Number(argument("checkpoints", "20")),
  json: process.argv.includes("--json"),
};

interface Timing {
  count: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  perSecond: number;
}

function summarize(samples: number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    count: samples.length,
    meanMs: round(total / samples.length),
    medianMs: round(at(0.5)),
    p95Ms: round(at(0.95)),
    perSecond: Math.round(samples.length / (total / 1000)),
  };
}

function scratch(label: string): string {
  return mkdtempSync(path.join(options.dir, `ork-sqlite-sync-${label}-`));
}

interface Variant {
  name: string;
  pragmas: string[];
}

/** The storage layer's own settings (StorageDatabase), varying only the sync axis. */
const BASE = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA secure_delete = ON",
  "PRAGMA journal_size_limit = 8388608",
];

const VARIANTS: Variant[] = [
  { name: "FULL, fullfsync off (main database today)", pragmas: ["PRAGMA synchronous = FULL"] },
  {
    name: "FULL, fullfsync on",
    pragmas: ["PRAGMA synchronous = FULL", "PRAGMA fullfsync = ON"],
  },
  { name: "NORMAL (change ledger today)", pragmas: ["PRAGMA synchronous = NORMAL"] },
  { name: "OFF (no sync; floor)", pragmas: ["PRAGMA synchronous = OFF"] },
];

function rawSyncCalls(libc: ReturnType<typeof openLibc>): Record<string, (fd: number) => number> {
  const symbols = libc.symbols as unknown as {
    fsync(fd: number): number;
    fdatasync?(fd: number): number;
    fcntl(fd: number, cmd: number): number;
  };
  return process.platform === "darwin"
    ? {
        "raw fsync": (fd) => symbols.fsync(fd),
        "raw F_FULLFSYNC": (fd) => symbols.fcntl(fd, F_FULLFSYNC),
        "raw F_BARRIERFSYNC": (fd) => symbols.fcntl(fd, F_BARRIERFSYNC),
      }
    : {
        "raw fsync": (fd) => symbols.fsync(fd),
        "raw fdatasync": (fd) => symbols.fdatasync!(fd),
      };
}

function openLibc() {
  return dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    fsync: { args: [FFIType.i32], returns: FFIType.i32 },
    // fcntl is variadic; the two commands timed here take no third argument.
    fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    ...(process.platform === "darwin"
      ? {}
      : { fdatasync: { args: [FFIType.i32], returns: FFIType.i32 } }),
  });
}

/**
 * One-row commits under each variant and raw sync calls after a 4 KiB append,
 * interleaved in one loop so every series sees the same device state. Timed
 * in separate loops, back-to-back `F_FULLFSYNC` calls and commits drift apart
 * by more than the difference being measured.
 */
function commitAndRawCost(): Record<string, Timing> {
  const directory = scratch("commit");
  const libc = openLibc();
  const databases: Database[] = [];
  const fds: number[] = [];
  try {
    // `prepare` runs untimed before each `timed` call.
    const series: Array<{
      name: string;
      prepare: () => void;
      timed: () => void;
      samples: number[];
    }> = [];
    const body = "x".repeat(200);
    for (const [index, variant] of VARIANTS.entries()) {
      const db = new Database(path.join(directory, `variant-${index}.sqlite`));
      databases.push(db);
      for (const pragma of [...BASE, ...variant.pragmas]) db.exec(pragma);
      db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
      const insert = db.query("INSERT INTO rows (body) VALUES (?)");
      series.push({
        name: variant.name,
        prepare: () => {},
        timed: () => void insert.run(body),
        samples: [],
      });
    }
    const page = Buffer.alloc(4096, 7);
    for (const [name, call] of Object.entries(rawSyncCalls(libc))) {
      const fd = openSync(path.join(directory, `raw-${fds.length}`), "w");
      fds.push(fd);
      series.push({
        name,
        // The append is untimed, as a commit's WAL frame write precedes its sync.
        prepare: () => void writeSync(fd, page),
        timed: () => {
          if (call(fd) !== 0) throw new Error(`${name} failed`);
        },
        samples: [],
      });
    }
    for (let i = 0; i < options.commits; i++) {
      for (const entry of series) {
        entry.prepare();
        const started = performance.now();
        entry.timed();
        entry.samples.push(performance.now() - started);
      }
    }
    return Object.fromEntries(series.map((entry) => [entry.name, summarize(entry.samples)]));
  } finally {
    for (const db of databases) db.close();
    for (const fd of fds) closeSync(fd);
    libc.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A truncating checkpoint after 50 commits, as the scrub runs one. */
function checkpointCost(checkpointFullfsync: boolean): Timing {
  const directory = scratch("checkpoint");
  const db = new Database(path.join(directory, "probe.sqlite"));
  try {
    for (const pragma of [...BASE, "PRAGMA synchronous = FULL"]) db.exec(pragma);
    db.exec(`PRAGMA checkpoint_fullfsync = ${checkpointFullfsync ? "ON" : "OFF"}`);
    db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    const insert = db.query("INSERT INTO rows (body) VALUES (?)");
    const body = "x".repeat(200);
    const samples: number[] = [];
    for (let round = 0; round < options.checkpoints; round++) {
      for (let i = 0; i < 50; i++) insert.run(body);
      const started = performance.now();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      samples.push(performance.now() - started);
    }
    return summarize(samples);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function library(): Record<string, unknown> {
  const db = new Database(":memory:");
  try {
    const compileOptions = (
      db.query("PRAGMA compile_options").all() as { compile_options: string }[]
    )
      .map((row) => row.compile_options)
      .filter((option) => /SYNC|CODEC|CCCRYPT|LOCKING_STYLE/.test(option));
    const file = scratch("defaults");
    const fileDb = new Database(path.join(file, "probe.sqlite"));
    try {
      fileDb.exec("PRAGMA journal_mode = WAL");
      fileDb.exec("PRAGMA synchronous = FULL");
      return {
        sqliteVersion: (db.query("SELECT sqlite_version() AS v").get() as { v: string }).v,
        sourceId: (db.query("SELECT sqlite_source_id() AS v").get() as { v: string }).v,
        syncCompileOptions: compileOptions,
        defaults: {
          fullfsync: (fileDb.query("PRAGMA fullfsync").get() as { fullfsync: number }).fullfsync,
          checkpoint_fullfsync: (
            fileDb.query("PRAGMA checkpoint_fullfsync").get() as { checkpoint_fullfsync: number }
          ).checkpoint_fullfsync,
        },
      };
    } finally {
      fileDb.close();
      rmSync(file, { recursive: true, force: true });
    }
  } finally {
    db.close();
  }
}

const report = {
  host: { platform: process.platform, arch: process.arch, osRelease: release(), bun: Bun.version },
  dir: options.dir,
  library: library(),
  commits: commitAndRawCost(),
  truncatingCheckpoint: {
    "checkpoint_fullfsync on": checkpointCost(true),
    "checkpoint_fullfsync off": checkpointCost(false),
  },
};

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `${report.host.platform} ${report.host.arch}, OS ${report.host.osRelease}, Bun ${report.host.bun}`,
  );
  console.log(`dir: ${report.dir}`);
  console.log(JSON.stringify(report.library, null, 2));
  const table = (title: string, rows: Record<string, Timing>) => {
    console.log(`\n${title}`);
    for (const [name, timing] of Object.entries(rows)) {
      console.log(
        `  ${name.padEnd(44)} mean ${timing.meanMs.toFixed(3)} ms  median ${timing.medianMs.toFixed(3)} ms  p95 ${timing.p95Ms.toFixed(3)} ms  ${timing.perSecond}/s`,
      );
    }
  };
  table(`one-row commit and raw sync call, interleaved (${options.commits} each)`, report.commits);
  table(
    `TRUNCATE checkpoint after 50 commits (${options.checkpoints} each)`,
    report.truncatingCheckpoint,
  );
}
