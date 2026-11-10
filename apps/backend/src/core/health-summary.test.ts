import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HEALTH_SAMPLE_MAX_JOB_KINDS,
  HEALTH_SUMMARY_MAX_ROWS,
  HealthSummary,
  previousRunOf,
  readHealthRows,
  topJobKinds,
  type HealthRow,
  type HealthSummaryOptions,
} from "./health-summary.js";
import { BridgeRestartCounter, bridgeRestarts } from "./bridge-restarts.js";
import { HEALTH_SUMMARY_STORE } from "./health-summary-layout.js";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import type { RecurringWorkSnapshot } from "@orkestrator/protocol/recurring-work";

const directories: string[] = [];
const open: StorageDatabase[] = [];
let logs: LogCapture;

async function database(): Promise<StorageDatabase> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-health-summary-"));
  directories.push(directory);
  const opened = openBackendDatabase(directory);
  open.push(opened);
  return opened;
}

const quietWork = (): RecurringWorkSnapshot => ({ kinds: {} }) as unknown as RecurringWorkSnapshot;

function summary(db: StorageDatabase, options: Partial<HealthSummaryOptions> = {}): HealthSummary {
  return new HealthSummary({
    database: () => db,
    recurringWork: quietWork,
    bridgeRestarts: () => ({}),
    isAlive: () => false,
    intervalMs: 3_600_000,
    ...options,
  });
}

beforeEach(() => {
  logs = captureLogs();
});

