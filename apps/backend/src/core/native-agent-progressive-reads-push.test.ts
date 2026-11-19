/**
 * The push layer's settled-read share (`observeSession`): while a session is
 * observed, the read a viewer sends after a frame takes the observer's answer
 * instead of a second provider read; nothing else changes.
 */
import { describe, expect, test } from "bun:test";
import {
  NativeAgentProgressiveReads,
  OBSERVED_SETTLED_SHARE_MS,
} from "./native-agent-progressive-reads.js";

const SESSION = "env\u0000claude\u0000tab";
const KEY = `${SESSION}\u0000progressive-v1\u0000state`;

function reads() {
  const projectionEpochs = new Map<string, number>();
  const instance = new NativeAgentProgressiveReads({
    host: {},
    storage: {},
    projectionEpochs,
  } as never);
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
