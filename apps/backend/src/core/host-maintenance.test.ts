import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_MAINTENANCE_EVENT,
  type HostMaintenanceSnapshot,
} from "@orkestrator/protocol/host-maintenance";
import {
  HostMaintenanceError,
  HostMaintenanceService,
  type HostRollbackEvidence,
} from "./host-maintenance.js";

let dataDir: string;
const services: HostMaintenanceService[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ork-host-maintenance-"));
});

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await rm(dataDir, { recursive: true, force: true });
});

function create(
  options: {
    version?: string;
    updater?: "desktop" | "standalone" | "none";
    ready?: boolean;
    rollback?: HostRollbackEvidence | null;
  } = {},
) {
  const events: HostMaintenanceSnapshot[] = [];
  let clock = Date.parse("2026-10-16T12:00:00.000Z");
  let ids = 0;
  const service = new HostMaintenanceService({
    dataDir,
    updater: options.updater ?? "desktop",
    version: options.version ?? "2.21.1",
    emit: (event, payload) => {
      if (event === HOST_MAINTENANCE_EVENT) events.push(payload as HostMaintenanceSnapshot);
    },
    now: () => (clock += 1_000),
    newId: () => `id-${(ids += 1)}`,
    rollbackEvidence: () => options.rollback ?? null,
  });
  services.push(service);
  service.init();
  if ((options.ready ?? true) && service.updaterKind === "desktop") {
    service.report({ type: "ready" });
  }
  return { service, events };
}

