import { afterEach, describe, expect, test } from "bun:test";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import { openCodeFake, waitUntil, type OpenCodeFake } from "./agent-provider-test-support.js";
import {
  consumeOpenCodeEventStream,
  isOpenCodeHeartbeat,
  OPENCODE_EVENT_STREAM_SILENCE_MS,
  OpenCodeStreamSilenceWatchdog,
  type OpenCodeSilenceClock,
} from "./opencode-observation-stream.js";
import type { NativeAgentRuntimeProvider } from "./agent-provider-contract.js";

/**
 * To-do 7200 task 1: an OpenCode event stream that stays open but stops
 * heartbeating is replaced, while a server that never heartbeats is left
 * alone. Heartbeats are liveness only, never dispatched or counted as drift.
 */
const HEARTBEAT = { type: "server.heartbeat", properties: {} };
const SILENCE_MS = 150;

const providers: NativeAgentRuntimeProvider[] = [];
const watchdogs: OpenCodeStreamSilenceWatchdog[] = [];

afterEach(async () => {
  for (const watchdog of watchdogs.splice(0)) watchdog.stop();
  for (const provider of providers.splice(0)) await provider.dispose?.();
});

/**
 * A manual clock for the watchdog: time moves only when a test advances it,
 * so no assertion depends on how long a sleep took on a loaded host. `reads`
 * counts calls to `now()`, which the watchdog makes once per frame and once
 * per deadline check, so a test can await "the frame was seen".
 */
function manualClock() {
  let time = 0;
  let nextId = 0;
  let reads = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: OpenCodeSilenceClock = {
    now: () => {
      reads += 1;
      return time;
    },
    setTimer(callback, delayMs) {
      nextId += 1;
      timers.set(nextId, { at: time + delayMs, callback });
      return nextId;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    get reads() {
      return reads;
    },
    pending: () => timers.size,
    /** Moves time forward and runs every timer that falls due, in order. */
    advance(ms: number) {
      time += ms;
      for (;;) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.at <= time)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].callback();
      }
    },
  };
}

type ManualClock = ReturnType<typeof manualClock>;

function silenceProvider(fake: OpenCodeFake, clock: ManualClock): NativeAgentRuntimeProvider {
  const provider = createNativeAgentProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    {
      openCodeClient: fake.client,
      monitorSilenceMs: SILENCE_MS,
      monitorClock: clock.clock,
      waitForMonitorRetry: (_ms, signal) =>
        signal.aborted ? Promise.reject(signal.reason) : Promise.resolve(),
    },
  );
  providers.push(provider);
  return provider;
}

function unknownEventCount(provider: NativeAgentRuntimeProvider): number {
  const health = (
    provider as unknown as { health: { drift(): { unknownEvents: number } | undefined } }
  ).health;
  return health.drift()?.unknownEvents ?? 0;
}

/** Pushes a frame and waits until the monitor's watchdog has seen it. */
async function pushSeen(fake: OpenCodeFake, clock: ManualClock, frame: unknown): Promise<void> {
  const before = clock.reads;
  fake.subscriptions[0]!.push(frame);
  await waitUntil(() => clock.reads > before);
}

