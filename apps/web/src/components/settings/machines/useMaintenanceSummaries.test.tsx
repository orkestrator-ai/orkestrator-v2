import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { useMaintenanceSummaries } from "./useMaintenanceSummaries";
import type { MachineEntry } from "./machine-list";

const invokeMock = invoke as ReturnType<typeof mock>;
afterEach(() => {
  cleanup();
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
