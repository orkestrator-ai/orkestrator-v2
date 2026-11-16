import { afterEach, describe, expect, test } from "bun:test";
import {
  DRAFT_RETRY_BASE_MS,
  DRAFT_RETRY_CEILING_MS,
  DRAFT_RETRY_MAX_KEYS,
  DRAFT_RETRY_TIMER_ATTEMPTS,
  DraftWriteRetries,
  type DraftRetryClock,
} from "./compose-draft-retry";

class Conflict extends Error {}

interface FakeTimer {
  callback: () => void;
  delayMs: number;
}

function fakeClock() {
  const timers = new Set<FakeTimer>();
  const clock: DraftRetryClock = {
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs };
      timers.add(timer);
      return timer;
    },
    clearTimeout(handle) {
      timers.delete(handle as FakeTimer);
    },
  };
  return {
    clock,
    delays: () => Array.from(timers, (timer) => timer.delayMs),
    /** Fires every pending timer once. */
    fire() {
      const due = Array.from(timers);
      timers.clear();
      for (const timer of due) timer.callback();
    },
    size: () => timers.size,
  };
}

/** A chain that runs operations one at a time, like the persistence helper's. */
function chain() {
  let tail: Promise<void> = Promise.resolve();
  return (_key: string, operation: () => Promise<void>): Promise<void> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
}

const created: DraftWriteRetries[] = [];
afterEach(() => {
  for (const retries of created.splice(0)) retries.dispose();
});

