import { describe, expect, mock, test } from "bun:test";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import {
  hostMaintenanceSnapshotFixture,
  hostUpdateJobFixture,
} from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import {
  HOST_MAINTENANCE_EVENT,
  type HostMaintenanceSnapshot,
  type HostRestartImpact,
  type HostUpdateJob,
  type HostUpdaterReport,
} from "@orkestrator/protocol/host-maintenance";
import type { StagedUpdate } from "./auto-update.js";
import {
  confirmRestartWithCountdown,
  createHostUpdateExecutor,
  type RestartDecision,
} from "./host-update-executor.js";

function job(overrides: Partial<HostUpdateJob> = {}): HostUpdateJob {
  return hostUpdateJobFixture(overrides);
}

function snapshot(overrides: Partial<HostMaintenanceSnapshot> = {}): HostMaintenanceSnapshot {
  return hostMaintenanceSnapshotFixture(overrides);
}

/** A backend that records reports and answers with the job state they set. */
function createHarness(
  options: {
    initial?: HostMaintenanceSnapshot;
    staged?: StagedUpdate | Error;
    decision?: RestartDecision;
    install?: boolean;
    /** Restart impact each detailed read reports, in order (the last repeats). */
    impacts?: Array<Partial<HostRestartImpact>>;
    realClock?: boolean;
    confirmRestart?: (input: {
      version: string;
      restartAt: number;
      signal: AbortSignal;
    }) => Promise<RestartDecision>;
  } = {},
) {
  let impactReads = 0;
  let current = options.initial ?? snapshot();
  const reports: HostUpdaterReport[] = [];
  const channel = {
    snapshot: mock(async () => {
      if (!options.impacts) return current;
      const impact = options.impacts[Math.min(impactReads, options.impacts.length - 1)]!;
      impactReads += 1;
      return {
        ...current,
        impact: {
          workingAgents: 0,
          waitingAgents: 0,
          activePipelines: 0,
          terminals: 0,
          hostServers: 0,
          measuredAt: "2026-10-16T12:00:00.000Z",
          ...impact,
        },
      };
    }),
    report: mock(async (report: HostUpdaterReport) => {
      reports.push(report);
      if (report.type === "job" && current.job?.id === report.jobId) {
        current = { ...current, job: { ...current.job, state: report.state } };
      }
      return current;
    }),
  };
  const engine = {
    checkSilently: mock(async () => undefined),
    stageForRemote: mock(async (onProgress?: (percent: number) => void) => {
      onProgress?.(50);
      if (options.staged instanceof Error) throw options.staged;
      return options.staged ?? { status: "staged" as const, version: "2.22.0" };
    }),
    installStaged: mock(async (_version: string) => options.install ?? true),
    setChannel: mock((_channel: string) => undefined),
  };
  const confirmRestart = mock(
    options.confirmRestart ?? (async () => options.decision ?? ("restart" as const)),
  );
  const beforeInstall = mock(async (_input: { jobId: string; version: string }) => undefined);
  const executor = createHostUpdateExecutor({
    channel,
    engine,
    confirmRestart,
    beforeInstall,
    ...(options.realClock ? {} : { now: () => Date.parse("2026-10-16T12:00:00.000Z") }),
    idlePollMs: 5,
    reportRetryMs: 1,
    log: { info: () => undefined, warn: () => undefined },
  });
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return {
    executor,
    channel,
    engine,
    confirmRestart,
    beforeInstall,
    reports,
    settle,
    set: (next: HostMaintenanceSnapshot) => (current = next),
  };
}

function jobStates(reports: HostUpdaterReport[]): string[] {
  return reports.flatMap((report) => (report.type === "job" ? [report.state] : []));
}

