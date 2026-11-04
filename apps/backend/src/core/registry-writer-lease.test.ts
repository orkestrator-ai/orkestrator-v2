import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import {
  REGISTRY_SCHEMA_MARKER_FILE,
  REGISTRY_WRITER_LEASE_FILE,
  RegistryWriterLease,
  openRegistryWriter,
  type RegistryWriter,
} from "./registry-writer-lease.js";

let directory: string;
let logs: LogCapture;
const writers: RegistryWriter[] = [];

const leaseRecords = () =>
  logs.records().filter((record) => record.event?.startsWith("writer-lease."));

async function replaceLease(token: string): Promise<void> {
  await fs.writeFile(
    path.join(directory, REGISTRY_WRITER_LEASE_FILE),
    JSON.stringify({ token, pid: 1, acquiredAt: "2026-11-03T00:00:00.000Z" }),
  );
}

async function open(options?: Parameters<typeof RegistryWriterLease.acquire>[1]) {
  const lease = await RegistryWriterLease.acquire(directory, options);
  writers.push(lease);
  return lease;
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-writer-lease-"));
  logs = captureLogs();
});

afterEach(async () => {
  for (const writer of writers.splice(0)) await writer.release();
  logs.restore();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("registry writer lease logging", () => {
  test("a held lease writes nothing however often it is checked", async () => {
    const lease = await open();
    for (let check = 0; check < 5; check += 1) expect(lease.isHeld()).toBe(true);
    expect(leaseRecords()).toEqual([]);
  });

  test("losing the lease warns once, not on every scheduled tick", async () => {
    const lease = await open();
    await replaceLease("another-backend");
    for (let tick = 0; tick < 5; tick += 1) expect(lease.isHeld()).toBe(false);
    expect(() => lease.assertHeld()).toThrow();
    expect(leaseRecords()).toMatchObject([
      {
        level: "warn",
        area: "docker",
        event: "writer-lease.lost",
        fields: { reason: "reclaimed" },
      },
    ]);
    expect(Object.keys(leaseRecords()[0]!.fields ?? {})).toEqual(["reason"]);
  });

  test("a missing or malformed lease file reads as unreadable, and warns once", async () => {
    const missing = await open();
    await fs.rm(path.join(directory, REGISTRY_WRITER_LEASE_FILE));
    expect(missing.isHeld()).toBe(false);
    expect(missing.isHeld()).toBe(false);
    expect(leaseRecords()).toMatchObject([
      { level: "warn", event: "writer-lease.lost", fields: { reason: "unreadable" } },
    ]);
  });

  test("a heartbeat that finds the lease gone warns once, and a later check adds nothing", async () => {
    const lease = await open({ heartbeatMs: 5 });
    await replaceLease("another-backend");
    for (let attempt = 0; attempt < 200 && leaseRecords().length === 0; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(lease.isHeld()).toBe(false);
    await Bun.sleep(25);
    expect(leaseRecords()).toMatchObject([
      { level: "warn", event: "writer-lease.lost", fields: { reason: "reclaimed" } },
    ]);
  });

  test("a release is not a loss, even with a heartbeat reading as it happens", async () => {
    const lease = await open({ heartbeatMs: 1 });
    await Bun.sleep(5);
    await lease.release();
    expect(lease.isHeld()).toBe(false);
    await Bun.sleep(10);
    expect(leaseRecords()).toEqual([]);
  });

  test("a lost lease is never regained in this process", async () => {
    const lease = await open();
    const leasePath = path.join(directory, REGISTRY_WRITER_LEASE_FILE);
    const held = await fs.readFile(leasePath, "utf8");
    await replaceLease("another-backend");
    expect(lease.isHeld()).toBe(false);
    await fs.writeFile(leasePath, held);
    expect(lease.isHeld()).toBe(false);
    expect(leaseRecords()).toHaveLength(1);
  });

  test("a backend that starts without the lease writes one info, and none on later checks", async () => {
    const first = await openRegistryWriter(directory);
    writers.push(first);
    expect(leaseRecords()).toEqual([]);
    const second = await openRegistryWriter(directory);
    writers.push(second);
    for (let tick = 0; tick < 5; tick += 1) expect(second.isHeld()).toBe(false);
    expect(leaseRecords()).toMatchObject([
      { level: "info", event: "writer-lease.not-acquired", fields: { reason: "busy" } },
    ]);
  });

  test("a directory written by a newer backend is a distinct reason", async () => {
    await fs.writeFile(
      path.join(directory, REGISTRY_SCHEMA_MARKER_FILE),
      JSON.stringify({ schemaVersion: 99, minimumWriterVersion: 99, updatedAt: "" }),
    );
    const writer = await openRegistryWriter(directory);
    writers.push(writer);
    expect(writer.isHeld()).toBe(false);
    expect(leaseRecords()).toMatchObject([
      {
        level: "info",
        event: "writer-lease.not-acquired",
        fields: { reason: "schema-incompatible" },
      },
    ]);
  });
});
