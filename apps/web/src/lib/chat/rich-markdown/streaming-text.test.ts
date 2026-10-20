import { describe, expect, test } from "bun:test";
import { MARKDOWN_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  STREAMING_IDLE_MS,
  STREAMING_MIN_INTERVAL_MS,
  StreamingTextCoalescer,
  type CoalescerScheduler,
} from "./streaming-text";

/** A deterministic clock with manually flushed timers and animation frames. */
function fakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const frames = new Map<number, () => void>();
  const scheduler: CoalescerScheduler = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => timers.delete(handle as number),
    requestFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (handle) => frames.delete(handle as number),
  };
  return {
    scheduler,
    pendingFrames: () => frames.size,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    flushFrames() {
      for (const [id, callback] of Array.from(frames.entries())) {
        frames.delete(id);
        callback();
      }
    },
  };
}

describe("StreamingTextCoalescer", () => {
  test("the interval matches the policy's maximum update rate", () => {
    expect(STREAMING_MIN_INTERVAL_MS).toBe(1000 / MARKDOWN_POLICY.maxStreamingUpdatesPerSecond);
  });

  test("commits at most one frame at a time and no more than the policy rate", () => {
    const clock = fakeScheduler();
    const commits: string[] = [];
    const coalescer = new StreamingTextCoalescer("", (text) => commits.push(text), clock.scheduler);
    let text = "";
    // One character every millisecond for one second.
    for (let ms = 0; ms < 1000; ms++) {
      text += "x";
      coalescer.push(text);
      expect(clock.pendingFrames()).toBeLessThanOrEqual(1);
      clock.advance(1);
      clock.flushFrames();
    }
    clock.advance(STREAMING_MIN_INTERVAL_MS);
    clock.flushFrames();
    const liveCommits = commits.length;
    expect(liveCommits).toBeLessThanOrEqual(MARKDOWN_POLICY.maxStreamingUpdatesPerSecond + 1);
    // The final flush shows the complete text.
    expect(commits.at(-1)).toBe(text);
    coalescer.dispose();
  });

  test("a non-append change commits immediately", () => {
    const clock = fakeScheduler();
    const commits: Array<[string, boolean]> = [];
    const coalescer = new StreamingTextCoalescer(
      "hello",
      (text, live) => commits.push([text, live]),
      clock.scheduler,
    );
    expect(coalescer.push("replaced")).toBe(true);
    expect(commits).toEqual([["replaced", false]]);
  });

  test("live clears after the idle window with a final commit", () => {
    const clock = fakeScheduler();
    const commits: Array<[string, boolean]> = [];
    const coalescer = new StreamingTextCoalescer(
      "a",
      (text, live) => commits.push([text, live]),
      clock.scheduler,
    );
    coalescer.push("ab");
    clock.flushFrames();
    expect(commits.at(-1)).toEqual(["ab", true]);
    clock.advance(STREAMING_IDLE_MS + 1);
    expect(commits.at(-1)).toEqual(["ab", false]);
  });
});