describe("HostMaintenanceService", () => {
  test("a backend without an updater explains why it cannot update", () => {
    const { service } = create({ updater: "none", ready: false });
    const { updater } = service.snapshot();
    expect(updater).toMatchObject({ kind: "none", available: false });
    expect(updater.reason).toContain("Update Orkestrator on the host itself");
    expect(() => service.requestUpdate({ requestedVersion: null })).toThrow(HostMaintenanceError);
  });

  test("the desktop updater is unavailable until its executor reports ready", () => {
    const { service, events } = create({ ready: false });
    expect(service.snapshot().updater.available).toBe(false);
    expect(() => service.requestCheck()).toThrow("has not started its updater");
    service.report({ type: "ready" });
    expect(service.snapshot().updater.available).toBe(true);
    expect(events.at(-1)?.updater.available).toBe(true);
  });

  test("a check request is answered by the executor's report", () => {
    const { service } = create();
    const requested = service.requestCheck();
    expect(requested.checkRequest?.id).toBe("id-1");
    const answered = service.report({
      type: "check",
      latestVersion: "2.22.0",
      updateAvailable: true,
      checkedAt: "2026-10-16T12:00:00.500Z",
      error: null,
      checkRequestId: "id-1",
    });
    expect(answered.checkRequest).toBeNull();
    expect(answered.updater).toMatchObject({ latestVersion: "2.22.0", updateAvailable: true });
  });

  test("a background check that finishes after the request also answers it", () => {
    const { service } = create();
    const requestedAt = Date.parse(service.requestCheck().checkRequest!.requestedAt);
    const answered = service.report({
      type: "check",
      latestVersion: "2.21.1",
      updateAvailable: false,
      checkedAt: new Date(requestedAt + 5).toISOString(),
      error: null,
    });
    expect(answered.checkRequest).toBeNull();
  });

  test("runs one job at a time through the executor's reported states", () => {
    const { service } = create();
    const job = service.requestUpdate({ requestedVersion: "2.22.0" });
    expect(job).toMatchObject({ state: "requested", fromVersion: "2.21.1" });
    expect(() => service.requestUpdate({ requestedVersion: null })).toThrow("already in progress");

    service.report({ type: "job", jobId: job.id, state: "downloading", progressPercent: 40 });
    expect(service.snapshot().job).toMatchObject({ state: "downloading", progressPercent: 40 });
    service.report({
      type: "job",
      jobId: job.id,
      state: "awaiting-restart",
      targetVersion: "2.22.0",
      restartAt: "2026-10-16T12:01:00.000Z",
    });
    expect(service.snapshot().job).toMatchObject({
      state: "awaiting-restart",
      targetVersion: "2.22.0",
      progressPercent: null,
      restartAt: "2026-10-16T12:01:00.000Z",
    });
    service.report({ type: "job", jobId: job.id, state: "restarting" });
    expect(service.snapshot().job?.state).toBe("restarting");
  });

  test("ignores reports for another job and out-of-order states", () => {
    const { service } = create();
    const job = service.requestUpdate({ requestedVersion: null });
    const before = service.snapshot().revision;
    service.report({ type: "job", jobId: "other", state: "downloading" });
    service.report({ type: "job", jobId: job.id, state: "restarting" });
    expect(service.snapshot().job?.state).toBe("requested");
    expect(service.snapshot().revision).toBe(before);
  });

  test("a postponed or failed job ends and frees the host for the next one", () => {
    const { service } = create();
    const first = service.requestUpdate({ requestedVersion: null });
    service.report({ type: "job", jobId: first.id, state: "failed", error: "No update" });
    expect(service.snapshot().job).toMatchObject({ state: "failed", error: "No update" });
    expect(service.snapshot().job?.completedAt).not.toBeNull();
    const second = service.requestUpdate({ requestedVersion: null });
    expect(second.id).not.toBe(first.id);
  });

  test("refuses to update to the version already running", () => {
    const { service } = create();
    expect(() => service.requestUpdate({ requestedVersion: "2.21.1" })).toThrow(
      "already runs Orkestrator 2.21.1",
    );
  });

  test("the restarted backend settles the job from the version it runs", () => {
    const before = create({ version: "2.21.1" }).service;
    const job = before.requestUpdate({ requestedVersion: null });
    before.report({
      type: "job",
      jobId: job.id,
      state: "awaiting-restart",
      targetVersion: "2.22.0",
      restartAt: "2026-10-16T12:01:00.000Z",
    });
    before.report({ type: "job", jobId: job.id, state: "restarting" });
    before.close();

    const after = create({ version: "2.22.0", ready: false }).service;
    expect(after.snapshot().job).toMatchObject({
      id: job.id,
      state: "succeeded",
      targetVersion: "2.22.0",
    });
    // The executor is not ready in the new process until it says so.
    expect(after.snapshot().updater.available).toBe(false);
  });

  test("a restart on the same version fails the job instead of resuming it", () => {
    const before = create().service;
    const job = before.requestUpdate({ requestedVersion: null });
    before.report({ type: "job", jobId: job.id, state: "downloading" });
    before.close();

    const after = create().service;
    expect(after.snapshot().job).toMatchObject({
      state: "failed",
      error: "The app restarted before the update was installed",
    });
  });

  test("an update installed on a normal quit during the countdown still succeeds", () => {
    const before = create().service;
    const job = before.requestUpdate({ requestedVersion: null });
    before.report({
      type: "job",
      jobId: job.id,
      state: "awaiting-restart",
      targetVersion: "2.22.0",
      restartAt: "2026-10-16T12:01:00.000Z",
    });
    before.close();
    expect(create({ version: "2.22.0" }).service.snapshot().job?.state).toBe("succeeded");
  });

  test("a check from an older version says nothing about whether this one is current", () => {
    const before = create().service;
    before.report({
      type: "check",
      latestVersion: "2.22.0",
      updateAvailable: true,
      checkedAt: "2026-10-16T12:00:00.000Z",
      error: null,
    });
    before.close();
    const after = create({ version: "2.22.0" }).service;
    expect(after.snapshot().updater).toMatchObject({
      latestVersion: "2.22.0",
      updateAvailable: null,
    });
  });

  test("when-idle jobs carry a deadline and pass through waiting-for-idle", () => {
    const { service } = create();
    const job = service.requestUpdate({
      requestedVersion: null,
      drain: "when-idle",
      maxWaitSeconds: 600,
    });
    expect(job.drain).toBe("when-idle");
    expect(Date.parse(job.idleDeadline!) - Date.parse(job.requestedAt)).toBe(600_000);
    service.report({ type: "job", jobId: job.id, state: "downloading" });
    service.report({
      type: "job",
      jobId: job.id,
      state: "waiting-for-idle",
      targetVersion: "2.22.0",
    });
    expect(service.snapshot().job).toMatchObject({
      state: "waiting-for-idle",
      targetVersion: "2.22.0",
    });
    expect(() =>
      service.requestUpdate({ requestedVersion: null, drain: "when-idle", maxWaitSeconds: 5 }),
    ).toThrow(); // busy and out of range alike
  });

  test("rejects an idle wait outside its bounds", () => {
    const { service } = create();
    expect(() =>
      service.requestUpdate({ requestedVersion: null, drain: "when-idle", maxWaitSeconds: 5 }),
    ).toThrow("maxWaitSeconds must be between");
  });

  test("cancels before the restart, and never after", () => {
    const { service } = create();
    const job = service.requestUpdate({ requestedVersion: null });
    service.report({ type: "job", jobId: job.id, state: "downloading" });
    expect(service.cancelUpdate().state).toBe("cancelled");
    // The executor's late report is ignored.
    service.report({ type: "job", jobId: job.id, state: "awaiting-restart" });
    expect(service.snapshot().job?.state).toBe("cancelled");
    expect(() => service.cancelUpdate()).toThrow("No update is in progress");

    const second = service.requestUpdate({ requestedVersion: null });
    service.report({ type: "job", jobId: second.id, state: "awaiting-restart" });
    service.report({ type: "job", jobId: second.id, state: "restarting" });
    expect(() => service.cancelUpdate()).toThrow("already restarting");
  });

  test("a standalone backend's updater is available without an announcement", () => {
    const { service } = create({ updater: "standalone" });
    expect(service.snapshot().updater).toMatchObject({ kind: "standalone", available: true });
  });

  test("a launcher rollback fails the job with the reason", () => {
    const before = create({ updater: "standalone" }).service;
    const job = before.requestUpdate({ requestedVersion: null });
    before.report({
      type: "job",
      jobId: job.id,
      state: "awaiting-restart",
      targetVersion: "2.22.0",
    });
    before.report({ type: "job", jobId: job.id, state: "restarting" });
    before.close();
    const after = create({
      updater: "standalone",
      rollback: { failedVersion: "2.22.0", restoredVersion: "2.21.1", at: "2026-10-16T12:05:00Z" },
    }).service;
    expect(after.snapshot().job).toMatchObject({
      state: "failed",
      error: "2.22.0 did not start, so the host went back to 2.21.1",
    });
  });

  test("runs one task of each kind and fails tasks a restart cut short", () => {
    const { service } = create();
    const task = service.startTask("toolchain-repair", "Checking");
    expect(() => service.startTask("toolchain-repair", "again")).toThrow("already running");
    service.startTask("image-update", "Pulling");
    service.updateTask(task.id, { stage: "Downloading claude" });
    expect(service.snapshot().tasks["toolchain-repair"]?.stage).toBe("Downloading claude");
    service.updateTask(task.id, {
      state: "succeeded",
      result: { versions: { claude: "2.1.296" } },
    });
    expect(service.task(task.id)).toMatchObject({ state: "succeeded", stage: null });
    // Finished tasks ignore later updates.
    service.updateTask(task.id, { state: "failed", error: "late" });
    expect(service.task(task.id)?.state).toBe("succeeded");
    service.close();

    const restarted = create().service;
    expect(restarted.snapshot().tasks["image-update"]).toMatchObject({
      state: "failed",
      error: "The backend restarted before this finished; start it again",
    });
  });

  test("keeps the next release's pins until that version runs", () => {
    const before = create().service;
    before.setNextRelease({ version: "2.22.0", tools: { claude: "2.1.310" } });
    expect(before.snapshot().nextRelease).toEqual({
      version: "2.22.0",
      tools: { claude: "2.1.310" },
    });
    before.close();
    expect(create({ version: "2.22.0" }).service.snapshot().nextRelease).toBeNull();
  });

  test("records the gh channel and tells subscribers about every change", () => {
    const { service } = create();
    const seen: number[] = [];
    const stop = service.subscribe((snapshot) => seen.push(snapshot.revision));
    service.setGhChannel("latest");
    service.setGhChannel("latest");
    expect(service.ghChannel()).toBe("latest");
    stop();
    service.setGhChannel("pinned");
    expect(seen).toHaveLength(1);
  });

  test("a detailed snapshot adds live readings and survives a failing reader", async () => {
    const { service } = create();
    service.setReaders({
      impact: async () => ({
        workingAgents: 1,
        waitingAgents: 0,
        activePipelines: 0,
        terminals: 2,
        hostServers: 1,
        measuredAt: "2026-10-16T12:00:00Z",
      }),
      tools: async () => {
        throw new Error("unreadable");
      },
    });
    const detailed = await service.detailedSnapshot();
    expect(detailed.impact?.workingAgents).toBe(1);
    expect(detailed.tools).toBeUndefined();
    expect(service.snapshot().impact).toBeUndefined();
  });
});
