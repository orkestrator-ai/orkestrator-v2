import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { READ_RETRY_MAX_MS, resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import {
  flushMicrotasks,
  installFakeReadCoordinator,
  type FakeReadEnvironment,
} from "@/lib/testing/read-coordinator";
import {
  SYSTEM_USAGE_STALE_AFTER_MS,
  USAGE_READ_TIMEOUT_MS,
  useEnvironmentProcessUsage,
  useSystemUsage,
  useMachineSystemUsage,
  type UsageView,
} from "./useSystemUsage";
import type { EnvironmentProcessUsageSnapshot, SystemUsageSnapshot } from "@/lib/backend";

import { portalStore } from "@/lib/portal/portal-store";
import type { BackendId } from "@orkestrator/protocol/federation";

const nativeInvokeMock = nativeInvoke as ReturnType<typeof mock>;

let reads: FakeReadEnvironment;
let usageCalls: number[];
let processCalls: number[];
let nextUsage: () => Promise<unknown>;

async function advance(ms: number) {
  await act(async () => {
    await flushMicrotasks();
    await reads.clock.advance(ms);
  });
}

function sample(cpuPercent: number) {
  return {
    cpuPercent,
    ramPercent: 40,
    gpuPercent: null,
    diskPercent: 50,
    sampledAt: new Date(Date.UTC(2026, 8, 25, 10, 0, cpuPercent)).toISOString(),
  };
}

const views = new Map<string, UsageView<SystemUsageSnapshot>>();

function Meter({ id, intervalMs, active }: { id: string; intervalMs: number; active?: boolean }) {
  views.set(id, useSystemUsage({ intervalMs, active }));
  return null;
}

const processViews = new Map<string, UsageView<EnvironmentProcessUsageSnapshot>>();

function Processes({ intervalMs }: { intervalMs: number }) {
  processViews.set("processes", useEnvironmentProcessUsage({ intervalMs }));
  return null;
}

beforeEach(() => {
  reads = installFakeReadCoordinator();
  usageCalls = [];
  processCalls = [];
  views.clear();
  let cpu = 0;
  nextUsage = async () => sample((cpu += 1));
  nativeInvokeMock.mockReset();
  nativeInvokeMock.mockImplementation(async (command: string) => {
    if (command === "get_system_usage") {
      usageCalls.push(reads.clock.now());
      return nextUsage();
    }
    if (command === "get_environment_process_usage") {
      processCalls.push(reads.clock.now());
      return { environments: [], sampledAt: new Date().toISOString() };
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  mock.restore();
});

describe("useSystemUsage", () => {
  test("title bar and popover combine into one read at the fastest cadence", async () => {
    const { rerender } = render(<Meter id="title" intervalMs={5_000} />);
    expect(usageCalls).toEqual([0]);
    await advance(10_000);
    expect(usageCalls).toEqual([0, 5_000, 10_000]);

    // Popover opens at 11 s: its 3 s demand wins; no extra read on open because
    // the shared sample is younger than the new cadence.
    await advance(1_000);
    rerender(
      <>
        <Meter id="title" intervalMs={5_000} />
        <Meter id="popover" intervalMs={3_000} />
      </>,
    );
    await advance(0);
    expect(usageCalls).toEqual([0, 5_000, 10_000]);
    expect(views.get("popover")?.sample?.cpuPercent).toBe(3);
    await advance(9_000);
    expect(usageCalls).toEqual([0, 5_000, 10_000, 14_000, 17_000, 20_000]);
    // Both consumers show the same sample: one physical read per window.
    expect(views.get("title")?.sampledAt).toBe(views.get("popover")?.sampledAt);

    // Closing the faster consumer restores the title bar's five seconds.
    rerender(<Meter id="title" intervalMs={5_000} />);
    await advance(15_000);
    expect(usageCalls).toEqual([0, 5_000, 10_000, 14_000, 17_000, 20_000, 25_000, 30_000, 35_000]);
  });

  test("an inactive consumer adds no demand", async () => {
    render(
      <>
        <Meter id="title" intervalMs={5_000} />
        <Meter id="popover" intervalMs={3_000} active={false} />
      </>,
    );
    await advance(10_000);
    expect(usageCalls).toEqual([0, 5_000, 10_000]);
    expect(views.get("popover")?.sample).toBeNull();
  });

  test("hidden documents read nothing; return reconciles once", async () => {
    render(
      <>
        <Meter id="title" intervalMs={5_000} />
        <Meter id="popover" intervalMs={3_000} />
      </>,
    );
    expect(usageCalls).toEqual([0]);
    act(() => reads.document.setVisibility("hidden"));
    await advance(120_000);
    expect(usageCalls).toEqual([0]);
    act(() => reads.document.setVisibility("visible"));
    // Focus arriving with visibility is coalesced into the same reconcile.
    act(() => reads.window.dispatch("focus"));
    await advance(2_000);
    expect(usageCalls).toHaveLength(2);
  });

  test("a failed refresh keeps the sample and its time; it becomes stale only by age", async () => {
    render(<Meter id="title" intervalMs={5_000} />);
    await advance(0);
    const first = views.get("title")!;
    expect(first.sample?.cpuPercent).toBe(1);
    expect(first.stale).toBe(false);

    nextUsage = async () => {
      throw new Error("backend unavailable");
    };
    await advance(5_000);
    const failed = views.get("title")!;
    expect(failed.failed).toBe(true);
    expect(failed.sampledAt).toBe(first.sampledAt);
    expect(failed.observedAt).toBe(first.observedAt);
    expect(failed.stale).toBe(false);

    await advance(SYSTEM_USAGE_STALE_AFTER_MS - 5_000 + 1);
    expect(views.get("title")!.stale).toBe(true);
    expect(views.get("title")!.sampledAt).toBe(first.sampledAt);
  });

  test("a malformed sample is a failed read, never a new measurement", async () => {
    nextUsage = async () => ({ cpuPercent: "high" });
    render(<Meter id="title" intervalMs={5_000} />);
    await advance(0);
    expect(views.get("title")!.sample).toBeNull();
    expect(views.get("title")!.failed).toBe(true);
  });

  test("a read that never answers fails on time and sends no more until it settles", async () => {
    let release!: (value: unknown) => void;
    nextUsage = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    render(<Meter id="title" intervalMs={5_000} />);
    await advance(USAGE_READ_TIMEOUT_MS - 1);
    expect(views.get("title")!.failed).toBe(false);
    await advance(1);
    expect(views.get("title")!.failed).toBe(true);

    // Retries fail without adding requests that could never be aborted.
    await advance(120_000);
    expect(usageCalls).toHaveLength(1);
    expect(views.get("title")!.failed).toBe(true);

    // The late answer describes the past, so it is dropped; the next retry is new.
    const stuck = release;
    nextUsage = async () => sample(42);
    stuck(sample(7));
    await advance(0);
    expect(views.get("title")!.sample).toBeNull();
    await advance(READ_RETRY_MAX_MS);
    expect(usageCalls.length).toBeGreaterThan(1);
    expect(views.get("title")!.sample?.cpuPercent).toBe(42);
    expect(views.get("title")!.failed).toBe(false);
  });

  test("a timed-out request that later rejects releases the outstanding guard", async () => {
    let reject!: (error: Error) => void;
    nextUsage = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    render(<Meter id="title" intervalMs={5_000} />);
    await advance(USAGE_READ_TIMEOUT_MS + READ_RETRY_MAX_MS);
    expect(usageCalls).toHaveLength(1);
    expect(views.get("title")!.failed).toBe(true);
    reject(new Error("late transport failure"));
    nextUsage = async () => sample(42);
    await advance(READ_RETRY_MAX_MS);
    expect(usageCalls.length).toBeGreaterThan(1);
    expect(views.get("title")!.sample?.cpuPercent).toBe(42);
    expect(views.get("title")!.failed).toBe(false);
  });

  test("an outstanding request does not block reads of a new server", async () => {
    reads.coordinator.setConnection("local");
    nextUsage = () => new Promise(() => {});
    render(<Meter id="title" intervalMs={5_000} />);
    await advance(USAGE_READ_TIMEOUT_MS);
    expect(views.get("title")!.failed).toBe(true);

    nextUsage = async () => sample(42);
    act(() => reads.coordinator.setConnection("remote"));
    await advance(2_000);
    expect(usageCalls).toHaveLength(2);
    expect(views.get("title")!.sample?.cpuPercent).toBe(42);
    expect(views.get("title")!.failed).toBe(false);
  });

  test("failed holds while a retry is in flight, so the view does not flicker", async () => {
    nextUsage = async () => {
      throw new Error("backend unavailable");
    };
    render(<Meter id="title" intervalMs={5_000} />);
    await advance(0);
    expect(views.get("title")!.failed).toBe(true);

    let release!: (value: unknown) => void;
    nextUsage = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    // A first failure retries at the healthy cadence.
    await advance(5_000);
    expect(usageCalls).toHaveLength(2);
    expect(views.get("title")!.failed).toBe(true);

    release(sample(9));
    await advance(0);
    expect(views.get("title")!.failed).toBe(false);
    expect(views.get("title")!.sample?.cpuPercent).toBe(9);
  });

  test("a backend without the command reports failed; it is not left looking like loading", async () => {
    nextUsage = async () => {
      throw new Error("Unknown backend command: get_system_usage");
    };
    render(<Meter id="title" intervalMs={5_000} />);
    await advance(60_000);
    expect(usageCalls).toHaveLength(1);
    expect(views.get("title")!.failed).toBe(true);
  });

  test("a server switch discards the old backend's sample and a late answer", async () => {
    reads.coordinator.setConnection("local");
    let release!: (value: unknown) => void;
    nextUsage = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    render(<Meter id="title" intervalMs={5_000} />);
    const lateAnswer = release;
    nextUsage = async () => sample(42);
    act(() => reads.coordinator.setConnection("remote"));
    await advance(2_000);
    expect(usageCalls).toHaveLength(2);
    expect(views.get("title")!.sample?.cpuPercent).toBe(42);
    lateAnswer(sample(7));
    await advance(0);
    expect(views.get("title")!.sample?.cpuPercent).toBe(42);
  });

  test("a budgeted partial enumeration reaches consumers before the client deadline", async () => {
    const partial: EnvironmentProcessUsageSnapshot = {
      environments: [
        {
          environmentId: "completed",
          environmentName: "Completed probe",
          projectId: "p",
          environmentType: "containerized",
          processes: [],
          totalCpuPercent: 0,
          totalRssKb: 0,
          processCount: 0,
          truncated: false,
        },
        {
          environmentId: "skipped",
          environmentName: "Budget exhausted",
          projectId: "p",
          environmentType: "containerized",
          processes: [],
          totalCpuPercent: 0,
          totalRssKb: 0,
          processCount: 0,
          truncated: true,
        },
      ],
      sampledAt: new Date().toISOString(),
      truncated: true,
    };
    nativeInvokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          reads.clock.setTimeout(() => resolve(partial), 12_000);
        }),
    );
    render(<Processes intervalMs={3_000} />);
    await advance(12_000);
    expect(processViews.get("processes")?.sample).toEqual(partial);
    expect(processViews.get("processes")?.failed).toBe(false);
    expect(processViews.get("processes")?.sample?.truncated).toBe(true);
  });

  test("process usage is a separate demand-driven key", async () => {
    const { rerender } = render(<Meter id="title" intervalMs={5_000} />);
    await advance(6_000);
    expect(processCalls).toEqual([]);
    rerender(
      <>
        <Meter id="title" intervalMs={5_000} />
        <Processes intervalMs={3_000} />
      </>,
    );
    await advance(6_000);
    expect(processCalls).toEqual([6_000, 9_000, 12_000]);
    // The host meters kept their own cadence.
    expect(usageCalls).toEqual([0, 5_000, 10_000]);
    rerender(<Meter id="title" intervalMs={5_000} />);
    await advance(30_000);
    expect(processCalls).toHaveLength(3);
  });
});

function MachineMeter({ id, bound }: { id: string; bound: boolean }) {
  views.set(id, useMachineSystemUsage({ nodeId: id as BackendId, bound, intervalMs: 5_000 }));
  return null;
}

for (const boundId of ["bk_self", "bk_workspace"]) {
  test(`bound usage on ${boundId} shares the title meter; other nodes keep separate routed reads`, async () => {
    const routed = spyOn(portalStore, "invokeOnNode").mockImplementation(
      async (nodeId) =>
        sample(nodeId === "bk_self" ? 21 : nodeId === "bk_workspace" ? 31 : 41) as never,
    );
    const remoteId = boundId === "bk_self" ? "bk_workspace" : "bk_self";
    render(
      <>
        <Meter id="title" intervalMs={5_000} />
        <MachineMeter id={boundId} bound />
        <MachineMeter id={remoteId} bound={false} />
        <MachineMeter id="bk_other" bound={false} />
      </>,
    );
    await advance(0);
    expect(usageCalls).toEqual([0]);
    expect(views.get(boundId)?.sample).toEqual(views.get("title")?.sample);
    expect(routed).toHaveBeenCalledWith(remoteId, "get_system_usage");
    expect(routed).toHaveBeenCalledWith("bk_other", "get_system_usage");
    expect(routed).toHaveBeenCalledTimes(2);
    expect(views.get(remoteId)?.sample?.cpuPercent).toBe(remoteId === "bk_self" ? 21 : 31);
    expect(views.get("bk_other")?.sample?.cpuPercent).toBe(41);
    await advance(5_000);
    expect(usageCalls).toEqual([0, 5_000]);
    expect(routed).toHaveBeenCalledTimes(4);
  });
}
