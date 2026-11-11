import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { releaseFreePagesInChildProcess } from "./storage-backups.js";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";

const directories: string[] = [];
const databases: StorageDatabase[] = [];

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-release-"));
  directories.push(directory);
  const main = openBackendDatabase(directory);
  databases.push(main);
  main.writeStore("kanban", [{ id: "live", projectId: "p1", title: "original" }]);
  main.db.exec(
    "CREATE TABLE waste (value BLOB); INSERT INTO waste VALUES (zeroblob(200000)); DROP TABLE waste",
  );
  expect(main.releasableFreePages()).toBeGreaterThan(20);
  return { directory, main };
}

/**
 * Keep the real supervisor and SQLite helper. Replace only the helper's existing
 * between-step sleep with a file handshake, so host scheduling cannot move the
 * backend's commit/lock outside the intended gap between vacuum transactions.
 * No global mocks or production-only test hooks are needed.
 */
function stepGate(directory: string) {
  const marker = (step: number) => path.join(directory, `step-${step}`);
  const resume = (step: number) => path.join(directory, `resume-${step}`);
  const spawnGated = (command: string, args: string[], options: SpawnOptions) => {
    const prelude = `
      const gateFs = require("node:fs");
      const gatePath = require("node:path");
      const gateSleep = Bun.sleepSync.bind(Bun);
      let gateStep = 0;
      Bun.sleepSync = () => {
        const step = ++gateStep;
        gateFs.writeFileSync(gatePath.join(${JSON.stringify(directory)}, "step-" + step), String(process.pid));
        const until = Date.now() + 15000;
        while (!gateFs.existsSync(gatePath.join(${JSON.stringify(directory)}, "resume-" + step))) {
          if (Date.now() >= until) throw new Error("test gate timed out");
          gateSleep(5);
        }
      };
    `;
    const gatedArgs = args.slice();
    // -e, supervisor, --, timeoutMs, helper, ...helperArgs
    gatedArgs[4] = prelude + args[4];
    return spawn(command, gatedArgs, options);
  };
  return {
    spawn: spawnGated,
    async wait(step: number) {
      const until = Date.now() + 10_000;
      while (!existsSync(marker(step))) {
        if (Date.now() >= until) throw new Error(`Release never reached step ${step}`);
        await Bun.sleep(5);
      }
      return Number(await fs.readFile(marker(step), "utf8"));
    },
    resume: (step: number) => fs.writeFile(resume(step), ""),
    async unblock() {
      await Promise.all([1, 2, 3].map((step) => fs.writeFile(resume(step), "")));
    },
  };
}

/**
 * The real supervisor and helper, with only the selected vacuum or checkpoint
 * taking `ms` longer, as it does when the disk is busy.
 */
function slowStepSpawn(operation: "vacuum" | "checkpoint", step: number, ms: number) {
  return (command: string, args: string[], options: SpawnOptions) => {
    const prelude = `
      const slowSqlite = require("bun:sqlite");
      const slowExec = slowSqlite.Database.prototype.exec;
      let slowStep = 0;
      if (${JSON.stringify(operation)} === "vacuum") slowSqlite.Database.prototype.exec = function (sql, ...rest) {
        const result = slowExec.call(this, sql, ...rest);
        if (String(sql).includes("incremental_vacuum") && ++slowStep === ${step}) Bun.sleepSync(${ms});
        return result;
      };
      if (${JSON.stringify(operation)} === "checkpoint") {
        const slowQuery = slowSqlite.Database.prototype.query;
        slowSqlite.Database.prototype.query = function (sql, ...rest) {
          const statement = slowQuery.call(this, sql, ...rest);
          if (!String(sql).includes("wal_checkpoint")) return statement;
          const get = statement.get.bind(statement);
          statement.get = (...args) => {
            const result = get(...args);
            if (++slowStep === ${step}) Bun.sleepSync(${ms});
            return result;
          };
          return statement;
        };
      }
    `;
    const slowed = args.slice();
    // -e, supervisor, --, timeoutMs, helper, ...helperArgs
    slowed[4] = prelude + args[4];
    return spawn(command, slowed, options);
  };
}