describe("OpenCode event monitor silence", () => {
  test("a stream that heartbeated and then went silent is replaced", async () => {
    const fake = openCodeFake();
    const clock = manualClock();
    const provider = silenceProvider(fake, clock);
    await waitUntil(() => fake.subscriptions.length === 1);
    fake.subscriptions[0]!.push({ type: "server.connected", properties: {} });
    fake.subscriptions[0]!.push(HEARTBEAT);
    await waitUntil(() => provider.observationStreamLive?.() === true && clock.pending() === 1);

    // No further frames: the watchdog aborts and the monitor resubscribes.
    clock.advance(SILENCE_MS);
    await waitUntil(() => fake.subscriptions.length === 2);
    expect(fake.subscribeCallCount).toBe(2);
    fake.subscriptions[1]!.push({ type: "server.connected", properties: {} });
    await waitUntil(() => provider.observationStreamLive?.() === true);
  });

  test("regular heartbeats keep the stream open", async () => {
    const fake = openCodeFake();
    const clock = manualClock();
    silenceProvider(fake, clock);
    await waitUntil(() => fake.subscriptions.length === 1);
    for (let index = 0; index < 8; index += 1) {
      await pushSeen(fake, clock, HEARTBEAT);
      clock.advance(SILENCE_MS / 3);
    }
    // Two full silence windows have passed; the deadline is still armed.
    expect(clock.pending()).toBe(1);
    expect(fake.subscribeCallCount).toBe(1);
  });

  test("any frame counts as life once the deadline is armed", async () => {
    const fake = openCodeFake();
    const clock = manualClock();
    silenceProvider(fake, clock);
    await waitUntil(() => fake.subscriptions.length === 1);
    await pushSeen(fake, clock, HEARTBEAT);
    for (let index = 0; index < 8; index += 1) {
      await pushSeen(fake, clock, { type: "vcs.branch.updated", properties: {} });
      clock.advance(SILENCE_MS / 3);
    }
    expect(clock.pending()).toBe(1);
    expect(fake.subscribeCallCount).toBe(1);
  });

  test("a server that never heartbeats is not reconnected while idle", async () => {
    const fake = openCodeFake();
    const clock = manualClock();
    const provider = silenceProvider(fake, clock);
    await waitUntil(() => fake.subscriptions.length === 1);
    await pushSeen(fake, clock, { type: "server.connected", properties: {} });
    await waitUntil(() => provider.observationStreamLive?.() === true);
    // No heartbeat, so no deadline was ever scheduled to fire.
    expect(clock.pending()).toBe(0);
    clock.advance(SILENCE_MS * 4);
    expect(fake.subscribeCallCount).toBe(1);
    expect(provider.observationStreamLive?.()).toBe(true);
  });

  test("heartbeats are not counted as unknown events", async () => {
    const fake = openCodeFake();
    const clock = manualClock();
    const provider = silenceProvider(fake, clock);
    await waitUntil(() => fake.subscriptions.length === 1);
    fake.subscriptions[0]!.push(HEARTBEAT);
    fake.subscriptions[0]!.push(HEARTBEAT);
    fake.subscriptions[0]!.push({ type: "not.a.real.event", properties: {} });
    await waitUntil(() => unknownEventCount(provider) === 1);
    expect(unknownEventCount(provider)).toBe(1);
  });

  test("disposing the provider stops the deadline", async () => {
    const fake = openCodeFake();
    const clock = manualClock();
    const provider = silenceProvider(fake, clock);
    await waitUntil(() => fake.subscriptions.length === 1);
    await pushSeen(fake, clock, HEARTBEAT);
    expect(clock.pending()).toBe(1);
    await provider.dispose?.();
    providers.splice(providers.indexOf(provider), 1);
    await waitUntil(() => clock.pending() === 0);
    clock.advance(SILENCE_MS * 2);
    expect(fake.subscribeCallCount).toBe(1);
  });
});

describe("OpenCodeStreamSilenceWatchdog", () => {
  function watchdog(silenceMs: number) {
    const clock = manualClock();
    const fired: number[] = [];
    const instance = new OpenCodeStreamSilenceWatchdog((ms) => fired.push(ms), {
      silenceMs,
      clock: clock.clock,
    });
    watchdogs.push(instance);
    return { instance, fired, clock };
  }

  test("defaults to three missed 10 s heartbeats plus slack", () => {
    expect(OPENCODE_EVENT_STREAM_SILENCE_MS).toBe(35_000);
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

  test("recognises only the heartbeat frame", () => {
    expect(isOpenCodeHeartbeat(HEARTBEAT)).toBe(true);
    expect(isOpenCodeHeartbeat({ type: "server.connected" })).toBe(false);
    expect(isOpenCodeHeartbeat(null)).toBe(false);
    expect(isOpenCodeHeartbeat("server.heartbeat")).toBe(false);
  });
});

describe("consumeOpenCodeEventStream", () => {
  async function* frames(...values: unknown[]) {
    for (const value of values) yield value;
  }

  test("reports the first frame once, skips heartbeats and stops its watchdog", async () => {
    const clock = manualClock();
    const seen: unknown[] = [];
    let connected = 0;
    const event = { type: "session.idle", properties: {} };
    const result = await consumeOpenCodeEventStream(
      frames(HEARTBEAT, event, HEARTBEAT),
      {
        disposed: () => false,
        connected: () => (connected += 1),
        frame: (raw) => seen.push(raw),
        silent: () => {
          throw new Error("not silent");
        },
      },
      { silenceMs: SILENCE_MS, clock: clock.clock },
    );
    expect(result).toBe("ended");
    expect(connected).toBe(1);
    expect(seen).toEqual([event]);
    expect(clock.pending()).toBe(0);
  });

  test("returns disposed without dispatching once the owner is disposed", async () => {
    const clock = manualClock();
    const seen: unknown[] = [];
    const result = await consumeOpenCodeEventStream(
      frames({ type: "session.idle", properties: {} }),
      {
        disposed: () => true,
        connected: () => {},
        frame: (raw) => seen.push(raw),
        silent: () => {},
      },
      { clock: clock.clock },
    );
    expect(result).toBe("disposed");
    expect(seen).toEqual([]);
  });
});