afterEach(async () => {
  logs.restore();
  for (const opened of open.splice(0)) opened.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function previousRunLines() {
  return logs.records().filter((record) => record.event === "previous-run");
}

describe("health summary samples", () => {
  test("a row holds numbers and job kinds only", async () => {
    const db = await database();
    const health = summary(db, {
      now: () => 1_000,
      pid: 7,
      memory: () => ({ rss: 11, heapUsed: 12, heapTotal: 13, external: 14 }),
      cpu: () => ({ user: 5_000, system: 2_000 }),
      recurringWork: () =>
        ({
          kinds: {
            "tab-cleanup": { started: 3, failed: 1, active: 0, duration: { totalMs: 40 } },
          },
        }) as unknown as RecurringWorkSnapshot,
    });
    health.sample();

    const [row] = readHealthRows(db);
    expect(row).toMatchObject({
      kind: "sample",
      at: 1_000,
      pid: 7,
      startedAt: 1_000,
      rssBytes: 11,
      heapUsedBytes: 12,
      heapTotalBytes: 13,
      externalBytes: 14,
      cpuUserMs: 5,
      cpuSystemMs: 2,
      jobs: { "tab-cleanup": { started: 3, failed: 1, active: 0, totalMs: 40 } },
    });
    const strings: string[] = [];
    JSON.stringify(row, (key, value: unknown) => {
      if (typeof value === "string") strings.push(`${key}=${value}`);
      return value;
    });
    expect(strings).toEqual(["kind=sample"]);
  });

  test("a row counts bridge starts and unrequested exits per provider, as numbers", async () => {
    const db = await database();
    const counter = new BridgeRestartCounter();
    const health = summary(db, { bridgeRestarts: () => counter.snapshot() });
    counter.localStarted("codex:env-1");
    counter.localExited("codex:env-1", false);
    counter.localStarted("codex:env-1");
    counter.containerLaunched("claude");
    health.sample();

    const [row] = readHealthRows(db);
    expect(row).toMatchObject({
      kind: "sample",
      bridges: {
        codex: { localStarts: 2, localUnrequestedExits: 1, containerLaunches: 0 },
        claude: { localStarts: 0, localUnrequestedExits: 0, containerLaunches: 1 },
      },
    });
    const strings: string[] = [];
    JSON.stringify(row, (key, value: unknown) => {
      if (typeof value === "string") strings.push(`${key}=${value}`);
      return value;
    });
    expect(strings).toEqual(["kind=sample"]);
  });

  test("by default a row reads the process-wide bridge counter", async () => {
    const db = await database();
    bridgeRestarts.reset();
    try {
      const health = new HealthSummary({
        database: () => db,
        recurringWork: quietWork,
        isAlive: () => false,
        intervalMs: 3_600_000,
      });
      bridgeRestarts.containerLaunched("pi");
      health.sample();
      expect(readHealthRows(db)[0]).toMatchObject({
        bridges: { pi: { containerLaunches: 1 } },
      });
    } finally {
      bridgeRestarts.reset();
    }
  });

  test("the timer writes a row per interval, and stop ends them", async () => {
    const db = await database();
    const health = summary(db, { intervalMs: 5 });
    health.start();
    await Bun.sleep(40);
    health.stop();
    const samples = readHealthRows(db).filter((row) => row.kind === "sample").length;
    expect(samples).toBeGreaterThan(1);
    await Bun.sleep(20);
    expect(readHealthRows(db).filter((row) => row.kind === "sample").length).toBe(samples);
  });

  test("pruning keeps the newest rows at the bound, in the write's own transaction", async () => {
    const db = await database();
    let now = 1_000;
    const health = summary(db, { now: () => now, maxRows: 3 });
    for (let index = 0; index < 5; index += 1) {
      now += 10;
      health.sample();
    }
    expect(readHealthRows(db).map((row) => row.at)).toEqual([1_030, 1_040, 1_050]);
  });

  test("the default bound is seven days of samples", () => {
    expect(HEALTH_SUMMARY_MAX_ROWS).toBe(2_016);
  });

  test("a row lists only the job kinds with the most run time", () => {
    const kinds = Object.fromEntries(
      Array.from({ length: HEALTH_SAMPLE_MAX_JOB_KINDS + 3 }, (_, index) => [
        `kind-${index}`,
        { started: 1, failed: 0, active: 0, duration: { totalMs: index } },
      ]),
    );
    const jobs = topJobKinds({ kinds } as unknown as RecurringWorkSnapshot);
    expect(Object.keys(jobs)).toHaveLength(HEALTH_SAMPLE_MAX_JOB_KINDS);
    expect(jobs).toHaveProperty(`kind-${HEALTH_SAMPLE_MAX_JOB_KINDS + 2}`);
    expect(jobs).not.toHaveProperty("kind-0");
  });

  test("a failed write is logged and never throws", async () => {
    const db = await database();
    const health = summary(db);
    db.close();
    const failing = new HealthSummary({
      database: () => {
        throw new Error("no database");
      },
      recurringWork: quietWork,
    });
    expect(() => failing.sample()).not.toThrow();
    expect(() => health.sample()).not.toThrow();
    expect(logs.records().some((record) => record.event === "health.write-failed")).toBe(true);
  });
});

describe("the clean shutdown marker", () => {
  test("after a clean exit the next start logs previous-run clean", async () => {
    const db = await database();
    let now = 10_000;
    const first = summary(db, { now: () => now, pid: 101 });
    expect(first.start()).toEqual({ outcome: "none" });
    expect(previousRunLines()).toHaveLength(0);
    now += 500;
    first.recordCleanExit();
    now += 1_000;

    const second = summary(db, { now: () => now, pid: 102 });
    expect(second.start()).toEqual({ outcome: "clean", ranForMs: 500, lastSeenAgoMs: 1_000 });
    second.stop();

    const [line] = previousRunLines();
    expect(line).toMatchObject({ level: "info", fields: { outcome: "clean" } });
    expect(readHealthRows(db).map((row) => row.kind)).toEqual(["started", "clean-exit", "started"]);
  });

  test("with no clean exit the next start logs previous-run crashed", async () => {
    const db = await database();
    let now = 10_000;
    const crashed = summary(db, { now: () => now, pid: 201 });
    crashed.start();
    now += 300;
    crashed.sample();
    // A kill or a power loss: the process simply stops here.
    crashed.stop();
    now += 700_000;

    const next = summary(db, { now: () => now, pid: 202 });
    expect(next.start()).toEqual({ outcome: "crashed", ranForMs: 300, lastSeenAgoMs: 700_000 });
    next.stop();

    const [line] = previousRunLines();
    expect(line).toMatchObject({
      level: "warn",
      fields: { outcome: "crashed", ranForMs: 300, lastSeenAgoMs: 700_000 },
    });
  });

  test("a stopped summary writes no marker of its own", async () => {
    const db = await database();
    const health = summary(db);
    health.start();
    health.stop();
    expect(readHealthRows(db).map((row) => row.kind)).toEqual(["started"]);
    // Never started: there is nothing to mark.
    summary(db).recordCleanExit();
    expect(readHealthRows(db).map((row) => row.kind)).toEqual(["started"]);
  });
});

describe("previousRunOf", () => {
  const self = { pid: 1, startedAt: 9_000 };
  const row = (kind: HealthRow["kind"], at: number, pid: number, startedAt: number) =>
    ({ kind, at, pid, startedAt }) as HealthRow;

  test("skips another backend that is still running", () => {
    const rows = [
      row("started", 1_000, 2, 1_000),
      row("clean-exit", 2_000, 2, 1_000),
      row("started", 8_000, 3, 8_000),
    ];
    expect(previousRunOf(rows, self, 9_000, (pid) => pid === 3).outcome).toBe("clean");
  });

  test("a live pid with an old last row is a reused pid, so that run crashed", () => {
    const rows = [row("started", 1_000, 3, 1_000)];
    expect(previousRunOf(rows, self, 100_000_000, () => true).outcome).toBe("crashed");
  });

  test("this backend's own rows do not count, and a first start has no previous run", () => {
    expect(previousRunOf([row("started", 9_000, 1, 9_000)], self, 9_000, () => false)).toEqual({
      outcome: "none",
    });
  });

  test("a run whose started row was pruned still counts from its samples", () => {
    const rows = [row("sample", 5_000, 4, 1_000)];
    expect(previousRunOf(rows, self, 9_000_000, () => false)).toEqual({
      outcome: "crashed",
      ranForMs: 4_000,
      lastSeenAgoMs: 8_995_000,
    });
  });

  test("an unreadable row is skipped", async () => {
    const db = await database();
    db.transaction(() => {
      db.rows(HEALTH_SUMMARY_STORE).put("bad", "not json");
      db.rows(HEALTH_SUMMARY_STORE).put("worse", JSON.stringify({ kind: "sample" }));
    });
    expect(readHealthRows(db)).toEqual([]);
  });
});
