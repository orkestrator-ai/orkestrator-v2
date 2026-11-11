import { afterEach, describe, expect, test } from "bun:test";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import { openCodeFake, waitUntil, type OpenCodeFake } from "./agent-provider-test-support.js";
import { consumeOpenCodeEventStream, isOpenCodeHeartbeat } from "./opencode-observation-stream.js";
import {
  manualSilenceClock,
  type ManualSilenceClock,
} from "./opencode-stream-silence.test-support.js";
import type { NativeAgentRuntimeProvider } from "./agent-provider-contract.js";

/**
 * #2052: an OpenCode event stream that stays open but stops
 * heartbeating is replaced, while a server that never heartbeats is left
 * alone. Heartbeats are liveness only, never dispatched or counted as drift.
 */
const HEARTBEAT = { type: "server.heartbeat", properties: {} };
const SILENCE_MS = 150;

const providers: NativeAgentRuntimeProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.dispose?.();
});

function silenceProvider(
  fake: OpenCodeFake,
  clock: ManualSilenceClock,
): NativeAgentRuntimeProvider {
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
async function pushSeen(
  fake: OpenCodeFake,
  clock: ManualSilenceClock,
  frame: unknown,
): Promise<void> {
  const before = clock.reads;
  fake.subscriptions[0]!.push(frame);
  await waitUntil(() => clock.reads > before);
}

describe("OpenCode event monitor silence", () => {
  test("a stream that heartbeated and then went silent is replaced", async () => {
    const fake = openCodeFake();
    const clock = manualSilenceClock();
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
    const clock = manualSilenceClock();
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
    const clock = manualSilenceClock();
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
    const clock = manualSilenceClock();
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
    const clock = manualSilenceClock();
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
    const clock = manualSilenceClock();
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

describe("isOpenCodeHeartbeat", () => {
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
    const clock = manualSilenceClock();
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
    const clock = manualSilenceClock();
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