function setup(options: { disconnected?: () => boolean } = {}) {
  const timers = fakeClock();
  const retries = new DraftWriteRetries({
    enqueue: chain(),
    isRetryable: (error) => !(error instanceof Conflict),
    isDisconnected: options.disconnected ?? (() => false),
    clock: timers.clock,
  });
  created.push(retries);
  return { retries, timers };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("DraftWriteRetries", () => {
  test("retries a failed write after the base delay and forgets it once it lands", async () => {
    const { retries, timers } = setup();
    let calls = 0;
    const run = async () => {
      calls += 1;
    };
    const seq = retries.begin("native-claude:env:tab");
    retries.settled("native-claude:env:tab", seq, { error: new Error("offline") }, run);

    expect(timers.delays()).toEqual([DRAFT_RETRY_BASE_MS]);
    timers.fire();
    await settle();

    expect(calls).toBe(1);
    expect(retries.pendingKeys()).toEqual([]);
    expect(timers.size()).toBe(0);
  });

  test("a newer write cancels the pending retry", async () => {
    const { retries, timers } = setup();
    let stale = 0;
    const first = retries.begin("k:env:tab");
    retries.settled("k:env:tab", first, { error: new Error("offline") }, async () => {
      stale += 1;
    });
    retries.begin("k:env:tab");

    expect(retries.pendingKeys()).toEqual([]);
    expect(timers.size()).toBe(0);
    retries.retryNow();
    await settle();
    expect(stale).toBe(0);
  });

  test("a failure of an overtaken write is not kept", () => {
    const { retries, timers } = setup();
    const older = retries.begin("k:env:tab");
    retries.begin("k:env:tab");
    retries.settled("k:env:tab", older, { error: new Error("offline") }, async () => undefined);

    expect(retries.pendingKeys()).toEqual([]);
    expect(timers.size()).toBe(0);
  });

  test("never retries a revision conflict", () => {
    const { retries, timers } = setup();
    const seq = retries.begin("k:env:tab");
    retries.settled("k:env:tab", seq, { error: new Conflict() }, async () => undefined);

    expect(retries.pendingKeys()).toEqual([]);
    expect(timers.size()).toBe(0);
  });

  test("drops the pending write when the retry itself hits a conflict", async () => {
    const { retries, timers } = setup();
    const seq = retries.begin("k:env:tab");
    retries.settled("k:env:tab", seq, { error: new Error("offline") }, async () => {
      throw new Conflict();
    });
    timers.fire();
    await settle();

    expect(retries.pendingKeys()).toEqual([]);
    expect(timers.size()).toBe(0);
  });

  test("backs off exponentially up to the ceiling, then waits for a reconnect", async () => {
    const { retries, timers } = setup();
    let calls = 0;
    const seq = retries.begin("k:env:tab");
    retries.settled("k:env:tab", seq, { error: new Error("offline") }, async () => {
      calls += 1;
      throw new Error("still offline");
    });

    const delays: number[] = [];
    while (timers.size() > 0) {
      delays.push(...timers.delays());
      timers.fire();
      await settle();
    }

    expect(delays).toHaveLength(DRAFT_RETRY_TIMER_ATTEMPTS);
    expect(delays[0]).toBe(DRAFT_RETRY_BASE_MS);
    expect(delays[1]).toBe(DRAFT_RETRY_BASE_MS * 2);
    expect(Math.max(...delays)).toBe(DRAFT_RETRY_CEILING_MS);
    expect(calls).toBe(DRAFT_RETRY_TIMER_ATTEMPTS);
    // Out of timed attempts, but still pending for the next reconnect.
    expect(retries.pendingKeys()).toEqual(["k:env:tab"]);
  });

  test("a reconnect retries every pending write at once", async () => {
    const { retries, timers } = setup();
    const ran: string[] = [];
    for (const key of ["a:env:1", "b:env:2"]) {
      const seq = retries.begin(key);
      retries.settled(key, seq, { error: new Error("offline") }, async () => {
        ran.push(key);
      });
    }

    retries.retryNow();
    await settle();

    expect(ran.sort()).toEqual(["a:env:1", "b:env:2"]);
    expect(retries.pendingKeys()).toEqual([]);
    expect(timers.size()).toBe(0);
  });

  test("does not spend attempts while the node is known to be disconnected", async () => {
    let disconnected = true;
    const { retries, timers } = setup({ disconnected: () => disconnected });
    let calls = 0;
    const seq = retries.begin("k:env:tab");
    retries.settled("k:env:tab", seq, { error: new Error("offline") }, async () => {
      calls += 1;
    });

    timers.fire();
    await settle();
    expect(calls).toBe(0);
    expect(timers.delays()).toEqual([DRAFT_RETRY_CEILING_MS]);

    disconnected = false;
    retries.retryNow();
    await settle();
    expect(calls).toBe(1);
    expect(timers.size()).toBe(0);
  });

  test("flushInline runs the pending write and keeps it pending if it fails again", async () => {
    const { retries, timers } = setup();
    let fail = true;
    let calls = 0;
    const seq = retries.begin("k:env:tab");
    retries.settled("k:env:tab", seq, { error: new Error("offline") }, async () => {
      calls += 1;
      if (fail) throw new Error("still offline");
    });

    await retries.flushInline("k:env:tab");
    expect(calls).toBe(1);
    expect(retries.pendingKeys()).toEqual(["k:env:tab"]);
    expect(timers.delays()).toEqual([DRAFT_RETRY_BASE_MS * 2]);

    fail = false;
    await retries.flushInline("k:env:tab");
    expect(calls).toBe(2);
    expect(retries.pendingKeys()).toEqual([]);
    expect(timers.size()).toBe(0);
  });

  test("bounds the pending keys by dropping the oldest", () => {
    const { retries } = setup();
    for (let i = 0; i <= DRAFT_RETRY_MAX_KEYS; i += 1) {
      const key = `k:env:${i}`;
      const seq = retries.begin(key);
      retries.settled(key, seq, { error: new Error("offline") }, async () => undefined);
    }
    const keys = retries.pendingKeys();
    expect(keys).toHaveLength(DRAFT_RETRY_MAX_KEYS);
    expect(keys).not.toContain("k:env:0");
    expect(keys).toContain(`k:env:${DRAFT_RETRY_MAX_KEYS}`);
  });

  test("dispose cancels every timer", () => {
    const { retries, timers } = setup();
    const seq = retries.begin("k:env:tab");
    retries.settled("k:env:tab", seq, { error: new Error("offline") }, async () => undefined);
    retries.dispose();
    expect(timers.size()).toBe(0);
    expect(retries.pendingKeys()).toEqual([]);
  });
});
