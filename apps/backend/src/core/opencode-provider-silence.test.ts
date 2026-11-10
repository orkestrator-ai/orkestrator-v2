import { afterEach, describe, expect, test } from "bun:test";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import { openCodeFake, waitUntil, type OpenCodeFake } from "./agent-provider-test-support.js";
import {
  isOpenCodeHeartbeat,
  OPENCODE_EVENT_STREAM_SILENCE_MS,
  OpenCodeStreamSilenceWatchdog,
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

function silenceProvider(fake: OpenCodeFake): NativeAgentRuntimeProvider {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("OpenCode event monitor silence", () => {
  test("a stream that heartbeated and then went silent is replaced", async () => {
    const fake = openCodeFake();
    const provider = silenceProvider(fake);
    await waitUntil(() => fake.subscriptions.length === 1);
    fake.subscriptions[0]!.push({ type: "server.connected", properties: {} });
    fake.subscriptions[0]!.push(HEARTBEAT);
    await waitUntil(() => provider.observationStreamLive?.() === true);

    // No further frames: the watchdog aborts and the monitor resubscribes.
    await waitUntil(() => fake.subscriptions.length === 2, 2_000);
    expect(fake.subscribeCallCount).toBe(2);
    fake.subscriptions[1]!.push({ type: "server.connected", properties: {} });
    await waitUntil(() => provider.observationStreamLive?.() === true);
  });

  test("regular heartbeats keep the stream open", async () => {
    const fake = openCodeFake();
    silenceProvider(fake);
    await waitUntil(() => fake.subscriptions.length === 1);
    for (let index = 0; index < 8; index += 1) {
      fake.subscriptions[0]!.push(HEARTBEAT);
      await sleep(SILENCE_MS / 3);
    }
    expect(fake.subscribeCallCount).toBe(1);
  });

  test("any frame counts as life once the deadline is armed", async () => {
    const fake = openCodeFake();
    silenceProvider(fake);
    await waitUntil(() => fake.subscriptions.length === 1);
    fake.subscriptions[0]!.push(HEARTBEAT);
    for (let index = 0; index < 8; index += 1) {
      fake.subscriptions[0]!.push({ type: "vcs.branch.updated", properties: {} });
      await sleep(SILENCE_MS / 3);
    }
    expect(fake.subscribeCallCount).toBe(1);
  });

  test("a server that never heartbeats is not reconnected while idle", async () => {
    const fake = openCodeFake();
    const provider = silenceProvider(fake);
    await waitUntil(() => fake.subscriptions.length === 1);
    fake.subscriptions[0]!.push({ type: "server.connected", properties: {} });
    await waitUntil(() => provider.observationStreamLive?.() === true);
    await sleep(SILENCE_MS * 4);
    expect(fake.subscribeCallCount).toBe(1);
    expect(provider.observationStreamLive?.()).toBe(true);
  });

  test("heartbeats are not counted as unknown events", async () => {
    const fake = openCodeFake();
    const provider = silenceProvider(fake);
    await waitUntil(() => fake.subscriptions.length === 1);
    fake.subscriptions[0]!.push(HEARTBEAT);
    fake.subscriptions[0]!.push(HEARTBEAT);
    fake.subscriptions[0]!.push({ type: "not.a.real.event", properties: {} });
    await waitUntil(() => unknownEventCount(provider) === 1);
    expect(unknownEventCount(provider)).toBe(1);
  });

  test("disposing the provider stops the deadline", async () => {
    const fake = openCodeFake();
    const provider = silenceProvider(fake);
    await waitUntil(() => fake.subscriptions.length === 1);
    fake.subscriptions[0]!.push(HEARTBEAT);
    await sleep(5);
    await provider.dispose?.();
    providers.splice(providers.indexOf(provider), 1);
    await sleep(SILENCE_MS * 2);
    expect(fake.subscribeCallCount).toBe(1);
  });
});

describe("OpenCodeStreamSilenceWatchdog", () => {
  function watchdog(silenceMs: number, now: () => number) {
    const fired: number[] = [];
    const instance = new OpenCodeStreamSilenceWatchdog((ms) => fired.push(ms), { silenceMs, now });
    watchdogs.push(instance);
    return { instance, fired };
  }

  test("defaults to three missed 10 s heartbeats plus slack", () => {
    expect(OPENCODE_EVENT_STREAM_SILENCE_MS).toBe(35_000);
  });

  test("stays unarmed until a heartbeat arrives", async () => {
    let clock = 0;
    const { instance, fired } = watchdog(20, () => clock);
    instance.frame(false);
    clock = 1_000;
    await sleep(40);
    expect(instance.isArmed).toBe(false);
    expect(fired).toEqual([]);
  });

  test("re-checks elapsed silence instead of firing on the first timer", async () => {
    let clock = 0;
    const { instance, fired } = watchdog(30, () => clock);
    instance.frame(true);
    // A frame 20 ms in moves the deadline; the first timer must re-arm.
    await sleep(10);
    clock = 20;
    instance.frame(false);
    clock = 30;
    await sleep(30);
    expect(fired).toEqual([]);
    clock = 60;
    await waitUntil(() => fired.length === 1);
    expect(fired).toEqual([30]);
    expect(instance.isArmed).toBe(false);
  });

  test("stop cancels a pending deadline", async () => {
    let clock = 0;
    const { instance, fired } = watchdog(10, () => clock);
    instance.frame(true);
    instance.stop();
    clock = 1_000;
    await sleep(30);
    expect(fired).toEqual([]);
    instance.frame(true);
    expect(instance.isArmed).toBe(false);
  });

  test("recognises only the heartbeat frame", () => {
    expect(isOpenCodeHeartbeat(HEARTBEAT)).toBe(true);
    expect(isOpenCodeHeartbeat({ type: "server.connected" })).toBe(false);
    expect(isOpenCodeHeartbeat(null)).toBe(false);
    expect(isOpenCodeHeartbeat("server.heartbeat")).toBe(false);
  });
});
