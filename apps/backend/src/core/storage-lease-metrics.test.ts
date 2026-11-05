import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LeaseWaitMetrics,
  MAX_LEASE_FAMILIES,
  leaseFamily,
  leaseLogName,
  leaseWaitMetrics,
} from "./storage-lease-metrics.js";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";

const directories: string[] = [];
const open: StorageDatabase[] = [];
let logs: LogCapture;

async function database(): Promise<StorageDatabase> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-lease-metrics-"));
  directories.push(directory);
  const opened = openBackendDatabase(directory);
  open.push(opened);
  return opened;
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

describe("lease families", () => {
  test("a keyed lease counts under its family, without its key", () => {
    expect(leaseFamily("native-agent-session-leases/abc123")).toBe("native-agent-session-leases");
    expect(leaseFamily("project-creation-locks/deadbeef")).toBe("project-creation-locks");
    expect(leaseFamily("environments.json")).toBe("environments.json");
    expect(leaseFamily("storage-backup")).toBe("storage-backup");
  });

  test("a path or an id never becomes a label", () => {
    expect(leaseFamily("/home/someone/project/.lock")).toBe("outside-data-dir");
    expect(leaseFamily("C:\\Users\\someone\\lock")).toBe("outside-data-dir");
    expect(leaseFamily("store-123e4567-e89b-12d3-a456-426614174000")).toBe("store-*");
    expect(leaseFamily("has space/thing")).toBe("other");
    expect(leaseLogName("/home/someone/project/.lock")).toBe("outside-data-dir");
    expect(leaseLogName("environments.json")).toBe("environments.json");
  });

  test("buckets, totals and the family table stay bounded", () => {
    const metrics = new LeaseWaitMetrics();
    metrics.acquired("a/1", 0);
    metrics.acquired("a/2", 30);
    metrics.timedOut("a/3", 60_000);
    const family = metrics.snapshot().families.a!;
    expect(family).toMatchObject({
      acquired: 2,
      timedOut: 1,
      totalWaitMs: 60_030,
      maxWaitMs: 60_000,
    });
    expect(family.buckets.reduce((sum, count) => sum + count, 0)).toBe(3);
    expect(family.buckets[0]).toBe(1);
    expect(family.buckets.at(-1)).toBe(1);

    for (let index = 0; index < MAX_LEASE_FAMILIES + 10; index += 1) {
      metrics.acquired(`family-${index}`, 1);
    }
    const { families, overflowed } = metrics.snapshot();
    expect(Object.keys(families).length).toBeLessThanOrEqual(MAX_LEASE_FAMILIES + 1);
    expect(overflowed).toBeGreaterThan(0);
    expect(families.other?.acquired).toBe(overflowed);
  });
});

describe("acquireLease", () => {
  test("a wait is recorded under the lease's family", async () => {
    const db = await database();
    const family = "lease-metrics-acquire";
    const release = await db.acquireLease(`${family}/one`, "test");
    await release();
    expect(leaseWaitMetrics.snapshot().families[family]?.acquired).toBe(1);
  });

  test("a timeout logs the lease's name and holder age, and is counted", async () => {
    const db = await database();
    const name = "lease-metrics-timeout/held";
    const release = await db.acquireLease(name, "test", { staleMs: 60_000 });
    const before = leaseWaitMetrics.snapshot().families["lease-metrics-timeout"]?.timedOut ?? 0;
    await expect(db.acquireLease(name, "test", { acquireTimeoutMs: 30 })).rejects.toThrow(
      "Timed out waiting for test lock",
    );
    await release();

    const line = logs.records().find((record) => record.event === "lease.timed-out");
    expect(line?.level).toBe("warn");
    expect(line?.fields).toMatchObject({
      lease: name,
      family: "lease-metrics-timeout",
    });
    expect(line?.fields?.holderAgeMs).toBeGreaterThanOrEqual(0);
    expect(line?.fields?.waitedMs).toBeGreaterThanOrEqual(30);
    expect(leaseWaitMetrics.snapshot().families["lease-metrics-timeout"]?.timedOut).toBe(
      before + 1,
    );
  });

  test("a timeout never logs a path outside the data directory", async () => {
    const db = await database();
    const name = "/home/someone/secret-project/.lock";
    const release = await db.acquireLease(name, "test", { staleMs: 60_000 });
    await expect(db.acquireLease(name, "test", { acquireTimeoutMs: 30 })).rejects.toThrow();
    await release();
    expect(logs.lines.join("\n")).not.toContain("secret-project");
  });
});
