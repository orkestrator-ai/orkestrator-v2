import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { waitForProjection } from "./wait-for-projection.js";

const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(async () => {
  // Give the runtime a turn to report any rejection cleanup left behind.
  await setImmediate();
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

function subscription(stage: "connecting" | "reading") {
  const calls: string[] = [];
  let signal: AbortSignal | undefined;
  async function* subscribe(abortSignal: AbortSignal): AsyncGenerator<void> {
    signal = abortSignal;
    calls.push("subscribe");
    try {
      if (stage === "reading") yield;
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          calls.push("settled");
          reject(abortSignal.reason);
        };
        abortSignal.addEventListener("abort", abort, { once: true });
      });
    } finally {
      calls.push("closed");
    }
  }
  return { subscribe, calls, aborted: () => signal?.aborted };
}

describe("projection wait cleanup", () => {
  for (const stage of ["connecting", "reading"] as const) {
    test(`immediate acceptance drains a subscription still ${stage}`, async () => {
      const stream = subscription(stage);
      const snapshot = { accepted: true };
      expect(
        await waitForProjection({
          ...stream,
          projection: async () => {
            stream.calls.push("snapshot");
            return snapshot;
          },
          accept: (value) => value.accepted,
          description: "accepted snapshot",
        }),
      ).toBe(snapshot);
      expect(stream.aborted()).toBe(true);
      // In reading mode the generator is suspended at yield; return closes it.
      expect(stream.calls).toEqual(
        stage === "connecting"
          ? ["subscribe", "snapshot", "settled", "closed"]
          : ["subscribe", "snapshot", "closed"],
      );
    });

    test(`snapshot failure closes a subscription still ${stage}`, async () => {
      const stream = subscription(stage);
      await expect(
        waitForProjection({
          ...stream,
          projection: async () => {
            throw new Error("snapshot failed");
          },
          accept: () => false,
          description: "snapshot",
        }),
      ).rejects.toThrow("snapshot failed");
      expect(stream.aborted()).toBe(true);
      expect(stream.calls.at(-1)).toBe("closed");
    });
  }

  for (const accepted of [true, false]) {
    test(`subscription rejection before snapshot completion (accepted=${accepted})`, async () => {
      const snapshot = Promise.withResolvers<boolean>();
      const failed = Promise.withResolvers<void>();
      let closed = false;
      const waiting = waitForProjection({
        async *subscribe() {
          try {
            await Promise.reject(new Error("subscription failed"));
            yield;
          } finally {
            closed = true;
            failed.resolve();
          }
        },
        projection: () => snapshot.promise,
        accept: (value) => value,
        description: "snapshot after failed subscription",
      });
      // The first next() has rejected, but the snapshot is deliberately pending
      // for a full event-loop turn: its rejection handler must already exist.
      await failed.promise;
      await setImmediate();
      snapshot.resolve(accepted);
      if (accepted) expect(await waiting).toBe(true);
      else await expect(waiting).rejects.toThrow("subscription failed");
      expect(closed).toBe(true);
    });
  }

  test("the first event rechecks the snapshot and drains a pending reader", async () => {
    const stream = subscription("reading");
    let reads = 0;
    expect(
      await waitForProjection({
        ...stream,
        projection: async () => ++reads,
        accept: (value) => value === 2,
        description: "updated snapshot",
      }),
    ).toBe(2);
    expect(stream.calls).toEqual(["subscribe", "settled", "closed"]);
    expect(stream.aborted()).toBe(true);
  });

  test("an ended stream rejects rather than leaving the waiter pending", async () => {
    await expect(
      waitForProjection({
        async *subscribe() {},
        projection: async () => false,
        accept: (value) => value,
        description: "ended stream",
      }),
    ).rejects.toThrow("bridge event stream ended");
  });
});
