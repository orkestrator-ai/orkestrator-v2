import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  HOST_MAINTENANCE_EVENT,
  type HostMaintenanceSnapshot,
  type HostTask,
} from "@orkestrator/protocol/host-maintenance";
import { hostMaintenanceSnapshotFixture as snapshot } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { invoke } from "@/lib/native/backend";
import { useMachineMaintenance } from "./useMachineMaintenance";
import { useMaintenanceSummaries } from "./useMaintenanceSummaries";
import type { MachineEntry } from "./machine-list";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const remote: MachineEntry = {
  key: "node:bk_leaf",
  role: "node",
  nodeId: "bk_leaf",
  maintenance: true,
  name: "Leaf",
  colorToken: undefined,
  address: null,
  via: "HTTPS",
  connected: true,
  statusText: "Connected",
  current: false,
};
const self: MachineEntry = { ...remote, key: "self", role: "self", nodeId: null, current: true };
const task: HostTask = {
  id: "repair-1",
  kind: "toolchain-repair",
  state: "running",
  stage: null,
  error: null,
  result: null,
  startedAt: "t",
  updatedAt: "t",
  completedAt: null,
};

afterEach(() => {
  cleanup();
  mock.restore();
  invokeMock.mockReset();
  delete window.orkestratorPortal;
});

// Capture only the hook's polling clock; React's own waitFor timers stay real.
function pollingClock() {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let id = 1_000_000;
  const realSetInterval = globalThis.setInterval.bind(globalThis);
  const realClearInterval = globalThis.clearInterval.bind(globalThis);
  spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
    if (![2_500, 20_000, 300_000].includes(delay)) return realSetInterval(callback, delay);
    timers.set(++id, { callback, delay });
    return id;
  }) as typeof setInterval);
  spyOn(globalThis, "clearInterval").mockImplementation(((timer: number) => {
    if (!timers.delete(timer)) realClearInterval(timer);
  }) as typeof clearInterval);
  return {
    timers,
    tick: async (delay: number) => {
      await act(async () => {
        for (const timer of Array.from(timers.values()))
          if (timer.delay === delay) timer.callback();
      });
    },
  };
}

test("remote maintenance polls idle and busy, survives errors and rehydrates after reconnect", async () => {
  const clock = pollingClock();
  let next = snapshot({ revision: 1 });
  let fail = false;
  const reads: boolean[] = [];
  invokeMock.mockImplementation(async (_command: string, args: Record<string, unknown>) => {
    reads.push((args.args as { detail?: boolean }).detail === true);
    if (fail) throw new Error("offline");
    return { outcome: "ok", result: next };
  });
  const { result, rerender } = renderHook(
    ({ reachable }) => useMachineMaintenance({ ...remote, maintenance: reachable }),
    { initialProps: { reachable: true } },
  );
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));
  expect(reads).toEqual([true]);
  next = snapshot({ revision: 2, tasks: { "toolchain-repair": task } });
  await clock.tick(20_000);
  expect(reads).toEqual([true, false]);
  expect(Array.from(clock.timers.values()).map((t) => t.delay)).toEqual([2_500]);
  fail = true;
  await clock.tick(2_500);
  expect(result.current.error).toBe("offline");
  expect(result.current.snapshot?.revision).toBe(2);
  rerender({ reachable: false });
  expect(clock.timers.size).toBe(0);
  fail = false;
  next = snapshot({
    revision: 3,
    tools: [],
    tasks: { "toolchain-repair": { ...task, state: "succeeded" } },
  });
  rerender({ reachable: true });
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(3));
  expect(result.current.error).toBeNull();
  expect(result.current.snapshot?.tools).toEqual([]);
  expect(Array.from(clock.timers.values()).map((t) => t.delay)).toEqual([20_000]);
});

