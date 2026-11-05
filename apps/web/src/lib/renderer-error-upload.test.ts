import { describe, expect, mock, test } from "bun:test";
import type { RendererErrorEntry } from "@orkestrator/protocol/renderer-errors";
import { RendererErrorRing } from "./renderer-error-ring";
import { startRendererErrorUpload } from "./renderer-error-upload";

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
  test("sends only new counts, on the interval", async () => {
    const ring = new RendererErrorRing();
    const sent: RendererErrorEntry[][] = [];
    const clock = manualTimer();
    startRendererErrorUpload({
      ring,
      send: async (entries) => sent.push(entries),
      intervalMs: 100,
      timer: clock.timer,
    });
    const error = new TypeError("x");
    ring.record(error, "root", "window");
    ring.record(error, "root", "window");
    expect(await clock.fire()).toBe(100);
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
      send,
      intervalMs: 100,
      maxIntervalMs: 300,
      timer: clock.timer,
    });
    ring.record(new TypeError("x"), "root", "window");
    expect(await clock.fire()).toBe(100);
    expect(await clock.fire()).toBe(200);
    expect(clock.pending[0]?.delayMs).toBe(300);
    expect(ring.hasUnsent()).toBe(true);
  });

  test("a backend that predates the command stops the upload", async () => {
    const ring = new RendererErrorRing();
    const clock = manualTimer();
    startRendererErrorUpload({
      ring,
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