describe("createHostUpdateExecutor", () => {
  test("announces itself, then picks up a job that was already waiting", async () => {
    const harness = createHarness({ initial: snapshot({ job: job() }) });
    await harness.executor.start();
    await harness.settle();
    expect(harness.reports[0]).toEqual({ type: "ready" });
    expect(jobStates(harness.reports)).toEqual([
      "downloading",
      "downloading",
      "awaiting-restart",
      "restarting",
    ]);
    expect(harness.confirmRestart).toHaveBeenCalledWith({
      version: "2.22.0",
      restartAt: Date.parse("2026-10-16T12:01:00.000Z"),
      signal: expect.any(AbortSignal),
    });
    expect(harness.engine.installStaged).toHaveBeenCalledWith("2.22.0");
  });

  test("a postponed restart is reported and nothing is installed", async () => {
    const harness = createHarness({ initial: snapshot({ job: job() }), decision: "postpone" });
    await harness.executor.start();
    await harness.settle();
    expect(jobStates(harness.reports).at(-1)).toBe("postponed");
    expect(harness.engine.installStaged).not.toHaveBeenCalled();
  });

  test("fails the job when no update is available or the version differs", async () => {
    const upToDate = createHarness({
      initial: snapshot({ job: job() }),
      staged: { status: "up-to-date" },
    });
    await upToDate.executor.start();
    await upToDate.settle();
    expect(upToDate.reports.at(-1)).toMatchObject({ state: "failed" });
    expect((upToDate.reports.at(-1) as { error?: string }).error).toContain("newest release");

    const mismatch = createHarness({
      initial: snapshot({ job: job({ requestedVersion: "2.23.0" }) }),
    });
    await mismatch.executor.start();
    await mismatch.settle();
    expect((mismatch.reports.at(-1) as { error?: string }).error).toBe(
      "The newest release is 2.22.0, not 2.23.0",
    );
    expect(mismatch.confirmRestart).not.toHaveBeenCalled();
  });

  test("a download failure fails the job", async () => {
    const harness = createHarness({
      initial: snapshot({ job: job() }),
      staged: new Error("signature mismatch"),
    });
    await harness.executor.start();
    await harness.settle();
    expect(harness.reports.at(-1)).toMatchObject({ state: "failed", error: "signature mismatch" });
  });

  test("never installs unless the backend recorded the restart", async () => {
    const harness = createHarness({ initial: snapshot({ job: job() }) });
    harness.channel.report.mockImplementation(async (report: HostUpdaterReport) => {
      harness.reports.push(report);
      return snapshot({ job: job({ state: "failed" }) });
    });
    await harness.executor.start();
    await harness.settle();
    expect(harness.engine.installStaged).not.toHaveBeenCalled();
  });

  test("handles each job once, from events and after reconnects", async () => {
    const harness = createHarness();
    await harness.executor.start();
    const waiting = snapshot({ revision: 2, job: job({ id: "job-2" }) });
    harness.set(waiting);
    harness.executor.handleEvent(HOST_MAINTENANCE_EVENT, waiting);
    harness.executor.handleEvent(HOST_MAINTENANCE_EVENT, waiting);
    harness.executor.handleEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
    await harness.settle();
    expect(harness.engine.stageForRemote).toHaveBeenCalledTimes(1);
  });

  test("answers a check request with the check that ran", async () => {
    const harness = createHarness();
    await harness.executor.start();
    harness.engine.checkSilently.mockImplementation(async () => {
      harness.executor.reportCheck({
        latestVersion: "2.22.0",
        updateAvailable: true,
        checkedAt: "2026-10-16T12:00:01.000Z",
        error: null,
      });
    });
    harness.executor.handleEvent(
      HOST_MAINTENANCE_EVENT,
      snapshot({ checkRequest: { id: "check-1", requestedAt: "2026-10-16T12:00:00.000Z" } }),
    );
    await harness.settle();
    expect(harness.reports.at(-1)).toMatchObject({
      type: "check",
      latestVersion: "2.22.0",
      checkRequestId: "check-1",
    });
  });

  test("follows the host's update channel before running the check a switch asks for", async () => {
    const harness = createHarness();
    const order: string[] = [];
    harness.engine.setChannel.mockImplementation((channel) => void order.push(channel));
    harness.engine.checkSilently.mockImplementation(async () => void order.push("check"));
    await harness.executor.start();
    expect(order).toEqual(["stable"]);
    harness.executor.handleEvent(
      HOST_MAINTENANCE_EVENT,
      snapshot({
        revision: 2,
        updateChannel: "beta",
        checkRequest: { id: "check-2", requestedAt: "2026-10-16T12:00:00.000Z" },
      }),
    );
    await harness.settle();
    expect(order).toEqual(["stable", "beta", "check"]);
  });

  test("ignores events until it has started", () => {
    const harness = createHarness();
    harness.executor.handleEvent(HOST_MAINTENANCE_EVENT, snapshot({ job: job() }));
    expect(harness.engine.stageForRemote).not.toHaveBeenCalled();
  });
});