for (const prior of [null, { ...task, id: "older", state: "succeeded" as const }]) {
  test(`a new task first observed completed refreshes details (${prior ? "older task" : "no task"})`, async () => {
    const clock = pollingClock();
    let next = snapshot({
      revision: 1,
      tasks: prior ? { "toolchain-repair": prior } : {},
      tools: [{ name: "codex", source: "missing", pinnedVersion: "1", installedVersion: null }],
    });
    const reads: boolean[] = [];
    invokeMock.mockImplementation(async (_command: string, args: Record<string, unknown>) => {
      const detail = (args.args as { detail?: boolean }).detail === true;
      reads.push(detail);
      return {
        outcome: "ok",
        result: detail ? next : { ...next, tools: undefined, image: undefined },
      };
    });
    const { result } = renderHook(() => useMachineMaintenance(remote));
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));
    const before = reads.length;
    next = snapshot({
      revision: 2,
      tasks: { "toolchain-repair": { ...task, state: "succeeded" } },
      tools: [],
      image: null,
    });
    await clock.tick(20_000);
    await waitFor(() => expect(result.current.snapshot?.tools).toEqual([]));
    expect(result.current.snapshot?.image).toBeNull();
    expect(reads.slice(before)).toEqual([false, true]);
    await clock.tick(20_000);
    expect(reads.slice(before)).toEqual([false, true, false]);
  });
}

test("late remote reads cannot overwrite a reconnected client", async () => {
  let finish!: (value: unknown) => void;
  invokeMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    ({ reachable }) => useMachineMaintenance({ ...remote, maintenance: reachable }),
    { initialProps: { reachable: true } },
  );
  rerender({ reachable: false });
  invokeMock.mockResolvedValue({ outcome: "ok", result: snapshot({ revision: 2 }) });
  rerender({ reachable: true });
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(2));
  await act(async () => finish({ outcome: "ok", result: snapshot({ revision: 99 }) }));
  expect(result.current.snapshot?.revision).toBe(2);
});

test("summary reads retain per-machine errors and details, reject stale revisions and follow self events", async () => {
  const clock = pollingClock();
  const listeners = new Map<string, (payload: unknown) => void>();
  let finishSelf!: (value: HostMaintenanceSnapshot) => void;
  let failRemote = false;
  let remoteSnapshot = snapshot({ revision: 4, tools: [] });
  window.orkestratorPortal = {
    invoke: mock((command: string) => {
      if (command === "get_host_maintenance")
        return new Promise((resolve) => {
          finishSelf = resolve;
        });
      return failRemote
        ? Promise.reject(new Error("leaf offline"))
        : Promise.resolve({ outcome: "ok", result: remoteSnapshot });
    }),
    listen: (event: string, handler: (payload: unknown) => void) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  } as never;
  const { result } = renderHook(() => useMaintenanceSummaries([self, remote]));
  await waitFor(() => expect(result.current.summaries[remote.key]?.snapshot?.revision).toBe(4));
  await act(async () => finishSelf(snapshot({ revision: 5, tools: [] })));
  failRemote = true;
  await clock.tick(300_000);
  await waitFor(() => expect(result.current.summaries[remote.key]?.error).toBe("leaf offline"));
  await act(async () => finishSelf(snapshot({ revision: 6 })));
  expect(result.current.summaries[remote.key]?.snapshot?.revision).toBe(4);
  expect(result.current.summaries[remote.key]?.error).toBe("leaf offline");
  expect(result.current.summaries[self.key]?.snapshot?.tools).toEqual([]);
  act(() => listeners.get(HOST_MAINTENANCE_EVENT)?.(snapshot({ revision: 8, version: "new" })));
  act(() => listeners.get(HOST_MAINTENANCE_EVENT)?.(snapshot({ revision: 7, version: "stale" })));
  expect(result.current.summaries[self.key]?.snapshot?.version).toBe("new");
  failRemote = false;
  remoteSnapshot = snapshot({ revision: 3 });
  await clock.tick(300_000);
  expect(result.current.summaries[remote.key]?.snapshot?.revision).toBe(4);
  expect(result.current.summaries[remote.key]?.error).toBe("leaf offline");
  remoteSnapshot = snapshot({ revision: 5 });
  await clock.tick(300_000);
  expect(result.current.summaries[remote.key]?.error).toBeNull();
});