function checkRetainedData(file: string, title: string) {
  // Verify through a new connection after the worker has closed its own.
  const copy = new Database(file, { readonly: true });
  try {
    expect(copy.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    const rows = copy.query("SELECT value FROM store_rows WHERE store = 'kanban'").all() as {
      value: string;
    }[];
    expect(rows.map((row) => JSON.parse(row.value))).toEqual([
      { id: "live", projectId: "p1", title },
    ]);
  } finally {
    copy.close();
  }
}

afterEach(async () => {
  for (const database of databases.splice(0).reverse()) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("free-page release with live backend writes", () => {
  test("pins checkpoint synchronization on the helper connection before releasing pages", async () => {
    const { main } = await fixture();
    const before = main.releasableFreePages();
    const spawnChecked = (command: string, args: string[], options: SpawnOptions) => {
      // Start the real helper with the opposite build default, including on
      // macOS where DEFAULT_CKPTFULLFSYNC would otherwise hide a missing pin.
      const prelude = `
        const { Database: CheckedDatabase } = require("bun:sqlite");
        const checkedExec = CheckedDatabase.prototype.exec;
        const checkedQuery = CheckedDatabase.prototype.query;
        const initialized = new WeakSet();
        CheckedDatabase.prototype.exec = function (sql, ...rest) {
          if (!initialized.has(this)) {
            initialized.add(this);
            checkedExec.call(this, "PRAGMA checkpoint_fullfsync = OFF");
          }
          return checkedExec.call(this, sql, ...rest);
        };
        CheckedDatabase.prototype.query = function (sql, ...rest) {
          if (String(sql).includes("wal_checkpoint")) {
            for (const [pragma, expected] of [
              ["checkpoint_fullfsync", 1], ["synchronous", 2],
              ["secure_delete", 1], ["journal_size_limit", 8388608],
            ]) {
              const row = checkedQuery.call(this, "PRAGMA " + pragma).get();
              if (Object.values(row)[0] !== expected) throw new Error("helper setting: " + pragma);
            }
          }
          return checkedQuery.call(this, sql, ...rest);
        };
      `;
      const checkedArgs = args.slice();
      // -e, supervisor, --, timeoutMs, helper, ...helperArgs
      checkedArgs[4] = prelude + args[4];
      return spawn(command, checkedArgs, options);
    };
    expect(
      await releaseFreePagesInChildProcess(main.path, {
        spawn: spawnChecked,
        maxPages: 4,
        stepPages: 4,
        pauseMs: 0,
        slowStepMs: 60_000,
      }),
    ).toEqual({ released: 4, left: before - 4, stop: "budget" });
    checkRetainedData(main.path, "original");
  });

  test("commits backend writes between successful release steps and retains live data", async () => {
    const { directory, main } = await fixture();
    const before = main.releasableFreePages();
    const gate = stepGate(directory);
    const release = releaseFreePagesInChildProcess(main.path, {
      spawn: gate.spawn,
      maxPages: 12,
      stepPages: 4,
      // Every step must run here, however slow the host's disk is.
      slowStepMs: 60_000,
      timeoutMs: 20_000,
    });
    // Attach a rejection handler immediately, including if waiting for a gate fails.
    const outcome = release.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      for (let step = 1; step <= 3; step += 1) {
        await gate.wait(step);
        expect(main.releasableFreePages()).toBe(before - step * 4);
        main.writeStore("kanban", [{ id: "live", projectId: "p1", title: `update-${step}` }]);
        await gate.resume(step);
      }
      expect(await release).toEqual({ released: 12, left: before - 12, stop: "budget" });
      checkRetainedData(main.path, "update-3");
    } finally {
      await gate.unblock();
      await outcome;
    }
  }, 30_000);

  test("gives way to SQLITE_BUSY after making progress and can resume on the next check", async () => {
    const { directory, main } = await fixture();
    const before = main.releasableFreePages();
    const gate = stepGate(directory);
    const release = releaseFreePagesInChildProcess(main.path, {
      spawn: gate.spawn,
      maxPages: 12,
      stepPages: 4,
      slowStepMs: 60_000,
      timeoutMs: 20_000,
    });
    const outcome = release.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    let locked = false;
    try {
      await gate.wait(1);
      expect(main.releasableFreePages()).toBe(before - 4);
      main.db.exec("BEGIN IMMEDIATE");
      locked = true;
      await gate.resume(1);
      // Keep the writer lock until the child returns: its second vacuum must
      // encounter SQLITE_BUSY, rather than merely finding the lock released.
      expect(await release).toEqual({ released: 4, left: before - 4, stop: "busy" });
      main.db.exec("COMMIT");
      locked = false;
      expect(main.releasableFreePages()).toBe(before - 4);
      await expect(
        releaseFreePagesInChildProcess(main.path, { slowStepMs: 60_000 }),
      ).resolves.toEqual({
        released: before - 4,
        left: 0,
        stop: "done",
      });
      checkRetainedData(main.path, "original");
    } finally {
      if (locked) main.db.exec("ROLLBACK");
      await gate.unblock();
      await outcome;
    }
  }, 30_000);

  for (const operation of ["vacuum", "checkpoint"] as const) {
    test(`a slow ${operation} ends the run and the next check resumes it`, async () => {
      const { main } = await fixture();
      const before = main.releasableFreePages();
      // Step 2 is slower than the threshold: its pages count, then the child stops
      // instead of taking the write lock again while the disk is busy.
      expect(
        await releaseFreePagesInChildProcess(main.path, {
          spawn: slowStepSpawn(operation, 2, 1_500),
          maxPages: 12,
          stepPages: 4,
          pauseMs: 0,
          slowStepMs: 1_000,
          timeoutMs: 20_000,
        }),
      ).toEqual({ released: 8, left: before - 8, stop: "slow-step" });
      expect(main.releasableFreePages()).toBe(before - 8);
      main.writeStore("kanban", [{ id: "live", projectId: "p1", title: "after-slow-step" }]);
      expect(
        await releaseFreePagesInChildProcess(main.path, {
          maxPages: 4,
          stepPages: 4,
          slowStepMs: 60_000,
        }),
      ).toEqual({ released: 4, left: before - 12, stop: "budget" });
      checkRetainedData(main.path, "after-slow-step");
    }, 30_000);

    for (const terminal of ["done", "budget"] as const) {
      test(`a slow final ${operation} preserves the ${terminal} outcome`, async () => {
        const { main } = await fixture();
        const before = main.releasableFreePages();
        const pages = terminal === "done" ? before : 4;
        expect(
          await releaseFreePagesInChildProcess(main.path, {
            spawn: slowStepSpawn(operation, 1, 1_500),
            // Exhaustion also reaches maxPages: done must take precedence.
            maxPages: pages,
            stepPages: pages,
            pauseMs: 0,
            slowStepMs: 1_000,
            timeoutMs: 20_000,
          }),
        ).toEqual({ released: pages, left: before - pages, stop: terminal });
        expect(main.releasableFreePages()).toBe(before - pages);
        main.writeStore("kanban", [{ id: "live", projectId: "p1", title: "after-final-step" }]);
        checkRetainedData(main.path, "after-final-step");
      }, 30_000);
    }
  }

  test("the release deadline kills and reaps a worker blocked between steps", async () => {
    const { directory, main } = await fixture();
    const gate = stepGate(directory);
    const release = releaseFreePagesInChildProcess(main.path, {
      spawn: gate.spawn,
      maxPages: 12,
      stepPages: 4,
      slowStepMs: 60_000,
      timeoutMs: 3_000,
    });
    const outcome = release.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      const workerPid = await gate.wait(1);
      await expect(release).rejects.toThrow("Free-page release failed: exit 1");
      expect(() => process.kill(workerPid, 0)).toThrow();
      // A killed helper must leave a sound database that accepts more writes.
      main.writeStore("kanban", [{ id: "live", projectId: "p1", title: "survived" }]);
      checkRetainedData(main.path, "survived");
    } finally {
      await gate.unblock();
      await outcome;
    }
  }, 30_000);

  test("a non-zero release-child exit reports its SQLite error code", async () => {
    const { directory } = await fixture();
    const corrupt = path.join(directory, "not-a-database.sqlite");
    await fs.writeFile(corrupt, "This is not a SQLite database. ".repeat(200));
    await expect(releaseFreePagesInChildProcess(corrupt)).rejects.toThrow(
      "Free-page release failed: SQLITE_NOTADB",
    );
  });
});
