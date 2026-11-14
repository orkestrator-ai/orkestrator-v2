import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REGISTRY_WRITER_LEASE_FILE,
  ReclaimingRegistryWriter,
  RegistryWriterLease,
  openRegistryWriter,
  type RegistryWriter,
} from "./registry-writer-lease.js";
import { registryWriterStartup } from "./registry-writer-startup.js";

let directory: string;
const writers: RegistryWriter[] = [];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-writer-startup-"));
});

afterEach(async () => {
  for (const writer of writers.splice(0)) await writer.release();
  await fs.rm(directory, { recursive: true, force: true });
});

/** The backend's wiring (`index.ts` init) against real lease files. */
function wiring() {
  const runs: { lease: RegistryWriter; heldThen: boolean }[] = [];
  const events: string[] = [];
  let finish: (() => void) | undefined;
  const startup = registryWriterStartup({
    runWriterStartupWork: async (lease) => {
      runs.push({ lease, heldThen: lease.isHeld() });
      events.push("startup-work");
      if (finish === undefined) return;
      await new Promise<void>((resolve) => (finish = resolve));
    },
    announceSchedulerStatus: () => events.push("announce"),
  });
  return {
    startup,
    runs,
    events,
    /** Holds the next startup work until `release` is called. */
    hold: () => {
      finish = () => undefined;
      return () => finish?.();
    },
  };
}

async function openWired(startup: ReturnType<typeof wiring>["startup"]) {
  const writer = await openRegistryWriter(directory, startup.leaseOptions);
  writers.push(writer);
  return writer;
}

describe("registry writer startup wiring", () => {
  test("a lease won at startup runs the writer-only work once, with that lease", async () => {
    const { startup, runs, events } = wiring();
    const writer = await openWired(startup);
    expect(writer).toBeInstanceOf(RegistryWriterLease);
    await startup.runIfHeld(writer);
    await startup.runIfHeld(writer);
    expect(runs).toEqual([{ lease: writer, heldThen: true }]);
    expect(events).toEqual(["startup-work"]);
  });

  test("a busy lease runs nothing at startup, then the work with the won lease before announcing", async () => {
    const holder = await RegistryWriterLease.acquire(directory);
    writers.push(holder);
    const { startup, runs, events, hold } = wiring();
    const writer = (await openWired(startup)) as ReclaimingRegistryWriter;
    expect(writer).toBeInstanceOf(ReclaimingRegistryWriter);
    await startup.runIfHeld(writer);
    expect(runs).toEqual([]);

    const release = hold();
    await holder.release();
    const won = writer.tryAcquire();
    for (let wait = 0; wait < 200 && runs.length === 0; wait += 1) await Bun.sleep(5);
    // Recovery writes with the won lease while the context's writer, what
    // schedules and commands read, is not held yet.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.lease).not.toBe(writer);
    expect(runs[0]!.heldThen).toBe(true);
    expect(writer.isHeld()).toBe(false);
    // The startup path's held check reached mid-recovery does not run it again.
    await startup.runIfHeld(writer);
    expect(events).toEqual(["startup-work"]);

    release();
    expect(await won).toBe(true);
    expect(events).toEqual(["startup-work", "announce"]);
  });

  test("a late win that settles before the startup held check runs the work once", async () => {
    const holder = await RegistryWriterLease.acquire(directory);
    writers.push(holder);
    const { startup, runs, events } = wiring();
    const writer = (await openWired(startup)) as ReclaimingRegistryWriter;
    await holder.release();
    expect(await writer.tryAcquire()).toBe(true);
    await startup.runIfHeld(writer);
    expect(runs).toHaveLength(1);
    expect(events).toEqual(["startup-work", "announce"]);
  });

  test("losing the lease announces the scheduler status", async () => {
    const { startup, events } = wiring();
    const writer = await openWired(startup);
    await startup.runIfHeld(writer);
    await fs.writeFile(
      path.join(directory, REGISTRY_WRITER_LEASE_FILE),
      JSON.stringify({ token: "other", pid: 1, acquiredAt: "2026-11-14T00:00:00.000Z" }),
    );
    expect(writer.isHeld()).toBe(false);
    expect(events).toEqual(["startup-work", "announce"]);
  });
});
