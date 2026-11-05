import { describe, expect, mock, test } from "bun:test";
import type { RendererErrorEntry } from "@orkestrator/protocol/renderer-errors";
import { RendererErrorRing } from "./renderer-error-ring";
import { RENDERER_ERROR_PENDING_KEY, startRendererErrorUpload } from "./renderer-error-upload";

function manualTimer() {
  const pending: Array<{ callback: () => void; delayMs: number }> = [];
  return {
    pending,
    timer: {
      set: (callback: () => void, delayMs: number) => {
        const handle = { callback, delayMs };
        pending.push(handle);
        return handle;
      },
      clear: (handle: unknown) => {
        const index = pending.indexOf(handle as never);
        if (index >= 0) pending.splice(index, 1);
      },
    },
    async fire() {
      const next = pending.shift();
      next?.callback();
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      return next?.delayMs;
    },
  };
}

describe("the renderer error upload", () => {
  test("sends the first counts promptly and spaces subsequent sends", async () => {
    const ring = new RendererErrorRing();
    const sent: RendererErrorEntry[][] = [];
    const clock = manualTimer();
    startRendererErrorUpload({
      ring,
      storage: null,
      send: async (entries) => sent.push(entries),
      intervalMs: 100,
      timer: clock.timer,
    });
    const error = new TypeError("x");
    ring.record(error, "root", "window");
    ring.record(error, "root", "window");
    expect(await clock.fire()).toBe(0);
    await clock.fire();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]?.count).toBe(2);
  });

  test("a failed send puts the counts back and waits longer", async () => {
    const ring = new RendererErrorRing();
    const clock = manualTimer();
    const send = mock(async () => {
      throw new Error("backend unreachable");
    });
    startRendererErrorUpload({
      ring,
      storage: null,
      send,
      intervalMs: 100,
      maxIntervalMs: 300,
      timer: clock.timer,
    });
    ring.record(new TypeError("x"), "root", "window");
    expect(await clock.fire()).toBe(0);
    expect(await clock.fire()).toBe(200);
    expect(clock.pending[0]?.delayMs).toBe(300);
    expect(ring.hasUnsent()).toBe(true);
  });

  test("a backend that predates the command stops the upload", async () => {
    const ring = new RendererErrorRing();
    const clock = manualTimer();
    startRendererErrorUpload({
      ring,
      storage: null,
      send: async () => {
        throw new Error("Unknown backend command: record_renderer_errors");
      },
      timer: clock.timer,
    });
    ring.record(new TypeError("x"), "root", "window");
    await clock.fire();
    expect(clock.pending).toHaveLength(0);
  });

  test("stop clears the timer", () => {
    const clock = manualTimer();
    const stop = startRendererErrorUpload({
      ring: new RendererErrorRing(),
      send: async () => undefined,
      timer: clock.timer,
    });
    stop();
    expect(clock.pending).toHaveLength(0);
  });
});

test("pagehide sends queued counts without waiting for cooldown", async () => {
  const ring = new RendererErrorRing();
  const lifecycle = new EventTarget();
  const clock = manualTimer();
  const send = mock(async () => undefined);
  const stop = startRendererErrorUpload({
    ring,
    send,
    timer: clock.timer,
    storage: null,
    lifecycle,
  });
  ring.record(new Error("first"), "root", "window");
  await clock.fire();
  ring.record(new Error("second"), "root", "window");
  expect(send).toHaveBeenCalledTimes(1);
  lifecycle.dispatchEvent(new Event("pagehide"));
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(2);
  stop();
  expect(clock.pending).toHaveLength(0);
});

test("pending and in-flight metadata survive renderer disappearance and clear after acknowledgement", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const ring = new RendererErrorRing();
  const clock = manualTimer();
  const stop = startRendererErrorUpload({
    ring,
    timer: clock.timer,
    storage,
    send: () => new Promise(() => {}),
  });
  ring.record(new TypeError("private message"), "root", "window");
  expect(values.get(RENDERER_ERROR_PENDING_KEY)).not.toContain("private message");
  await clock.fire();
  ring.record(new RangeError("private second"), "root", "window");
  stop(); // Simulate losing the first renderer while its request has no outcome.
  const nextClock = manualTimer();
  const sent: RendererErrorEntry[][] = [];
  const nextStop = startRendererErrorUpload({
    ring: new RendererErrorRing(),
    storage,
    timer: nextClock.timer,
    send: async (entries) => {
      sent.push(entries);
    },
  });
  expect(await nextClock.fire()).toBe(0);
  expect(sent[0]?.map((entry) => entry.errorClass)).toEqual(["TypeError", "RangeError"]);
  expect(values.has(RENDERER_ERROR_PENDING_KEY)).toBe(false);
  nextStop();
});

test("blocked or oversized storage cannot stop prompt uploads", async () => {
  for (const raw of ["x".repeat(32769), '[{"message":"private"}]']) {
    const ring = new RendererErrorRing();
    const clock = manualTimer();
    const send = mock(async () => undefined);
    const stop = startRendererErrorUpload({
      ring,
      timer: clock.timer,
      send,
      storage: {
        getItem: () => raw,
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {},
      },
    });
    ring.record(new Error("x"), "root", "window");
    await clock.fire();
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  }
});

test("the first failure after a quiet startup still sends promptly", async () => {
  const clock = manualTimer();
  const ring = new RendererErrorRing();
  const send = mock(async () => undefined);
  const stop = startRendererErrorUpload({ ring, send, storage: null, timer: clock.timer });
  await clock.fire();
  ring.record(new Error("late"), "root", "window");
  expect(await clock.fire()).toBe(0);
  expect(send).toHaveBeenCalledTimes(1);
  stop();
});