describe("createHostUpdateExecutor drain and cancel", () => {
  async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(5);
    }
  }

  test("when-idle waits for the host to go idle before the countdown", async () => {
    const harness = createHarness({
      realClock: true,
      initial: snapshot({
        job: job({ drain: "when-idle", idleDeadline: new Date(Date.now() + 60_000).toISOString() }),
      }),
      impacts: [{ workingAgents: 1 }, { activePipelines: 1 }, {}],
    });
    await harness.executor.start();
    await until(() => harness.engine.installStaged.mock.calls.length > 0);
    expect(jobStates(harness.reports)).toEqual([
      "downloading",
      "downloading",
      "waiting-for-idle",
      "awaiting-restart",
      "restarting",
    ]);
    expect(harness.channel.snapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(harness.beforeInstall).toHaveBeenCalledWith({ jobId: "job-1", version: "2.22.0" });
  });

  test("when-idle restarts anyway once its deadline passes", async () => {
    const harness = createHarness({
      realClock: true,
      initial: snapshot({
        job: job({ drain: "when-idle", idleDeadline: new Date(Date.now() + 40).toISOString() }),
      }),
      impacts: [{ workingAgents: 3 }],
    });
    await harness.executor.start();
    await until(() => harness.engine.installStaged.mock.calls.length > 0);
    expect(jobStates(harness.reports)).toContain("waiting-for-idle");
  });

  test("a cancel during the countdown closes it and installs nothing", async () => {
    const harness = createHarness({
      realClock: true,
      initial: snapshot({ job: job() }),
      confirmRestart: ({ signal }) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve("cancelled"))),
    });
    await harness.executor.start();
    await until(() => harness.confirmRestart.mock.calls.length > 0);
    harness.executor.handleEvent(
      HOST_MAINTENANCE_EVENT,
      snapshot({ revision: 5, job: job({ state: "cancelled" }) }),
    );
    await harness.settle();
    expect(harness.engine.installStaged).not.toHaveBeenCalled();
    expect(jobStates(harness.reports)).not.toContain("restarting");
  });

  test("a cancel during the download stops before the countdown", async () => {
    let finishStaging!: () => void;
    const harness = createHarness({ realClock: true, initial: snapshot({ job: job() }) });
    harness.engine.stageForRemote.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStaging = () => resolve({ status: "staged", version: "2.22.0" });
        }),
    );
    await harness.executor.start();
    await until(() => finishStaging !== undefined);
    harness.executor.handleEvent(
      HOST_MAINTENANCE_EVENT,
      snapshot({ revision: 5, job: job({ state: "cancelled" }) }),
    );
    finishStaging();
    await harness.settle();
    expect(harness.confirmRestart).not.toHaveBeenCalled();
  });
});

