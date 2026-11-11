import { afterEach, describe, expect, test } from "bun:test";
import { waitUntil } from "../agent-provider-test-support.js";
import {
  OPENCODE2_EVENT_STREAM_SILENCE_MS,
  OpenCodeStreamSilenceWatchdog,
} from "./stream-silence.js";
import { manualSilenceClock } from "./stream-silence.test-support.js";

const watchdogs: OpenCodeStreamSilenceWatchdog[] = [];

afterEach(() => {
  for (const watchdog of watchdogs.splice(0)) watchdog.stop();
});

describe("OpenCodeStreamSilenceWatchdog", () => {
  function watchdog(silenceMs: number) {
    const clock = manualSilenceClock();
    const fired: number[] = [];
    const instance = new OpenCodeStreamSilenceWatchdog((ms) => fired.push(ms), {
      silenceMs,
      clock: clock.clock,
    });
    watchdogs.push(instance);
    return { instance, fired, clock };
  }

  test("the deadline is three missed 15 s heartbeats plus slack", () => {
    expect(OPENCODE2_EVENT_STREAM_SILENCE_MS).toBe(50_000);
  });

  test("stays unarmed until a heartbeat arrives", () => {
    const { instance, fired, clock } = watchdog(20);
    instance.frame(false);
    expect(clock.pending()).toBe(0);
    clock.advance(1_000);
    expect(instance.isArmed).toBe(false);
    expect(fired).toEqual([]);
  });

  test("re-checks elapsed silence instead of firing on the first timer", () => {
    const { instance, fired, clock } = watchdog(30);
    instance.frame(true);
    // A frame 20 ms in moves the deadline; the first timer must re-arm.
    clock.advance(20);
    instance.frame(false);
    clock.advance(10);
    expect(fired).toEqual([]);
    expect(clock.pending()).toBe(1);
    clock.advance(19);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([30]);
    expect(instance.isArmed).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  test("stop cancels a pending deadline", () => {
    const { instance, fired, clock } = watchdog(10);
    instance.frame(true);
    instance.stop();
    expect(clock.pending()).toBe(0);
    clock.advance(1_000);
    expect(fired).toEqual([]);
    instance.frame(true);
    expect(instance.isArmed).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  test("fires on the real clock when no clock is injected", async () => {
    const fired: number[] = [];
    const instance = new OpenCodeStreamSilenceWatchdog((ms) => fired.push(ms), { silenceMs: 5 });
    watchdogs.push(instance);
    instance.frame(true);
    await waitUntil(() => fired.length === 1);
    expect(fired).toEqual([5]);
  });
});
