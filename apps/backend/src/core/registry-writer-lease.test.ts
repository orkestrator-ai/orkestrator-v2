import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import {
  REGISTRY_SCHEMA_MARKER_FILE,
  REGISTRY_WRITER_LEASE_FILE,
  ReclaimingRegistryWriter,
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

  test("taking over a stale lease writes one regained info with its age", async () => {
    await replaceLease("crashed-backend");
    const lastRefresh = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(directory, REGISTRY_WRITER_LEASE_FILE), lastRefresh, lastRefresh);
    const lease = await open({ staleMs: 30_000 });
    expect(lease.isHeld()).toBe(true);
    const records = leaseRecords();
    expect(records).toMatchObject([
      { level: "info", area: "docker", event: "writer-lease.regained" },
    ]);
    expect(Object.keys(records[0]!.fields ?? {})).toEqual(["staleForMs"]);
    expect(records[0]!.fields?.staleForMs).toBeGreaterThanOrEqual(60_000);
  });

  test("acquiring a lease nobody held, or one a clean shutdown released, writes nothing", async () => {
    const first = await open();
    await first.release();
    const second = await open();
    expect(second.isHeld()).toBe(true);
    expect(leaseRecords()).toEqual([]);
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

describe("registry writer state", () => {
  test("a held lease reads as held, and as lost once another backend takes it", async () => {
    const lease = await open();
    expect(lease.state()).toBe("held");
    await replaceLease("another-backend");
    // Reading the state checks the file, so the loss is found without a tick.
    expect(lease.state()).toBe("lost");
    expect(leaseRecords()).toMatchObject([{ event: "writer-lease.lost" }]);
  });

  test("a released lease reads as released, not lost", async () => {
    const lease = await open();
    await lease.release();
    expect(lease.state()).toBe("released");
    expect(leaseRecords()).toEqual([]);
  });

  test("a backend that never held it says why", async () => {
    writers.push(await openRegistryWriter(directory));
    const second = await openRegistryWriter(directory);
    writers.push(second);
    expect(second.state()).toBe("busy");

    const newer = await fs.mkdtemp(path.join(os.tmpdir(), "ork-writer-lease-newer-"));
    try {
      await fs.writeFile(
        path.join(newer, REGISTRY_SCHEMA_MARKER_FILE),
        JSON.stringify({ schemaVersion: 99, minimumWriterVersion: 99, updatedAt: "" }),
      );
      const blocked = await openRegistryWriter(newer);
      expect(blocked.state()).toBe("schema-incompatible");
    } finally {
      await fs.rm(newer, { recursive: true, force: true });
    }
  });

  test("the loss callback runs once, from a check or a heartbeat", async () => {
    let lost = 0;
    const checked = await open({ onLost: () => (lost += 1) });
    await replaceLease("another-backend");
    for (let tick = 0; tick < 3; tick += 1) checked.isHeld();
    expect(lost).toBe(1);
    await checked.release();
    expect(lost).toBe(1);

    let heartbeatLost = 0;
    await fs.rm(path.join(directory, REGISTRY_WRITER_LEASE_FILE), { force: true });
    await open({ heartbeatMs: 5, onLost: () => (heartbeatLost += 1) });
    await replaceLease("another-backend");
    for (let attempt = 0; attempt < 200 && heartbeatLost === 0; attempt += 1) {
      await Bun.sleep(5);
    }
    await Bun.sleep(25);
    expect(heartbeatLost).toBe(1);
  });

  test("a throwing loss callback is logged and never escapes the heartbeat", async () => {
    await open({
      heartbeatMs: 5,
      onLost: () => {
        throw new Error("listener broke");
      },
    });
    await replaceLease("another-backend");
    for (
      let attempt = 0;
      attempt < 200 &&
      !leaseRecords().some((record) => record.event === "writer-lease.listener-failed");
      attempt += 1
    ) {
      await Bun.sleep(5);
    }
    expect(leaseRecords().map((record) => record.event)).toEqual([
      "writer-lease.lost",
      "writer-lease.listener-failed",
    ]);
  });

  test("a release never calls the loss callback", async () => {
    let lost = 0;
    const lease = await open({ heartbeatMs: 1, onLost: () => (lost += 1) });
    await Bun.sleep(5);
    await lease.release();
    await Bun.sleep(10);
    expect(lost).toBe(0);
  });
});

/** A monotonic clock the test moves, as `monotonicNow`. */
function fakeMonotonic() {
  let at = 1_000;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

async function backdateLease(ms: number): Promise<void> {
  const time = new Date(Date.now() - ms);
  await fs.utimes(path.join(directory, REGISTRY_WRITER_LEASE_FILE), time, time);
}

describe("a backend that started without the lease", () => {
  const blockedBehind = async (options: Parameters<typeof openRegistryWriter>[1] = {}) => {
    const first = await open({ staleMs: 30_000 });
    const second = await openRegistryWriter(directory, options);
    writers.push(second);
    expect(second).toBeInstanceOf(ReclaimingRegistryWriter);
    return { first, second: second as ReclaimingRegistryWriter };
  };

  test("never wins while the holder keeps its lease fresh", async () => {
    let acquired = 0;
    const { first, second } = await blockedBehind({ onAcquired: () => acquired++ });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await second.tryAcquire()).toBe(false);
    }
    expect(second.state()).toBe("busy");
    expect(() => second.assertHeld()).toThrow("Another Orkestrator backend");
    expect(first.isHeld()).toBe(true);
    expect(acquired).toBe(0);
    // Retrying while busy is the expected answer and stays quiet.
    expect(leaseRecords()).toMatchObject([{ event: "writer-lease.not-acquired" }]);
  });

  test("takes over a lease a crashed holder left to go stale, once", async () => {
    let acquired = 0;
    const clock = fakeMonotonic();
    // The crashed holder's lease: never refreshed again.
    await replaceLease("crashed-backend");
    const second = await openRegistryWriter(directory, {
      staleMs: 30_000,
      monotonicNow: clock.now,
      onAcquired: () => acquired++,
    });
    writers.push(second);
    expect(second.state()).toBe("busy");
    await backdateLease(60_000);
    const reclaiming = second as ReclaimingRegistryWriter;
    // Stale by its file's age, but this process has not yet watched it stay
    // silent: first the new modification time, then 10 s, 20 s.
    for (let step = 0; step < 3; step += 1) {
      expect(await reclaiming.tryAcquire()).toBe(false);
      clock.advance(10_000);
    }
    await Promise.all([reclaiming.tryAcquire(), reclaiming.tryAcquire()]);
    expect(await reclaiming.tryAcquire()).toBe(true);
    expect(second.state()).toBe("held");
    expect(() => second.assertHeld()).not.toThrow();
    expect(acquired).toBe(1);
    expect(leaseRecords().map((record) => record.event)).toEqual([
      "writer-lease.not-acquired",
      "writer-lease.regained",
      "writer-lease.acquired-late",
    ]);
  });

  describe("a live holder across host sleep or a stall", () => {
    // A host sleep moves the wall clock on while neither process runs: the
    // lease file keeps its modification time but its age passes staleMs. The
    // holder's heartbeat is long so the test decides when it refreshes.
    const sleepingHolder = async () => {
      const clock = fakeMonotonic();
      let wallOffsetMs = 0;
      const wallNow = () => Date.now() + wallOffsetMs;
      const holder = await open({ staleMs: 30_000, heartbeatMs: 3_600_000 });
      const reclaiming = (await openRegistryWriter(directory, {
        staleMs: 30_000,
        now: wallNow,
        monotonicNow: clock.now,
      })) as ReclaimingRegistryWriter;
      writers.push(reclaiming);
      expect(reclaiming).toBeInstanceOf(ReclaimingRegistryWriter);
      expect(await reclaiming.tryAcquire()).toBe(false);
      wallOffsetMs += 60_000;
      const holderRefreshes = async () => {
        const time = new Date(wallNow());
        await fs.utimes(path.join(directory, REGISTRY_WRITER_LEASE_FILE), time, time);
      };
      return { clock, holder, reclaiming, holderRefreshes };
    };

    test("the reclaimer retries first after wake and does not win", async () => {
      const { clock, holder, reclaiming, holderRefreshes } = await sleepingHolder();
      clock.advance(10_000);
      expect(await reclaiming.tryAcquire()).toBe(false);
      await holderRefreshes();
      clock.advance(10_000);
      expect(await reclaiming.tryAcquire()).toBe(false);
      clock.advance(10_000);
      expect(await reclaiming.tryAcquire()).toBe(false);
      expect(holder.isHeld()).toBe(true);
      expect(reclaiming.state()).toBe("busy");
    });

    test("the holder refreshes first after wake and keeps its lease", async () => {
      const { clock, holder, reclaiming, holderRefreshes } = await sleepingHolder();
      await holderRefreshes();
      for (let step = 0; step < 3; step += 1) {
        clock.advance(10_000);
        expect(await reclaiming.tryAcquire()).toBe(false);
      }
      expect(holder.isHeld()).toBe(true);
      expect(reclaiming.state()).toBe("busy");
    });

    test("a monotonic clock that counted the sleep still counts it as one step", async () => {
      const { clock, holder, reclaiming, holderRefreshes } = await sleepingHolder();
      clock.advance(3_600_000);
      expect(await reclaiming.tryAcquire()).toBe(false);
      await holderRefreshes();
      clock.advance(10_000);
      expect(await reclaiming.tryAcquire()).toBe(false);
      expect(holder.isHeld()).toBe(true);
    });

    test("a holder that never refreshes again is taken over once watched for staleMs", async () => {
      const { clock, holder, reclaiming } = await sleepingHolder();
      for (let step = 0; step < 2; step += 1) {
        clock.advance(10_000);
        expect(await reclaiming.tryAcquire()).toBe(false);
      }
      clock.advance(10_000);
      expect(await reclaiming.tryAcquire()).toBe(true);
      expect(holder.isHeld()).toBe(false);
      expect(holder.state()).toBe("lost");
    });
  });

  test("takes it when the holder releases it on a clean shutdown", async () => {
    const { first, second } = await blockedBehind();
    await first.release();
    expect(await second.tryAcquire()).toBe(true);
    expect(second.isHeld()).toBe(true);
    await second.release();
    // Its own release removes the lease it won.
    await expect(fs.stat(path.join(directory, REGISTRY_WRITER_LEASE_FILE))).rejects.toThrow();
  });

  test("a throwing acquisition callback is logged and the lease is still held", async () => {
    const { first, second } = await blockedBehind({
      onAcquired: () => {
        throw new Error("listener boom");
      },
    });
    await first.release();
    expect(await second.tryAcquire()).toBe(true);
    expect(second.isHeld()).toBe(true);
    expect(leaseRecords()).toContainEqual(
      expect.objectContaining({ event: "writer-lease.listener-failed" }),
    );
  });

  test("exposes a late-won lease only once its recovery settles", async () => {
    const order: string[] = [];
    let finishRecovery!: () => void;
    const recoveryHeld = new Promise<void>((resolve) => (finishRecovery = resolve));
    let recoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => (recoveryStarted = resolve));
    let recoveryLease: RegistryWriter | undefined;
    const { first, second } = await blockedBehind({
      recoverLate: async (lease) => {
        recoveryLease = lease;
        order.push("recover");
        recoveryStarted();
        await recoveryHeld;
      },
      onAcquired: () => order.push("acquired"),
    });
    await first.release();
    const won = second.tryAcquire();
    await started;
    // Recovery writes with the won lease; nothing else may write yet.
    expect(recoveryLease?.isHeld()).toBe(true);
    expect(() => recoveryLease?.assertHeld()).not.toThrow();
    expect(second.isHeld()).toBe(false);
    expect(second.state()).toBe("busy");
    expect(() => second.assertHeld()).toThrow("Another Orkestrator backend");
    expect(order).toEqual(["recover"]);
    finishRecovery();
    expect(await won).toBe(true);
    expect(second.isHeld()).toBe(true);
    expect(second.state()).toBe("held");
    expect(order).toEqual(["recover", "acquired"]);
  });

  test("a failed recovery is logged and the lease is still exposed", async () => {
    let acquired = 0;
    const { first, second } = await blockedBehind({
      recoverLate: async () => {
        throw new Error("recovery boom");
      },
      onAcquired: () => acquired++,
    });
    await first.release();
    expect(await second.tryAcquire()).toBe(true);
    expect(second.isHeld()).toBe(true);
    expect(acquired).toBe(1);
    expect(leaseRecords()).toContainEqual(
      expect.objectContaining({ event: "writer-lease.listener-failed" }),
    );
  });

  test("a release during recovery releases the won lease without exposing it", async () => {
    let acquired = 0;
    let finishRecovery!: () => void;
    const recoveryHeld = new Promise<void>((resolve) => (finishRecovery = resolve));
    let recoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => (recoveryStarted = resolve));
    const { first, second } = await blockedBehind({
      recoverLate: async () => {
        recoveryStarted();
        await recoveryHeld;
      },
      onAcquired: () => acquired++,
    });
    await first.release();
    const won = second.tryAcquire();
    await started;
    const released = second.release();
    finishRecovery();
    await released;
    expect(await won).toBe(false);
    expect(second.isHeld()).toBe(false);
    expect(acquired).toBe(0);
    await expect(fs.stat(path.join(directory, REGISTRY_WRITER_LEASE_FILE))).rejects.toThrow();
  });

  test("tryAcquire agrees with isHeld once a won lease is released", async () => {
    const { first, second } = await blockedBehind();
    await first.release();
    expect(await second.tryAcquire()).toBe(true);
    await second.release();
    expect(second.isHeld()).toBe(false);
    expect(second.state()).toBe("released");
    expect(await second.tryAcquire()).toBe(false);
  });

  test("retries on its own timer, and a release stops it", async () => {
    const { first, second } = await blockedBehind({ retryMs: 20 });
    await first.release();
    for (let wait = 0; wait < 100 && !second.isHeld(); wait += 1) await Bun.sleep(10);
    expect(second.isHeld()).toBe(true);

    const third = await openRegistryWriter(directory, { retryMs: 20 });
    writers.push(third);
    await third.release();
    await second.release();
    // The lease is free now, and a released writer still never takes it.
    expect(await (third as ReclaimingRegistryWriter).tryAcquire()).toBe(false);
    expect(third.isHeld()).toBe(false);
    await expect(fs.stat(path.join(directory, REGISTRY_WRITER_LEASE_FILE))).rejects.toThrow();
  });

  test("does not take a directory a newer backend wrote meanwhile", async () => {
    const { first, second } = await blockedBehind();
    await fs.writeFile(
      path.join(directory, REGISTRY_SCHEMA_MARKER_FILE),
      JSON.stringify({ schemaVersion: 99, minimumWriterVersion: 99, updatedAt: "" }),
    );
    await first.release();
    expect(await second.tryAcquire()).toBe(false);
    expect(second.state()).toBe("busy");
  });
});
