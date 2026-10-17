import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  HOST_MAINTENANCE_EVENT,
  type HostMaintenanceSnapshot,
  type HostTask,
} from "@orkestrator/protocol/host-maintenance";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import * as events from "@/lib/native/events";
import * as backend from "@/lib/backend";
import { publishConnections } from "@/lib/connections";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { useHostMaintenance } from "./useHostMaintenance";

const original = window.orkestrator;
let listeners: Map<string, Set<(payload: unknown) => void>>;
beforeEach(() => {
  listeners = new Map();
  spyOn(events, "listen").mockImplementation(async (event, handler, options) => {
    const wrapped = (payload: unknown) => handler({ payload } as never);
    const set = listeners.get(event) ?? new Set();
    listeners.set(event, set);
    set.add(wrapped);
    const unlisten = () => {
      set.delete(wrapped);
    };
    options?.signal?.addEventListener("abort", unlisten, { once: true });
    return unlisten;
  });
  window.orkestrator = {
    listen: (event: string, handler: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(handler);
      return () => set.delete(handler);
    },
  } as unknown as Window["orkestrator"];
});
afterEach(() => {
  cleanup();
  mock.restore();
  window.orkestrator = original;
});
function emit(event: string, payload?: unknown) {
  act(() => {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  });
}
function change(id: string) {
  act(() =>
    publishConnections({ activeConnectionId: id, connections: [] } as unknown as ConnectionList),
  );
}

test("events reject stale revisions and reconnect reads replace missed updates", async () => {
  let current = hostMaintenanceSnapshotFixture({ revision: 5 });
  spyOn(backend, "getHostMaintenance").mockImplementation(async () => current);
  const { result } = renderHook(() => useHostMaintenance());
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(5));
  emit(HOST_MAINTENANCE_EVENT, hostMaintenanceSnapshotFixture({ revision: 4, version: "1.0.0" }));
  expect(result.current.snapshot?.revision).toBe(5);
  current = hostMaintenanceSnapshotFixture({ revision: 7 });
  emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT);
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(7));
});

test("a backend switch accepts lower revisions and fences late reads from the prior host", async () => {
  const read = spyOn(backend, "getHostMaintenance").mockResolvedValue(
    hostMaintenanceSnapshotFixture({ revision: 5, version: "2.21.1" }),
  );
  const { result } = renderHook(() => useHostMaintenance({ detail: true }));
  change("host-a");
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(5));
  let finish!: (value: HostMaintenanceSnapshot) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.reload();
  });
  read.mockResolvedValue(hostMaintenanceSnapshotFixture({ revision: 0, version: "2.22.0" }));
  change("host-b");
  await waitFor(() => expect(result.current.snapshot?.version).toBe("2.22.0"));
  await act(async () => {
    finish(hostMaintenanceSnapshotFixture({ revision: 99, version: "2.21.1" }));
    await pending;
  });
  expect(result.current.snapshot?.revision).toBe(0);
  emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT);
  await waitFor(() => expect(result.current.snapshot?.version).toBe("2.22.0"));
});

const task: HostTask = {
  id: "repair",
  kind: "toolchain-repair",
  state: "running",
  stage: "Checking",
  error: null,
  result: null,
  startedAt: "2026-10-16T12:00:00Z",
  updatedAt: "2026-10-16T12:00:00Z",
  completedAt: null,
};
test("completion while Settings is unmounted rehydrates details on return", async () => {
  let current = hostMaintenanceSnapshotFixture({
    revision: 1,
    tasks: { "toolchain-repair": task },
  });
  const read = spyOn(backend, "getHostMaintenance").mockImplementation(async () => current);
  const first = renderHook(() => useHostMaintenance({ detail: true }));
  await waitFor(() => expect(first.result.current.snapshot?.revision).toBe(1));
  first.unmount();
  current = hostMaintenanceSnapshotFixture({
    revision: 2,
    tasks: { "toolchain-repair": { ...task, state: "succeeded" } },
    tools: [
      { name: "claude", source: "managed", installedVersion: "2.1.310", pinnedVersion: "2.1.310" },
    ],
  });
  emit(HOST_MAINTENANCE_EVENT, current);
  const second = renderHook(() => useHostMaintenance({ detail: true }));
  await waitFor(() =>
    expect(second.result.current.snapshot?.tools?.[0]?.installedVersion).toBe("2.1.310"),
  );
  expect(read).toHaveBeenLastCalledWith(true);
  expect(second.result.current.snapshot?.tasks["toolchain-repair"]?.state).toBe("succeeded");
});

test("a completion event refreshes detailed tool and image readings", async () => {
  let current = hostMaintenanceSnapshotFixture({
    revision: 1,
    tasks: { "toolchain-repair": task },
  });
  const read = spyOn(backend, "getHostMaintenance").mockImplementation(async () => current);
  const { result } = renderHook(() => useHostMaintenance({ detail: true }));
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));
  current = hostMaintenanceSnapshotFixture({
    revision: 2,
    tasks: { "toolchain-repair": { ...task, state: "succeeded" } },
    tools: [],
  });
  emit(HOST_MAINTENANCE_EVENT, current);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.snapshot?.tools).toEqual([]));
});
