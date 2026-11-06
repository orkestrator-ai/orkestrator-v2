import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import {
  hostMaintenanceSnapshotFixture,
  hostUpdateJobFixture,
} from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { useMachineBulkUpdateStore } from "@/stores/machineBulkUpdateStore";
import { useMaintenanceSummaries } from "./useMaintenanceSummaries";
import type { MachineEntry } from "./machine-list";

const invokeMock = invoke as ReturnType<typeof mock>;
afterEach(() => {
  cleanup();
  mock.restore();
  useMachineBulkUpdateStore.setState({ outcomes: {}, snapshots: {}, running: false });
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

function machine(id: string): MachineEntry {
  return {
    key: `node:${id}`,
    nodeId: id,
    role: "node",
    name: id,
    colorToken: "teal",
    address: null,
    via: "HTTPS",
    connected: true,
    statusText: "Connected",
    current: false,
    maintenance: true,
  };
}

test("reordering the same reachable set retains in-flight detailed maintenance reads", async () => {
  const pending: Array<(value: unknown) => void> = [];
  invokeMock.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const a = machine("bk_a");
  const b = machine("bk_b");
  const { result, rerender } = renderHook(({ entries }) => useMaintenanceSummaries(entries), {
    initialProps: { entries: [a, b] },
  });
  expect(invokeMock).toHaveBeenCalledTimes(2);
  expect(
    invokeMock.mock.calls.map((call) => [
      call[0],
      { nodeId: call[1].nodeId, command: call[1].command, args: call[1].args },
    ]),
  ).toEqual([
    ["invoke_on_node", { nodeId: "bk_a", command: "get_host_maintenance", args: { detail: true } }],
    ["invoke_on_node", { nodeId: "bk_b", command: "get_host_maintenance", args: { detail: true } }],
  ]);
  rerender({ entries: [{ ...b }, { ...a }] });
  expect(invokeMock).toHaveBeenCalledTimes(2);
  const snapshot = hostMaintenanceSnapshotFixture();
  await act(async () => {
    for (const resolve of pending) resolve({ outcome: "ok", result: snapshot });
  });
  expect(result.current.summaries[a.key]?.snapshot).toEqual(snapshot);
  expect(result.current.summaries[b.key]?.snapshot).toEqual(snapshot);
  rerender({ entries: [a, { ...b, maintenance: false }] });
  expect(invokeMock).toHaveBeenCalledTimes(3);
});

function summaryClock() {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let id = 100000;
  const realSet = globalThis.setInterval.bind(globalThis);
  const realClear = globalThis.clearInterval.bind(globalThis);
  spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
    if (![3000, 300000].includes(delay)) return realSet(callback, delay);
    timers.set(++id, { callback, delay });
    return id;
  }) as typeof setInterval);
  spyOn(globalThis, "clearInterval").mockImplementation(((timer: number) => {
    if (!timers.delete(timer)) realClear(timer);
  }) as typeof clearInterval);
  return {
    timers,
    count: (delay: number) =>
      Array.from(timers.values()).filter((timer) => timer.delay === delay).length,
    tick: async (delay: number) =>
      act(async () => {
        for (const timer of Array.from(timers.values()))
          if (timer.delay === delay) timer.callback();
      }),
  };
}

for (const pendingCheck of [false, true]) {
  test(`remote ${pendingCheck ? "pending check" : "active job"} starts fast polling, survives restart errors, and stops at terminal state`, async () => {
    const clock = summaryClock();
    const remote = machine("bk_remote");
    const self = { ...machine("bk_self"), key: "self", role: "self" as const };
    let next = hostMaintenanceSnapshotFixture({
      revision: 2,
      ...(pendingCheck
        ? { checkRequest: { id: "check", requestedAt: "t" } }
        : { job: hostUpdateJobFixture({ state: "restarting" }) }),
    });
    let fail = false;
    const reads: string[] = [];
    invokeMock.mockImplementation(async (command: string) => {
      reads.push(command);
      if (fail) throw new Error("restarting");
      return command === "invoke_on_node" ? { outcome: "ok", result: next } : next;
    });
    const { result, rerender, unmount } = renderHook(
      ({ reachable }) => useMaintenanceSummaries([self, { ...remote, maintenance: reachable }]),
      { initialProps: { reachable: true } },
    );
    await waitFor(() => expect(result.current.summaries[remote.key]?.snapshot?.revision).toBe(2));
    expect(clock.count(3000)).toBe(1);
    const initial = reads.length;
    fail = true;
    await clock.tick(3000);
    expect(reads.slice(initial)).toEqual(["invoke_on_node"]); // self follows its events
    expect(result.current.summaries[remote.key]?.snapshot?.revision).toBe(2);
    expect(clock.count(3000)).toBe(1);
    rerender({ reachable: false });
    expect(clock.count(3000)).toBe(0);
    fail = false;
    next = hostMaintenanceSnapshotFixture({
      revision: 3,
      job: hostUpdateJobFixture({ state: "downloading" }),
    });
    rerender({ reachable: true });
    await waitFor(() => expect(result.current.summaries[remote.key]?.snapshot?.revision).toBe(3));
    expect(clock.count(3000)).toBe(1);
    next = hostMaintenanceSnapshotFixture({
      revision: 4,
      job: hostUpdateJobFixture({ state: "succeeded" }),
    });
    await clock.tick(3000);
    expect(result.current.summaries[remote.key]?.snapshot?.job?.state).toBe("succeeded");
    expect(clock.count(3000)).toBe(0);
    const settled = reads.length;
    await clock.tick(3000);
    expect(reads.length).toBe(settled);
    unmount();
    expect(clock.timers.size).toBe(0);
  });
}

test("unmount cancels active polling and ignores an already pending poll", async () => {
  const clock = summaryClock();
  const remote = machine("bk_remote");
  invokeMock.mockResolvedValue({
    outcome: "ok",
    result: hostMaintenanceSnapshotFixture({ job: hostUpdateJobFixture() }),
  });
  const { unmount } = renderHook(() => useMaintenanceSummaries([remote]));
  await waitFor(() => expect(clock.count(3000)).toBe(1));
  let release!: (value: unknown) => void;
  invokeMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await clock.tick(3000);
  unmount();
  expect(clock.timers.size).toBe(0);
  await act(async () =>
    release({ outcome: "ok", result: hostMaintenanceSnapshotFixture({ revision: 10 }) }),
  );
  expect(useMachineBulkUpdateStore.getState().snapshots).toEqual({});
});

test("starting another batch retains the earlier accepted job for remount polling", async () => {
  const clock = summaryClock();
  const remote = machine("bk_remote");
  const active = hostMaintenanceSnapshotFixture({ revision: 3, job: hostUpdateJobFixture() });
  useMachineBulkUpdateStore
    .getState()
    .report(remote.key, { state: "requested", version: null }, active);
  useMachineBulkUpdateStore.getState().start(["another-machine"]);
  // The first read is older than the accepted job; it must not stop polling.
  invokeMock.mockResolvedValue({ outcome: "ok", result: hostMaintenanceSnapshotFixture() });
  const { result } = renderHook(() => useMaintenanceSummaries([remote]));
  await act(async () => undefined);
  expect(result.current.summaries[remote.key]?.snapshot?.job?.id).toBe(active.job!.id);
  expect(clock.count(3000)).toBe(1);
});
