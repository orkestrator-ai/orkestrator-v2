import { describe, expect, test } from "bun:test";
import type { HostMaintenanceSnapshot } from "@orkestrator/protocol/host-maintenance";
import {
  hostMaintenanceSnapshotFixture,
  hostUpdateJobFixture,
} from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import type { HostMaintenanceClient } from "@/lib/host-maintenance-client";
import type { BulkUpdateOutcome } from "@/stores/machineBulkUpdateStore";
import { summarizeBulkUpdate, updateMachineToLatest, updateMachinesToLatest } from "./bulk-update";

const idle = hostMaintenanceSnapshotFixture({ version: "2.36.0" });
const pending = { ...idle, revision: 2, checkRequest: { id: "c1", requestedAt: "t" } };
function checked(updater: Partial<HostMaintenanceSnapshot["updater"]>): HostMaintenanceSnapshot {
  return {
    ...idle,
    revision: 3,
    updater: { ...idle.updater, checkedAt: "t", ...updater },
  };
}

/** A machine whose reads answer from `reads` in turn, keeping the last. */
function machine(reads: HostMaintenanceSnapshot[], afterCheck = pending) {
  const calls: string[] = [];
  const updates: unknown[] = [];
  let index = 0;
  const client = {
    getHostMaintenance: async () => {
      calls.push("read");
      const snapshot = reads[Math.min(index, reads.length - 1)]!;
      index += 1;
      return snapshot;
    },
    requestHostUpdateCheck: async () => {
      calls.push("check");
      return afterCheck;
    },
    requestHostUpdate: async (options: unknown) => {
      calls.push("update");
      updates.push(options);
      return {
        job: hostUpdateJobFixture(),
        snapshot: { ...idle, revision: 9, job: hostUpdateJobFixture() },
      };
    },
  } as unknown as HostMaintenanceClient;
  return { client, calls, updates };
}

const noSleep = async () => undefined;

describe("updateMachineToLatest", () => {
  test("checks first, then installs the release the check found", async () => {
    const target = machine([idle, checked({ latestVersion: "2.37.0", updateAvailable: true })]);
    const progress: BulkUpdateOutcome[] = [];
    const outcome = await updateMachineToLatest(target.client, { sleep: noSleep }, (step) =>
      progress.push(step),
    );
    expect(outcome).toEqual({ state: "requested", version: "2.37.0" });
    expect(target.calls).toEqual(["read", "check", "read", "update"]);
    expect(target.updates).toEqual([{ version: "2.37.0" }]);
    expect(progress.map((step) => step.state)).toEqual(["checking", "requested"]);
  });

  test("leaves a machine already on the newest release alone", async () => {
    const target = machine([idle, checked({ latestVersion: "2.36.0", updateAvailable: false })]);
    expect(await updateMachineToLatest(target.client, { sleep: noSleep })).toEqual({
      state: "current",
      version: "2.36.0",
    });
    expect(target.calls).not.toContain("update");
  });

  test("passes the idle wait through to the host", async () => {
    const target = machine([idle, checked({ latestVersion: "2.37.0", updateAvailable: true })]);
    await updateMachineToLatest(target.client, {
      sleep: noSleep,
      drain: "when-idle",
      maxWaitSeconds: 1_800,
    });
    expect(target.updates).toEqual([
      { version: "2.37.0", drain: "when-idle", maxWaitSeconds: 1_800 },
    ]);
  });

  test("a machine whose updater is unavailable is skipped with its reason", async () => {
    const target = machine([
      checked({ available: false, reason: "Started by the CLI; nothing to update" }),
    ]);
    expect(await updateMachineToLatest(target.client)).toEqual({
      state: "skipped",
      reason: "Started by the CLI; nothing to update",
    });
    expect(target.calls).toEqual(["read"]);
  });

  test("a machine already updating is not asked again", async () => {
    const target = machine([{ ...idle, job: hostUpdateJobFixture({ state: "downloading" }) }]);
    expect(await updateMachineToLatest(target.client)).toEqual({ state: "busy" });
    expect(target.calls).toEqual(["read"]);
  });

  test("a failed check is reported, not installed over", async () => {
    const target = machine([idle, checked({ checkError: "GitHub is unreachable" })]);
    expect(await updateMachineToLatest(target.client, { sleep: noSleep })).toEqual({
      state: "failed",
      error: "The check failed: GitHub is unreachable",
    });
    expect(target.calls).not.toContain("update");
  });

  test("an unanswered check lets the host pick the newest release itself", async () => {
    let clock = 0;
    const target = machine([idle, pending]);
    const outcome = await updateMachineToLatest(target.client, {
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      checkTimeoutMs: 5_000,
    });
    expect(outcome).toEqual({ state: "requested", version: null });
    expect(target.updates).toEqual([{}]);
  });

  test("a refused request is a failure with the host's message", async () => {
    const target = machine([idle, checked({ latestVersion: "2.37.0", updateAvailable: true })]);
    target.client.requestHostUpdate = async () => {
      throw new Error("An update is already in progress (downloading)");
    };
    expect(await updateMachineToLatest(target.client, { sleep: noSleep })).toEqual({
      state: "failed",
      error: "An update is already in progress (downloading)",
    });
  });
});

describe("updateMachinesToLatest", () => {
  test("asks this window's machine only after every other machine has its request", async () => {
    const order: string[] = [];
    const tracked = (key: string) => {
      const target = machine([idle, checked({ latestVersion: "2.37.0", updateAvailable: true })]);
      const request = target.client.requestHostUpdate;
      target.client.requestHostUpdate = async (options) => {
        // The remote machine answers slowly; this window's must still wait for it.
        if (key === "build") await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(key);
        return request(options);
      };
      return target.client;
    };
    const outcomes = await updateMachinesToLatest(
      [
        { key: "self", client: tracked("self"), last: true },
        { key: "build", client: tracked("build"), last: false },
      ],
      { sleep: noSleep },
      () => undefined,
    );
    expect(order).toEqual(["build", "self"]);
    expect([...outcomes.keys()].sort()).toEqual(["build", "self"]);
  });
});

test("summarizeBulkUpdate counts each kind of result", () => {
  expect(
    summarizeBulkUpdate([
      { state: "requested", version: "2.37.0" },
      { state: "requested", version: null },
      { state: "current", version: "2.37.0" },
      { state: "failed", error: "x" },
    ]),
  ).toBe("Started on 2 machines · 1 already current · 1 failed");
  expect(summarizeBulkUpdate([])).toBe("Nothing to update");
});
