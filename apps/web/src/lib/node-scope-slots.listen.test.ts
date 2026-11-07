import { afterEach, expect, mock, test } from "bun:test";
import { resourceChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import { listen } from "@/lib/native/events";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { appCommandScope, listenInScope } from "./node-scope-slots";

const listenMock = listen as ReturnType<typeof mock>;
const windows: WindowScope[] = [];

afterEach(() => {
  for (const windowScope of windows.splice(0)) windowScope.dispose();
  listenMock.mockReset();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
});

const valid = { resource: "environment", id: "env-1", revision: 3, extra: "kept" };
const invalid = [null, "environment", { resource: "environment", id: "env-1" }];

test("a definition on another node's scope is its client's typed listen", async () => {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const client = new FakeNodeClient({ nodeId: "bk_leaf" as never });
  const scope = windowScope.open({ role: "command", client });
  const received: unknown[] = [];
  const stop = await listenInScope(scope, resourceChangedEvent, (payload) => {
    received.push(payload);
  });
  for (const payload of invalid) client.emit("resource-changed", payload);
  client.emit("resource-changed", valid);
  // Delivered as sent: keys the schema does not name are kept.
  expect(received).toEqual([valid]);
  stop();
  client.emit("resource-changed", valid);
  expect(received).toHaveLength(1);
});

test("a definition on the app's command scope is the window listen, decoded", async () => {
  let deliver: ((message: { payload: unknown }) => void) | null = null;
  listenMock.mockImplementation(async (event: string, handler: typeof deliver) => {
    expect(event).toBe("resource-changed");
    deliver = handler;
    return () => {};
  });
  const received: unknown[] = [];
  await listenInScope(appCommandScope(), resourceChangedEvent, (payload) => {
    received.push(payload);
  });
  for (const payload of [...invalid, valid]) deliver!({ payload });
  expect(received).toEqual([valid]);
});

test("a name is today's untyped subscription", async () => {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const client = new FakeNodeClient({ nodeId: "bk_leaf" as never });
  const scope = windowScope.open({ role: "command", client });
  const received: unknown[] = [];
  await listenInScope<unknown>(scope, "native-event-stream-connected", (payload) => {
    received.push(payload);
  });
  client.emit("native-event-stream-connected", null);
  expect(received).toEqual([null]);
});
