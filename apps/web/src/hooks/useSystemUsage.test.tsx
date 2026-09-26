import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import {
  flushMicrotasks,
  installFakeReadCoordinator,
  type FakeReadEnvironment,
} from "@/lib/testing/read-coordinator";
import {
  SYSTEM_USAGE_STALE_AFTER_MS,
  useEnvironmentProcessUsage,
  useSystemUsage,
  type UsageView,
} from "./useSystemUsage";
import type { SystemUsageSnapshot } from "@/lib/backend";

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

function Processes({ intervalMs }: { intervalMs: number }) {
  useEnvironmentProcessUsage({ intervalMs });
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
