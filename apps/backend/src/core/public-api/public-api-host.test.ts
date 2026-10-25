import { afterEach, describe, expect, test } from "bun:test";
import type { HostMaintenanceSnapshot } from "@orkestrator/protocol/host-maintenance";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import { HostMaintenanceService } from "../host-maintenance.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

const harnesses: PublicApiHarness[] = [];
const services: HostMaintenanceService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  for (const harness of harnesses.splice(0).reverse()) await harness.cleanup().catch(() => {});
});

function hostService(dataDir: string, version: string, ready = true): HostMaintenanceService {
  const service = new HostMaintenanceService({
    dataDir,
    updater: "desktop",
    version,
    emit: () => undefined,
  });
  services.push(service);
  service.init();
  service.markReady();
  if (ready) service.report({ type: "ready" });
  return service;
}

async function setup(version = "2.21.1", ready = true) {
  const harness = await createPublicApiHarness();
  harnesses.push(harness);
  const service = hostService(harness.dataDir, version, ready);
  harness.context.hostMaintenance = service;
  return { harness, service };
}

async function runGet(harness: PublicApiHarness, operationId: string): Promise<PublicReceipt> {
  const response = await harness.call("run.get", { operationId });
  expect(response.ok).toBe(true);
  return response.receipt!;
}

async function taskFinished(service: HostMaintenanceService, id: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (service.task(id)?.state === "running") {
    if (Date.now() > deadline) throw new Error("task did not finish");
    await Bun.sleep(5);
  }
}

