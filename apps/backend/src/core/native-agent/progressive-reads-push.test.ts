/**
 * The push layer's settled-read share (`observeSession`): while a session is
 * observed, the read a viewer sends after a frame takes the observer's answer
 * instead of a second provider read; nothing else changes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { NativeAgentProgressiveReads, OBSERVED_SETTLED_SHARE_MS } from "./progressive-reads.js";

const SESSION = "env\u0000claude\u0000tab";
const KEY = `${SESSION}\u0000progressive-v1\u0000state`;

const instances: NativeAgentProgressiveReads[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.clear();
});

function reads() {
  const projectionEpochs = new Map<string, number>();
  const instance = new NativeAgentProgressiveReads({
    host: {},
    storage: {},
    projectionEpochs,
  } as never);
  instances.push(instance);
  let providerReads = 0;
  const read = async () => {
    providerReads += 1;
    return { value: providerReads };
  };
  return { instance, projectionEpochs, read, providerReads: () => providerReads };
}

describe("observed settled reads", () => {
  test("an unobserved session reads the provider every time", async () => {
    const r = reads();
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    expect(r.providerReads()).toBe(2);
  });

  test("an observed session answers the next read from the settled one, within the window", async () => {
    const r = reads();
    const stop = r.instance.observeSession(SESSION);
    const first = await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    const second = await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    expect(second).toBe(first);
    expect(r.providerReads()).toBe(1);
    stop();
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    expect(r.providerReads()).toBe(2);
  });

  test("the share expires", async () => {
    const r = reads();
    let now = 1_000;
    r.instance.forTesting().setObservedShareClock(() => now);
    r.instance.observeSession(SESSION);
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    now += OBSERVED_SETTLED_SHARE_MS - 1;
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    expect(r.providerReads()).toBe(1);
    now += 1;
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    expect(r.providerReads()).toBe(2);
  });

  test("forced and fresh-source reads, a moved epoch and a wake all go to the provider", async () => {
    const r = reads();
    r.instance.observeSession(SESSION);
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, true, r.read);
    expect(r.providerReads()).toBe(2);
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read, true);
    expect(r.providerReads()).toBe(3);

    r.projectionEpochs.set(SESSION, 1);
    await r.instance.progressiveReadCovering(KEY, SESSION, 1, false, r.read);
    expect(r.providerReads()).toBe(4);

    r.instance.forgetObservedSettled(SESSION);
    await r.instance.progressiveReadCovering(KEY, SESSION, 1, false, r.read);
    expect(r.providerReads()).toBe(5);
    // And the identity change itself drops it.
    r.instance.forgetSession(SESSION, 2);
    r.projectionEpochs.set(SESSION, 2);
    await r.instance.progressiveReadCovering(KEY, SESSION, 2, false, r.read);
    expect(r.providerReads()).toBe(6);
  });

  test("observer ticks fetch from the source and share the new value with viewers", async () => {
    const r = reads();
    const stop = r.instance.observeSession(SESSION);
    const observe = () =>
      r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read, false, true);
    expect(await observe()).toEqual({ value: 1 });
    expect(await observe()).toEqual({ value: 2 });
    expect(await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read)).toEqual({
      value: 2,
    });
    expect(r.providerReads()).toBe(2);
    stop();
  });

  test("a wake cannot be refilled by an older read, and the observer gets fresh source work", async () => {
    const r = reads();
    const stop = r.instance.observeSession(SESSION);
    const old = Promise.withResolvers<{ value: number }>();
    const first = r.instance.progressiveReadCovering(KEY, SESSION, 0, false, () => old.promise);
    r.instance.forgetObservedSettled(SESSION);
    const observer = r.instance.progressiveReadCovering(
      KEY,
      SESSION,
      0,
      false,
      r.read,
      false,
      true,
    );
    old.resolve({ value: 99 });
    expect(await first).toEqual({ value: 99 });
    expect(await observer).toEqual({ value: 1 });
    expect(await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read)).toEqual({
      value: 1,
    });
    stop();
  });

  test("a bridge hint keeps the observer's answer for the viewers but gives the observer fresh work", async () => {
    const r = reads();
    const stop = r.instance.observeSession(SESSION);
    const observe = (read: () => Promise<{ value: number }> = r.read) =>
      r.instance.progressiveReadCovering(KEY, SESSION, 0, false, read, false, true);
    // The observer's hint-driven read announces a frame...
    expect(await observe()).toEqual({ value: 1 });
    // ...and more hints arrive while the turn streams.
    r.instance.noteObservationHint(SESSION);
    // The viewer reading after that frame takes the observer's answer: no provider read.
    expect(await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read)).toEqual({
      value: 1,
    });
    expect(r.providerReads()).toBe(1);

    // Work that started before a hint is not what the observer's next read joins.
    const old = Promise.withResolvers<{ value: number }>();
    const viewer = r.instance.progressiveReadCovering(KEY, SESSION, 0, true, () => old.promise);
    r.instance.noteObservationHint(SESSION);
    const observer = observe();
    old.resolve({ value: 99 });
    expect(await viewer).toEqual({ value: 99 });
    expect(await observer).toEqual({ value: 2 });
    expect(r.providerReads()).toBe(2);
    stop();
  });

  test("queues ten sessions fairly while reserving source slots for foreground work", async () => {
    const r = reads();
    const gate = Promise.withResolvers<void>();
    const started: number[] = [];
    const stops: Array<() => void> = [];
    const observed = Array.from({ length: 10 }, (_, index) => {
      const key = `${SESSION}-${index}`;
      stops.push(r.instance.observeSession(key));
      return r.instance.progressiveReadCovering(
        `${key}\0progressive-v1\0state`,
        key,
        0,
        false,
        async () => {
          started.push(index);
          await gate.promise;
          return index;
        },
        false,
        true,
      );
    });
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read)).toEqual({
      value: 1,
    });
    gate.resolve();
    expect(await Promise.all(observed)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const stop of stops) stop();
  });

  test("oversized values are not retained and expired values are evicted without a lookup", async () => {
    const r = reads();
    const stop = r.instance.observeSession(SESSION);
    try {
      await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, async () =>
        "x".repeat(9 * 1024 * 1024),
      );
      expect(r.instance.cacheGauges().observedSettled).toBe(0);
      await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
      expect(r.instance.cacheGauges().observedSettled).toBe(1);
      const until = Date.now() + OBSERVED_SETTLED_SHARE_MS + 1_000;
      while (r.instance.cacheGauges().observedSettled && Date.now() < until) await Bun.sleep(20);
      expect(r.instance.cacheGauges().observedSettled).toBe(0);
    } finally {
      stop();
    }
  });

  test("a running read is joined in preference to a settled one", async () => {
    const r = reads();
    r.instance.observeSession(SESSION);
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    let release!: () => void;
    const slow = () =>
      new Promise<{ value: number }>((resolve) => {
        release = () => resolve({ value: 99 });
      });
    // A forced read starts provider work while the share is still fresh.
    const running = r.instance.progressiveReadCovering(KEY, SESSION, 0, true, slow);
    const joined = r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    release();
    expect(await running).toEqual({ value: 99 });
    expect(await joined).toEqual({ value: 99 });
  });

  test("two observers of one session share one count", async () => {
    const r = reads();
    const a = r.instance.observeSession(SESSION);
    const b = r.instance.observeSession(SESSION);
    a();
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    await r.instance.progressiveReadCovering(KEY, SESSION, 0, false, r.read);
    expect(r.providerReads()).toBe(1);
    b();
    expect(r.instance.cacheGauges()).toMatchObject({ observedSessions: 0, observedSettled: 0 });
  });
});
