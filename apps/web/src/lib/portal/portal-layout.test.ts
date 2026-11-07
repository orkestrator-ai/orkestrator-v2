import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import {
  emptyPortalLayout,
  PORTAL_LAYOUT_CHANGED_EVENT,
} from "@orkestrator/protocol/portal-layout";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import {
  getPortalLayout,
  portalLayoutStore,
  startPortalLayout,
  updatePortalLayout,
} from "./portal-layout";

let handlers: Map<string, (payload: unknown) => void>;
let stop: (() => void) | undefined;
let invoke: ReturnType<typeof mock>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const layout = (revision: number, machineOrder = ["bk_a"]) => ({
  ...emptyPortalLayout(),
  revision,
  machineOrder,
});
beforeEach(() => {
  handlers = new Map();
  portalLayoutStore.setState({ layout: emptyPortalLayout(), loaded: false, error: null });
  invoke = mock(async () => layout(1));
  window.orkestratorPortal = {
    invoke,
    listen: (event: string, callback: (payload: unknown) => void) => {
      handlers.set(event, callback);
      return () => handlers.delete(event);
    },
  } as never;
});
afterEach(() => {
  stop?.();
  stop = undefined;
  delete window.orkestratorPortal;
});
async function start() {
  stop = startPortalLayout();
  await waitFor(() => expect(portalLayoutStore.getState().loaded).toBe(true));
}

test("subscribes before reading, ignores stale events, reconciles after reconnect and reference counts", async () => {
  invoke.mockImplementation(async () => {
    expect(handlers.size).toBe(2);
    return layout(2);
  });
  await start();
  const release = startPortalLayout();
  handlers.get(PORTAL_LAYOUT_CHANGED_EVENT)?.(layout(1));
  expect(getPortalLayout().revision).toBe(2);
  handlers.get(PORTAL_LAYOUT_CHANGED_EVENT)?.(layout(3));
  expect(getPortalLayout().revision).toBe(3);
  invoke.mockResolvedValue(layout(4));
  handlers.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)?.({});
  await waitFor(() => expect(getPortalLayout().revision).toBe(4));
  stop!();
  stop = undefined;
  expect(handlers.size).toBe(2);
  release();
  expect(handlers.size).toBe(0);
});

test("overlapping writes suppress events until every response settles, then reread authoritatively", async () => {
  await start();
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  let writes = 0;
  invoke.mockImplementation(async (command: string) =>
    command === "get_portal_layout"
      ? layout(4, ["bk_final"])
      : ++writes === 1
        ? first.promise
        : second.promise,
  );
  const a = updatePortalLayout({ machineOrder: ["bk_first"] });
  const b = updatePortalLayout({ machineOrder: ["bk_second"] });
  handlers.get(PORTAL_LAYOUT_CHANGED_EVENT)?.(layout(2, ["bk_stale"]));
  expect(getPortalLayout().machineOrder).toEqual(["bk_second"]);
  second.resolve({});
  await b;
  expect(getPortalLayout().machineOrder).toEqual(["bk_second"]);
  first.resolve({});
  await a;
  expect(getPortalLayout().machineOrder).toEqual(["bk_final"]);
});

test("rejected write rolls back by rereading even if no event arrives", async () => {
  await start();
  invoke.mockImplementation(async (command: string) => {
    if (command === "update_portal_layout") throw new Error("storage unavailable");
    return layout(1);
  });
  await expect(updatePortalLayout({ machineOrder: ["bk_optimistic"] })).rejects.toThrow(
    "storage unavailable",
  );
  expect(getPortalLayout().machineOrder).toEqual(["bk_a"]);
});

test("only unknown-command reads enable the in-page fallback", async () => {
  invoke.mockRejectedValue(new Error("Unknown command: get_portal_layout"));
  await start();
  await updatePortalLayout({ machineOrder: ["bk_local"] });
  expect(getPortalLayout().machineOrder).toEqual(["bk_local"]);
});

test("storage or transport read failure stays unloaded and prevents writes until reconnect succeeds", async () => {
  invoke.mockRejectedValue(new Error("storage unavailable"));
  stop = startPortalLayout();
  await waitFor(() => expect(portalLayoutStore.getState().error).not.toBeNull());
  expect(portalLayoutStore.getState().loaded).toBe(false);
  await expect(updatePortalLayout({ machineOrder: [] })).rejects.toThrow("has not loaded");
  expect(invoke.mock.calls.every(([command]) => command === "get_portal_layout")).toBe(true);
  invoke.mockResolvedValue(layout(5));
  handlers.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)?.({});
  await waitFor(() => expect(portalLayoutStore.getState().loaded).toBe(true));
  expect(portalLayoutStore.getState().error).toBeNull();
});

test("a pre-write read cannot overwrite a later optimistic write", async () => {
  await start();
  const stale = deferred<unknown>();
  const mutation = deferred<unknown>();
  let reads = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === "update_portal_layout") return mutation.promise;
    return ++reads === 1 ? stale.promise : layout(3, ["bk_new"]);
  });
  handlers.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)?.({});
  const write = updatePortalLayout({ machineOrder: ["bk_new"] });
  stale.resolve(layout(2, ["bk_old"]));
  await Promise.resolve();
  await Promise.resolve();
  expect(getPortalLayout().machineOrder).toEqual(["bk_new"]);
  mutation.resolve({});
  await write;
  expect(getPortalLayout().revision).toBe(3);
  expect(getPortalLayout().machineOrder).toEqual(["bk_new"]);
});
