import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { BackendId, EnvironmentRef } from "@orkestrator/protocol/federation";
import { RELAYED_NODE_EVENT } from "@orkestrator/protocol/node-events";
import { NATIVE_AGENT_ACTIVITY_EVENT } from "@orkestrator/protocol/native-agent-observation";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { EnvironmentAgentSummary } from "@/components/environments/EnvironmentAgentSummary";
import { invoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import { nodeAgentSummarySource, useNodeEnvironment } from "./node-environment-reads";
import { resetNodeEventsForTests } from "./node-events";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const listenMock = listen as unknown as ReturnType<typeof mock>;
const LEAF = "bk_leaf" as BackendId;
const ref = { backendId: LEAF, environmentId: "env-1" } as EnvironmentRef;
let callbacks: Map<string, (event: { payload: unknown }) => void>;
let pending: Array<{ command: string; resolve: (value: unknown) => void; reject: () => void }>;
let order: string[];
async function settle(ms = 0) {
  await act(async () => {
    await Bun.sleep(ms);
  });
}
function event(event: string, payload: unknown) {
  callbacks.get(RELAYED_NODE_EVENT)!({ payload: { nodeId: LEAF, kind: "event", event, payload } });
}
function resync() {
  callbacks.get(RELAYED_NODE_EVENT)!({ payload: { nodeId: LEAF, kind: "resync" } });
}
function registry(working: number) {
  return {
    generatedAt: new Date(0).toISOString(),
    entries: [],
    environments: [
      {
        environmentId: "env-1",
        tabs: 3,
        working,
        waiting: 0,
        idle: 3 - working,
        stopped: 0,
        unknown: 0,
      },
    ],
  };
}
beforeEach(() => {
  resetNodeEventsForTests();
  callbacks = new Map();
  pending = [];
  order = [];
  listenMock.mockReset();
  listenMock.mockImplementation(async (event: string, callback) => {
    callbacks.set(event, callback);
    return () => callbacks.delete(event);
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    order.push(command);
    if (command === "watch_node_events")
      return { watchId: args.watchId, renewed: true, expiresAt: 90_000 };
    if (command === "unwatch_node_events") return { removed: true };
    if (command === "invoke_on_node")
      return new Promise((resolve, reject) =>
        pending.push({
          command: String(args.command),
          resolve: (value) => resolve({ outcome: "ok", result: value }),
          reject: () => reject(new Error("offline")),
        }),
      );
  });
});
afterEach(async () => {
  cleanup();
  resetNodeEventsForTests();
  for (const read of pending) read.resolve(null);
  await settle();
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockImplementation(async () => () => undefined);
});

test("environment reads follow subscription, filter events, debounce and fence stale responses", async () => {
  const { result } = renderHook(() => useNodeEnvironment(ref, true));
  await settle();
  expect(order.slice(0, 2)).toEqual(["watch_node_events", "invoke_on_node"]);
  expect(pending).toHaveLength(1);
  event(RESOURCE_CHANGED_EVENT, { resource: "environment", id: "other" });
  event(RESOURCE_CHANGED_EVENT, { resource: "project", id: "env-1" });
  await settle(280);
  expect(pending).toHaveLength(1);
  for (let i = 0; i < 5; i++)
    event(RESOURCE_CHANGED_EVENT, { resource: "environment", id: "env-1" });
  pending[0]!.resolve({ id: "env-1", name: "obsolete" });
  await settle();
  expect(result.current).toBeNull();
  await settle(280);
  expect(pending).toHaveLength(2);
  pending[1]!.resolve({ id: "env-1", name: "current" });
  await settle();
  expect(result.current?.name).toBe("current");
  resync();
  await settle();
  expect(pending).toHaveLength(3);
  resync();
  await settle();
  expect(pending).toHaveLength(4);
  pending[3]!.resolve({ id: "env-1", name: "newest" });
  pending[2]!.resolve({ id: "env-1", name: "late" });
  await settle();
  expect(result.current?.name).toBe("newest");
  resync();
  await settle();
  pending[4]!.reject();
  await settle();
  expect(result.current?.name).toBe("newest");
});

test("closed hover cards do not read and closing fences pending results and debounce", async () => {
  const { result, rerender } = renderHook(({ open }) => useNodeEnvironment(ref, open), {
    initialProps: { open: false },
  });
  await settle();
  expect(pending).toHaveLength(0);
  rerender({ open: true });
  await settle();
  expect(pending).toHaveLength(1);
  event(RESOURCE_CHANGED_EVENT, { resource: "environment", id: "env-1" });
  rerender({ open: false });
  pending[0]!.resolve({ id: "env-1", name: "too late" });
  await settle(280);
  expect(result.current).toBeNull();
  expect(pending).toHaveLength(1);
});

test("remote agent summary filters matching activity and resource events, coalesces and ignores stale reads", async () => {
  const source = nodeAgentSummarySource(LEAF);
  expect(nodeAgentSummarySource(LEAF)).toBe(source);
  const { rerender } = render(
    <EnvironmentAgentSummary environmentId="env-1" open source={source} />,
  );
  await settle(280);
  expect(pending).toHaveLength(1);
  expect(order.slice(0, 2)).toEqual(["watch_node_events", "invoke_on_node"]);
  expect(pending.every((read) => read.command === "get_agent_registry")).toBe(true);
  for (const read of pending) read.resolve(registry(1));
  await settle();
  expect(screen.getByText("3 agent tabs · 1 working")).toBeTruthy();
  const initial = pending.length;
  event(NATIVE_AGENT_ACTIVITY_EVENT, { environment_id: "other", state: "working" });
  event(NATIVE_AGENT_ACTIVITY_EVENT, { malformed: true });
  event(RESOURCE_CHANGED_EVENT, { resource: "project", id: "env-1" });
  event(RESOURCE_CHANGED_EVENT, { resource: "pane-layout", id: "other" });
  await settle(280);
  expect(pending).toHaveLength(initial);
  event(NATIVE_AGENT_ACTIVITY_EVENT, { environment_id: "env-1", state: "working" });
  event(RESOURCE_CHANGED_EVENT, { resource: "pane-layout", id: "env-1" });
  event(RESOURCE_CHANGED_EVENT, { resource: "environment", id: "env-1" });
  await settle(280);
  expect(pending).toHaveLength(initial + 1);
  const stale = pending.at(-1)!;
  resync();
  stale.resolve(registry(0));
  await settle();
  expect(screen.getByText("3 agent tabs · 1 working")).toBeTruthy();
  await settle(280);
  pending.at(-1)!.resolve(registry(2));
  await settle();
  expect(screen.getByText("3 agent tabs · 2 working")).toBeTruthy();
  resync();
  await settle(280);
  pending.at(-1)!.reject();
  await settle();
  expect(screen.queryByText(/agent tabs/) === null).toBe(true);
  resync();
  await settle(280);
  rerender(<EnvironmentAgentSummary environmentId="env-1" open={false} source={source} />);
  pending.at(-1)!.resolve(registry(3));
  await settle();
  expect(screen.queryByText(/agent tabs/) === null).toBe(true);
});