describe("host.* public actions", () => {
  test("host.status reports the version and updater", async () => {
    const { harness } = await setup();
    const response = await harness.call<HostMaintenanceSnapshot>("host.status", {});
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.result).toMatchObject({
      version: "2.21.1",
      updater: { kind: "desktop", available: true },
      job: null,
    });
  });

  test("apply requires confirm and an updater that is ready", async () => {
    const { harness, service } = await setup("2.21.1", false);
    const unconfirmed = await harness.call("host.update.apply", {}, { requestId: "apply-0" });
    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) expect(unconfirmed.error.code).toBe("invalid-input");

    const unavailable = await harness.call(
      "host.update.apply",
      { confirm: true },
      { requestId: "apply-1" },
    );
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.error.code).toBe("capability-unavailable");

    service.report({ type: "ready" });
    const accepted = await harness.call(
      "host.update.apply",
      { confirm: true },
      { requestId: "apply-2" },
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.receipt).toMatchObject({ state: "running", stage: "requested" });
  });

  test("one update at a time; the same request key replays", async () => {
    const { harness } = await setup();
    const first = await harness.call<{ jobId: string }>(
      "host.update.apply",
      { confirm: true },
      { requestId: "apply-a" },
    );
    expect(first.ok).toBe(true);
    const replay = await harness.call<{ jobId: string }>(
      "host.update.apply",
      { confirm: true },
      { requestId: "apply-a" },
    );
    expect(replay.ok).toBe(true);
    expect(replay.receipt?.replayed).toBe(true);
    if (first.ok && replay.ok) expect(replay.result.jobId).toBe(first.result.jobId);

    const second = await harness.call(
      "host.update.apply",
      { confirm: true },
      { requestId: "apply-b" },
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("busy");
  });

  test("the operation follows the job and succeeds after the host restarts on the new version", async () => {
    const { harness, service } = await setup("2.21.1");
    const accepted = await harness.call<{ jobId: string }>(
      "host.update.apply",
      { confirm: true },
      { requestId: "apply-restart" },
    );
    if (!accepted.ok) throw new Error("apply was refused");
    const operationId = accepted.receipt!.operationId;
    const jobId = accepted.result.jobId;

    service.report({ type: "job", jobId, state: "downloading", progressPercent: 10 });
    expect(await runGet(harness, operationId)).toMatchObject({
      state: "running",
      stage: "downloading",
    });
    service.report({
      type: "job",
      jobId,
      state: "awaiting-restart",
      targetVersion: "2.22.0",
      restartAt: new Date(Date.now() + 60_000).toISOString(),
    });
    service.report({ type: "job", jobId, state: "restarting" });
    service.close();

    const restarted = await harness.restart();
    harnesses.push(restarted);
    restarted.context.hostMaintenance = hostService(restarted.dataDir, "2.22.0", false);
    expect(await runGet(restarted, operationId)).toMatchObject({
      state: "succeeded",
      stage: "completed",
    });
  });

  test("a restart postponed at the host fails the operation with that reason", async () => {
    const { harness, service } = await setup();
    const accepted = await harness.call<{ jobId: string }>(
      "host.update.apply",
      { confirm: true, version: "2.22.0" },
      { requestId: "apply-postpone" },
    );
    if (!accepted.ok) throw new Error("apply was refused");
    const jobId = accepted.result.jobId;
    service.report({
      type: "job",
      jobId,
      state: "awaiting-restart",
      targetVersion: "2.22.0",
      restartAt: new Date(Date.now() + 60_000).toISOString(),
    });
    service.report({ type: "job", jobId, state: "postponed" });
    const receipt = await runGet(harness, accepted.receipt!.operationId);
    expect(receipt).toMatchObject({ state: "failed", stage: "postponed" });
    expect(receipt.error?.message).toContain("Postponed");
  });

  test("host.update.check records a request the executor answers", async () => {
    const { harness, service } = await setup();
    const response = await harness.call<{ checkRequestId: string }>(
      "host.update.check",
      {},
      { requestId: "check-1" },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(service.snapshot().checkRequest?.id).toBe(response.result.checkRequestId);
  });

  test("cancel ends an update before its restart and settles the apply operation", async () => {
    const { harness, service } = await setup();
    const accepted = await harness.call<{ jobId: string }>(
      "host.update.apply",
      { confirm: true, drain: "when-idle", maxWaitSeconds: 600 },
      { requestId: "apply-cancel" },
    );
    if (!accepted.ok) throw new Error("apply was refused");
    expect(service.job(accepted.result.jobId)).toMatchObject({ drain: "when-idle" });
    const cancelled = await harness.call("host.update.cancel", {}, { requestId: "cancel-1" });
    expect(cancelled.ok).toBe(true);
    const receipt = await runGet(harness, accepted.receipt!.operationId);
    expect(receipt).toMatchObject({ state: "cancelled", stage: "cancelled" });

    const nothing = await harness.call("host.update.cancel", {}, { requestId: "cancel-2" });
    expect(nothing.ok).toBe(false);
    if (!nothing.ok) expect(nothing.error.code).toBe("not-found");
  });

  test("maxWaitSeconds needs drain when-idle", async () => {
    const { harness } = await setup();
    const response = await harness.call(
      "host.update.apply",
      { confirm: true, maxWaitSeconds: 600 },
      { requestId: "apply-bad" },
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("invalid-input");
  });

  test("a dependency task's operation settles when the task finishes", async () => {
    const { harness, service } = await setup();
    const accepted = await harness.call<{ taskId: string }>(
      "host.gh.update",
      { channel: "pinned" },
      { requestId: "gh-pinned" },
    );
    if (!accepted.ok) throw new Error("gh update was refused");
    const deadline = Date.now() + 5_000;
    while (service.task(accepted.result.taskId)?.state === "running") {
      if (Date.now() > deadline) throw new Error("task did not finish");
      await Bun.sleep(10);
    }
    expect(await runGet(harness, accepted.receipt!.operationId)).toMatchObject({
      state: "succeeded",
      stage: "completed",
    });
  });

  test("host.status carries the live readings", async () => {
    const { harness, service } = await setup();
    service.setReaders({
      impact: async () => ({
        workingAgents: 0,
        waitingAgents: 1,
        activePipelines: 0,
        terminals: 0,
        hostServers: 0,
        measuredAt: new Date().toISOString(),
      }),
    });
    const response = await harness.call<HostMaintenanceSnapshot>("host.status", {});
    if (!response.ok) throw new Error("status failed");
    expect(response.result.impact?.waitingAgents).toBe(1);
    expect(response.result.tasks).toEqual({});
  });
});

test("consecutive public tasks retain each outcome until its receipt settles", async () => {
  const { harness, service } = await setup();
  const first = await harness.call<{ taskId: string }>(
    "host.gh.update",
    { channel: "pinned" },
    { requestId: "first" },
  );
  if (!first.ok) throw new Error("first refused");
  await taskFinished(service, first.result.taskId);
  const second = await harness.call<{ taskId: string }>(
    "host.gh.update",
    { channel: "pinned" },
    { requestId: "second" },
  );
  if (!second.ok) throw new Error("second refused");
  await taskFinished(service, second.result.taskId);
  expect(service.task(first.result.taskId)?.state).toBe("succeeded");
  expect(await runGet(harness, first.receipt!.operationId)).toMatchObject({ state: "succeeded" });
  expect(await runGet(harness, second.receipt!.operationId)).toMatchObject({ state: "succeeded" });
  expect(await runGet(harness, first.receipt!.operationId)).toMatchObject({ state: "succeeded" });
});

test("consecutive update jobs retain their outcomes across restart and receipt reconciliation", async () => {
  const { harness, service } = await setup();
  const first = await harness.call<{ jobId: string }>(
    "host.update.apply",
    { confirm: true, version: "2.22.0" },
    { requestId: "update-first" },
  );
  if (!first.ok) throw new Error("first refused");
  service.report({
    type: "job",
    jobId: first.result.jobId,
    state: "awaiting-restart",
    targetVersion: "2.22.0",
  });
  service.report({ type: "job", jobId: first.result.jobId, state: "restarting" });
  service.close();
  const newService = hostService(harness.dataDir, "2.22.0");
  harness.context.hostMaintenance = newService;
  const second = await harness.call<{ jobId: string }>(
    "host.update.apply",
    { confirm: true, version: "2.23.0" },
    { requestId: "update-second" },
  );
  if (!second.ok) throw new Error("second refused");
  newService.report({
    type: "job",
    jobId: second.result.jobId,
    state: "failed",
    error: "download failed",
  });
  expect(await runGet(harness, first.receipt!.operationId)).toMatchObject({ state: "succeeded" });
  expect(await runGet(harness, second.receipt!.operationId)).toMatchObject({ state: "failed" });
});

test("a backend that fails before readiness cannot report update success to its public receipt", async () => {
  const { harness, service } = await setup();
  const accepted = await harness.call<{ jobId: string }>(
    "host.update.apply",
    { confirm: true, version: "2.22.0" },
    { requestId: "unready" },
  );
  if (!accepted.ok) throw new Error("refused");
  const jobId = accepted.result.jobId;
  service.report({ type: "job", jobId, state: "awaiting-restart", targetVersion: "2.22.0" });
  service.report({ type: "job", jobId, state: "restarting" });
  service.close();
  const unready = new HostMaintenanceService({
    dataDir: harness.dataDir,
    updater: "standalone",
    version: "2.22.0",
    emit: () => undefined,
  });
  services.push(unready);
  unready.init();
  harness.context.hostMaintenance = unready;
  expect(await runGet(harness, accepted.receipt!.operationId)).toMatchObject({ state: "running" });
  unready.close();
  const restored = new HostMaintenanceService({
    dataDir: harness.dataDir,
    updater: "standalone",
    version: "2.21.1",
    emit: () => undefined,
    rollbackEvidence: () => ({
      failedVersion: "2.22.0",
      restoredVersion: "2.21.1",
      at: new Date(Date.now() + 1000).toISOString(),
    }),
  });
  services.push(restored);
  restored.init();
  restored.markReady();
  harness.context.hostMaintenance = restored;
  expect(await runGet(harness, accepted.receipt!.operationId)).toMatchObject({
    state: "failed",
    error: { message: "2.22.0 did not start, so the host went back to 2.21.1" },
  });
});

test("channel mutations persist, replay by request key, conflict on changed intent, and refuse during updates", async () => {
  const { harness, service } = await setup();
  const first = await harness.call<{ host: HostMaintenanceSnapshot }>(
    "host.update.channel",
    { channel: "beta" },
    { requestId: "channel" },
  );
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.result.host.updateChannel).toBe("beta");
  expect(first.result.host.checkRequest).not.toBeNull();
  const revision = service.snapshot().revision;
  const replay = await harness.call(
    "host.update.channel",
    { channel: "beta" },
    { requestId: "channel" },
  );
  expect(replay.receipt?.replayed).toBe(true);
  expect(service.snapshot().revision).toBe(revision);
  expect(
    (await harness.call("host.update.channel", { channel: "unstable" }, { requestId: "channel" }))
      .ok,
  ).toBe(false);
  expect(
    (await harness.call("host.update.channel", { channel: "canary" }, { requestId: "invalid" })).ok,
  ).toBe(false);
  service.requestUpdate({ requestedVersion: null });
  const busy = await harness.call(
    "host.update.channel",
    { channel: "stable" },
    { requestId: "busy-channel" },
  );
  expect(busy.ok).toBe(false);
  if (!busy.ok) expect(busy.error.code).toBe("busy");
  expect(service.snapshot().updateChannel).toBe("beta");
});
