import { afterEach, describe, expect, test } from "bun:test";

import { eventEmitter } from "./event-emitter.js";
import type { SSEEvent } from "../types/index.js";

// Track every unsubscribe so a failing test can never leak subscribers
// into other tests in the same process.
const cleanups: Array<() => void> = [];

function trackedSubscribe(cb: (event: SSEEvent) => void): () => void {
  const unsubscribe = eventEmitter.subscribe(cb);
  cleanups.push(unsubscribe);
  return unsubscribe;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("eventEmitter", () => {
  test("subscribe increments count and returns an unsubscribe", () => {
    const before = eventEmitter.subscriberCount;
    const unsubscribe = trackedSubscribe(() => {});
    expect(eventEmitter.subscriberCount).toBe(before + 1);

    unsubscribe();
    expect(eventEmitter.subscriberCount).toBe(before);
  });

  test("emit broadcasts to every subscriber", () => {
    const received1: SSEEvent[] = [];
    const received2: SSEEvent[] = [];
    trackedSubscribe((e) => received1.push(e));
    trackedSubscribe((e) => received2.push(e));

    const event: SSEEvent = {
      type: "session.updated",
      sessionId: "s-1",
      data: { status: "running" },
    };
    eventEmitter.emit(event);

    expect(received1).toEqual([event]);
    expect(received2).toEqual([event]);
  });

  test("a throwing subscriber does not stop other subscribers from receiving the event", () => {
    const received: SSEEvent[] = [];
    trackedSubscribe(() => {
      throw new Error("boom");
    });
    trackedSubscribe((e) => received.push(e));

    const event: SSEEvent = {
      type: "session.idle",
      sessionId: "s-2",
      data: { aborted: true },
    };
    expect(() => eventEmitter.emit(event)).not.toThrow();
    expect(received).toEqual([event]);
  });

  test("unsubscribed callbacks no longer receive events", () => {
    const received: SSEEvent[] = [];
    const unsubscribe = trackedSubscribe((e) => received.push(e));

    eventEmitter.emit({ type: "session.updated", sessionId: "s-3" });
    unsubscribe();
    eventEmitter.emit({ type: "session.idle", sessionId: "s-3" });

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("session.updated");
  });

  test("calling the same unsubscribe twice is a no-op", () => {
    const before = eventEmitter.subscriberCount;
    const unsubscribe = trackedSubscribe(() => {});
    expect(eventEmitter.subscriberCount).toBe(before + 1);

    unsubscribe();
    unsubscribe();
    expect(eventEmitter.subscriberCount).toBe(before);
  });
});
