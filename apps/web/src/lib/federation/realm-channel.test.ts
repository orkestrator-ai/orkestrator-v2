import { afterEach, expect, test } from "bun:test";
import { createRealmLoopback, pageRealmChannel, type RealmLoopback } from "./realm-channel";
import { parseRealmMessage, type ShellToRealmMessage } from "./workspace-realm";

const open: RealmLoopback[] = [];
function loopback(...args: Parameters<typeof createRealmLoopback>) {
  const pair = createRealmLoopback(...args);
  open.push(pair);
  return pair;
}

afterEach(() => {
  for (const pair of open.splice(0)) pair.close();
});

test("the window's own document is not a realm: the page channel drops posts and has no request", () => {
  expect(pageRealmChannel.kind).toBe("page");
  expect(pageRealmChannel.isRealm()).toBe(false);
  expect(pageRealmChannel.initialRequest()).toBeNull();
  expect(() => pageRealmChannel.post({ type: "ready" })).not.toThrow();
});

test("a loopback is a realm opened on the request a document would find in its URL", () => {
  const pair = loopback({ projectId: "p", environmentId: "e", boardTab: "coordinator" });
  expect(pair.realm.kind).toBe("loopback");
  expect(pair.realm.isRealm()).toBe(true);
  expect(pair.realm.initialRequest()).toEqual({
    type: "select",
    projectId: "p",
    environmentId: "e",
    boardTab: "coordinator",
  });
  expect(loopback(null).realm.initialRequest()).toBeNull();
});

test("messages cross in a later microtask, in order, and parse as the page transports parse them", async () => {
  const pair = loopback(null);
  const toRealm: ShellToRealmMessage[] = [];
  const toShell: unknown[] = [];
  pair.realm.onMessage((message) => toRealm.push(message));
  pair.onRealmMessage((message) => toShell.push(message));

  pair.send({ type: "sidebar", open: true });
  pair.send({ type: "panel", panel: "usage", open: true, inset: 99_999, seq: 3 });
  // Invalid shapes never reach the realm, as `onShellMessage` drops them.
  pair.send({ type: "sidebar", open: "yes" } as never);
  pair.realm.post({ type: "ready" });
  pair.realm.post({ type: "selection", projectId: "p", environmentId: null });
  expect(toRealm).toEqual([]);
  expect(toShell).toEqual([]);

  await Promise.resolve();
  expect(toRealm).toEqual([
    { type: "sidebar", open: true },
    // Clamped by the parser, as a frame's message is.
    { type: "panel", panel: "usage", open: true, inset: 4096, seq: 3 },
  ]);
  expect(toShell.map(parseRealmMessage)).toEqual([
    { type: "ready" },
    { type: "selection", projectId: "p", environmentId: null },
  ]);
});

test("a message that arrives while nobody listens is dropped, as an unloaded frame drops it", async () => {
  const pair = loopback(null);
  const received: ShellToRealmMessage[] = [];
  pair.send({ type: "sidebar", open: true });
  await Promise.resolve();
  const stop = pair.realm.onMessage((message) => received.push(message));
  pair.send({ type: "filesPanel", open: false });
  await Promise.resolve();
  stop();
  pair.send({ type: "sidebar", open: false });
  await Promise.resolve();
  expect(received).toEqual([{ type: "filesPanel", open: false }]);
});

test("a listener that subscribes before the message is delivered receives it", async () => {
  const pair = loopback(null);
  const received: unknown[] = [];
  pair.realm.post({ type: "ready" });
  pair.onRealmMessage((message) => received.push(message));
  await Promise.resolve();
  expect(received).toEqual([{ type: "ready" }]);
});

test("closing the pair drops pending and later messages and refuses new listeners", async () => {
  const pair = loopback(null);
  const received: unknown[] = [];
  pair.onRealmMessage((message) => received.push(message));
  pair.realm.onMessage((message) => received.push(message));
  pair.realm.post({ type: "ready" });
  pair.close();
  pair.send({ type: "sidebar", open: true });
  pair.realm.post({ type: "ready" });
  pair.onRealmMessage((message) => received.push(message));
  await Promise.resolve();
  expect(pair.closed).toBe(true);
  expect(received).toEqual([]);
});
