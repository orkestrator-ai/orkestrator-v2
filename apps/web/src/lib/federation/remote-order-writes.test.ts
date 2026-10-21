import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { projectKey, projectRef } from "@orkestrator/protocol/federation";
import { PortalStore, OutcomeUnknownError } from "@/lib/portal/portal-store";
import { createRemoteOrderWrites } from "./remote-order-writes";

const ref = projectRef("bk_a" as never, "project");
const key = projectKey(ref);
const timers: Array<() => void> = [];

function setup() {
  const portal = new PortalStore();
  const calls: Array<{
    ids: readonly string[];
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  spyOn(portal, "invokeOnNode").mockImplementation(
    (_node, _command, args) =>
      new Promise((resolve, reject) => {
        calls.push({
          ids: args!.environmentIds as string[],
          resolve: () => resolve(undefined as never),
          reject,
        });
      }),
  );
  const orders = createRemoteOrderWrites(portal);
  const onError = mock((_error: unknown) => {});
  return { portal, orders, calls, onError };
}

// Capture only the overlay's deadline, leaving the runner and DOM timers intact.
const originalSetTimeout = globalThis.setTimeout;
afterEach(() => {
  for (const done of timers.splice(0)) done();
  mock.restore();
});

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function captureDeadlines() {
  spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === 10_000) {
      timers.push(callback);
      return originalSetTimeout(() => {}, 0);
    }
    return originalSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
}

test("overlapping drops serialize writes and coalesce to the latest pending order", async () => {
  captureDeadlines();
  const { orders, calls, onError } = setup();
  orders.submit(ref, ["b", "a", "c"], onError);
  orders.submit(ref, ["b", "c", "a"], onError);
  orders.submit(ref, ["c", "b", "a"], onError);
  expect(calls.map((call) => call.ids)).toEqual([["b", "a", "c"]]);
  expect(orders.store.getState().get(key)).toEqual(["c", "b", "a"]);
  calls[0]!.resolve();
  await flush();
  expect(calls.map((call) => call.ids)).toEqual([
    ["b", "a", "c"],
    ["c", "b", "a"],
  ]);
  calls[1]!.resolve();
  await flush();
  expect(orders.store.getState().get(key)).toEqual(["c", "b", "a"]);
  expect(onError).not.toHaveBeenCalled();
});

test("projects on different owners have independent queues even with identical IDs", async () => {
  captureDeadlines();
  const { orders, calls, onError } = setup();
  const other = projectRef("bk_b" as never, ref.projectId);
  orders.submit(ref, ["b", "a"], onError);
  orders.submit(other, ["a", "b"], onError);
  expect(calls).toHaveLength(2);
  expect(orders.store.getState().size).toBe(2);
  for (const call of calls) call.resolve();
  await flush();
});

for (const error of [
  new Error("rejected"),
  new OutcomeUnknownError(ref.backendId, "reorder_environments", "request"),
]) {
  test(`${error.name}: roll back and discard queued drops without resending`, async () => {
    const { orders, calls, onError } = setup();
    orders.submit(ref, ["b", "a", "c"], onError);
    orders.submit(ref, ["c", "b", "a"], onError);
    calls[0]!.reject(error);
    await flush();
    expect(calls).toHaveLength(1);
    expect(orders.store.getState().size).toBe(0);
    expect(onError).toHaveBeenCalledWith(error);
  });
}

test("an acknowledged write with no matching summary expires back to owner state", async () => {
  captureDeadlines();
  const { orders, calls, onError } = setup();
  orders.submit(ref, ["b", "a"], onError);
  calls[0]!.resolve();
  await flush();
  expect(orders.store.getState().get(key)).toEqual(["b", "a"]);
  timers.pop()!();
  expect(orders.store.getState().size).toBe(0);
});

test("oversized orders are refused before retaining or writing them", () => {
  const { orders, calls, onError } = setup();
  orders.submit(
    ref,
    Array.from({ length: 501 }, (_, index) => `id-${index}`),
    onError,
  );
  // Fewer than 500 IDs and fewer than 256 Ki UTF-16 units, but over 256 KiB of UTF-8.
  orders.submit(
    ref,
    Array.from({ length: 300 }, () => "🦊".repeat(256)),
    onError,
  );
  expect(onError).toHaveBeenCalledTimes(2);
  expect(calls).toHaveLength(0);
  expect(orders.store.getState().size).toBe(0);
});