describe("confirmRestartWithCountdown", () => {
  const base = {
    version: "2.22.0",
    productName: "Orkestrator AI",
    notify: () => undefined,
  };

  test("Postpone postpones and Restart Now restarts", async () => {
    const restartAt = Date.now() + 60_000;
    const postpone = await confirmRestartWithCountdown({
      ...base,
      restartAt,
      window: {},
      showMessageBox: async () => ({ response: 1 }),
    });
    expect(postpone).toBe("postpone");
    const restart = await confirmRestartWithCountdown({
      ...base,
      restartAt,
      window: {},
      showMessageBox: async () => ({ response: 0 }),
    });
    expect(restart).toBe("restart");
  });

  test("an unanswered countdown restarts even though the dialog closes as cancelled", async () => {
    const decision = await confirmRestartWithCountdown({
      ...base,
      restartAt: Date.now() + 20,
      window: {},
      showMessageBox: (_window, options) =>
        new Promise((resolve) =>
          options.signal.addEventListener("abort", () => resolve({ response: 1 })),
        ),
    });
    expect(decision).toBe("restart");
  });

  test("without a window it notifies and restarts when the time is up", async () => {
    const notify = mock(() => undefined);
    const showMessageBox = mock(async () => ({ response: 1 }));
    const decision = await confirmRestartWithCountdown({
      ...base,
      notify,
      restartAt: Date.now() + 10,
      window: null,
      showMessageBox,
    });
    expect(decision).toBe("restart");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  test("a remote cancel closes the countdown", async () => {
    const cancel = new AbortController();
    const decision = confirmRestartWithCountdown({
      ...base,
      restartAt: Date.now() + 60_000,
      window: {},
      signal: cancel.signal,
      showMessageBox: (_window, options) =>
        new Promise((resolve) =>
          options.signal.addEventListener("abort", () => resolve({ response: 1 })),
        ),
    });
    cancel.abort();
    expect(await decision).toBe("cancelled");
  });
});

test("reannounces ready after the first POST fails, including reconnect", async () => {
  const harness = createHarness();
  const report = harness.channel.report.getMockImplementation()!;
  let readyAttempts = 0;
  harness.channel.report.mockImplementation(async (input) => {
    if (input.type === "ready" && ++readyAttempts === 1) throw new Error("offline");
    return report(input);
  });
  await harness.executor.start();
  harness.executor.handleEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
  await harness.settle();
  expect(readyAttempts).toBeGreaterThanOrEqual(2);
  const requested = snapshot({ job: job() });
  harness.set(requested);
  harness.executor.handleEvent(HOST_MAINTENANCE_EVENT, requested);
  await harness.settle();
  expect(harness.engine.stageForRemote).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  "lost restarting report is recovered (persisted before response lost: %s)",
  async (persisted) => {
    const harness = createHarness({ initial: snapshot({ job: job() }) });
    const report = harness.channel.report.getMockImplementation()!;
    let attempts = 0;
    harness.channel.report.mockImplementation(async (input) => {
      if (input.type === "job" && input.state === "restarting" && attempts++ === 0) {
        if (persisted) await report(input);
        throw new Error("response lost");
      }
      return report(input);
    });
    await harness.executor.start();
    const deadline = Date.now() + 1000;
    while (!harness.engine.installStaged.mock.calls.length && Date.now() < deadline)
      await Bun.sleep(5);
    expect(harness.engine.installStaged).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
  },
);

test("exhausted restarting report retries fail the job and allow later jobs", async () => {
  const harness = createHarness({ initial: snapshot({ job: job() }) });
  const report = harness.channel.report.getMockImplementation()!;
  harness.channel.report.mockImplementation(async (input) => {
    if (input.type === "job" && input.state === "restarting") throw new Error("offline");
    return report(input);
  });
  await harness.executor.start();
  const deadline = Date.now() + 1000;
  while (jobStates(harness.reports).at(-1) !== "failed" && Date.now() < deadline)
    await Bun.sleep(5);
  expect(jobStates(harness.reports).at(-1)).toBe("failed");
  expect(harness.engine.installStaged).not.toHaveBeenCalled();
  const next = snapshot({ job: job({ id: "next" }) });
  harness.set(next);
  harness.executor.handleEvent(HOST_MAINTENANCE_EVENT, next);
  await harness.settle();
  expect(harness.engine.stageForRemote).toHaveBeenCalledTimes(2);
  await Bun.sleep(20);
});

test("unavailable or unknown impact waits for a trustworthy idle reading", async () => {
  const harness = createHarness({
    initial: snapshot({
      job: job({ drain: "when-idle", idleDeadline: "2026-10-16T13:00:00.000Z" }),
    }),
  });
  let reads = 0;
  harness.channel.snapshot.mockImplementation(async () => {
    reads += 1;
    if (reads <= 3) throw new Error("authoritative readers unavailable");
    return snapshot({
      job: job(),
      impact: {
        workingAgents: 0,
        waitingAgents: 0,
        unknownAgents: reads < 6 ? 1 : 0,
        activePipelines: 0,
        terminals: 0,
        hostServers: 0,
        measuredAt: "2026-10-16T12:00:00Z",
      },
    });
  });
  await harness.executor.start();
  // Initial snapshot failed; reconnect retries readiness and the snapshot.
  harness.set(
    snapshot({ job: job({ drain: "when-idle", idleDeadline: "2026-10-16T13:00:00.000Z" }) }),
  );
  harness.executor.handleEvent(
    HOST_MAINTENANCE_EVENT,
    snapshot({ job: job({ drain: "when-idle", idleDeadline: "2026-10-16T13:00:00.000Z" }) }),
  );
  await Bun.sleep(8);
  expect(harness.confirmRestart).not.toHaveBeenCalled();
  const deadline = Date.now() + 1000;
  while (!harness.confirmRestart.mock.calls.length && Date.now() < deadline) await Bun.sleep(5);
  expect(harness.confirmRestart).toHaveBeenCalledTimes(1);
});
