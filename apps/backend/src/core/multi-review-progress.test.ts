import { expect, test } from "bun:test";
import {
  MultiReviewProgressTracker,
  baselineProgressAt,
  noProgressElapsedMs,
  progressFingerprint,
  stalledMinutes,
} from "./multi-review-progress.js";

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms: number) => { value += ms; } };
}

test("the first observation establishes a baseline instead of claiming progress", async () => {
  const tracker = new MultiReviewProgressTracker(1_000, clock().now);

  // An unseen transcript is not evidence that anything moved. The distinct
  // baseline signal lets the service grant restart grace without reporting a
  // transcript comparison that never happened.
  await expect(tracker.observe("session-1", async () => [{ id: "a" }]))
    .resolves.toEqual({ probed: true, baselineEstablished: true, changed: false });
});

test("a changed transcript is reported once the probe interval has elapsed", async () => {
  const time = clock();
  const tracker = new MultiReviewProgressTracker(1_000, time.now);
  let messages: unknown[] = [{ id: "a" }];
  const read = async () => messages;

  await tracker.observe("session-1", read);
  // Inside the interval the transcript is not read at all: even a bounded tail
  // crosses a provider boundary, and the supervisor ticks every second.
  messages = [{ id: "a" }, { id: "b" }];
  await expect(tracker.observe("session-1", read))
    .resolves.toEqual({ probed: false, baselineEstablished: false, changed: false });

  time.advance(1_000);
  await expect(tracker.observe("session-1", read))
    .resolves.toEqual({ probed: true, baselineEstablished: false, changed: true });

  time.advance(1_000);
  await expect(tracker.observe("session-1", read))
    .resolves.toEqual({ probed: true, baselineEstablished: false, changed: false });
});

test("a rewritten streaming entry counts as progress", async () => {
  const time = clock();
  const tracker = new MultiReviewProgressTracker(0, time.now);
  let messages: unknown[] = [{ id: "a", content: "Read" }];
  const read = async () => messages;

  await tracker.observe("session-1", read);
  // Providers grow a transcript by appending and by rewriting the entry that is
  // currently streaming. Length alone would miss the second case entirely.
  messages = [{ id: "a", content: "Reading src/a.ts" }];
  await expect(tracker.observe("session-1", read))
    .resolves.toEqual({ probed: true, baselineEstablished: false, changed: true });
});

test("a failed transcript read answers nothing learned and keeps the baseline", async () => {
  const time = clock();
  const tracker = new MultiReviewProgressTracker(1_000, time.now);
  const messages = [{ id: "a" }];

  await tracker.observe("session-1", async () => messages);
  time.advance(1_000);
  // The caller fails a reviewer on the errors it sees, so a transient read
  // failure must not reach it — and it is not evidence of a stall either.
  await expect(tracker.observe("session-1", async () => { throw new Error("bridge down"); }))
    .resolves.toEqual({ probed: false, baselineEstablished: false, changed: false });
  // The attempt still counts against the throttle, so a bridge refusing reads
  // is retried on the probe interval rather than on every supervisor tick.
  await expect(tracker.observe("session-1", async () => { throw new Error("bridge down"); }))
    .resolves.toEqual({ probed: false, baselineEstablished: false, changed: false });

  time.advance(1_000);
  await expect(tracker.observe("session-1", async () => messages))
    .resolves.toEqual({ probed: true, baselineEstablished: false, changed: false });
});

test("a read that only ever fails never invents a baseline", async () => {
  const time = clock();
  const tracker = new MultiReviewProgressTracker(1_000, time.now);

  await tracker.observe("session-1", async () => { throw new Error("bridge down"); });
  time.advance(1_000);
  // The first successful read is still a baseline, not a change: comparing it
  // against a failure would report progress that was never observed.
  await expect(tracker.observe("session-1", async () => [{ id: "a" }]))
    .resolves.toEqual({ probed: true, baselineEstablished: true, changed: false });
});

test("forgetting a session drops its baseline", async () => {
  const tracker = new MultiReviewProgressTracker(0, clock().now);
  const read = async () => [{ id: "a" }];

  await tracker.observe("session-1", read);
  tracker.forget("session-1");
  await expect(tracker.observe("session-1", read))
    .resolves.toEqual({ probed: true, baselineEstablished: true, changed: false });
});

test("progress fingerprints retain a fixed-size digest instead of transcript content", () => {
  const secretTail = "private transcript content ".repeat(100_000);
  const digest = progressFingerprint([{ id: "a", content: secretTail }]);

  expect(digest).toHaveLength(64);
  expect(digest).not.toContain("private transcript content");
  expect(progressFingerprint([{ id: "a", content: `${secretTail}changed` }]))
    .not.toBe(digest);
});

test("the stall clock falls back to the start time until progress is seen", () => {
  const now = Date.parse("2026-08-17T00:30:00.000Z");
  expect(noProgressElapsedMs(undefined, "2026-08-17T00:00:00.000Z", now)).toBe(30 * 60_000);
  expect(noProgressElapsedMs("2026-08-17T00:20:00.000Z", "2026-08-17T00:00:00.000Z", now))
    .toBe(10 * 60_000);
  // An unusable pair is "no verdict", never "stalled": a missing timestamp must
  // not abandon a session that may be working.
  expect(noProgressElapsedMs(undefined, undefined, now)).toBeNull();
  expect(noProgressElapsedMs("not-a-date", undefined, now)).toBeNull();
});

test("stalled minutes never round a real stall down to zero", () => {
  expect(stalledMinutes(1_000)).toBe(1);
  expect(stalledMinutes(45 * 60_000)).toBe(45);
});

test("restart grace is bounded so repeated restarts cannot postpone the backstop", () => {
  const now = Date.parse("2026-08-17T02:00:00.000Z");
  const warningMs = 10 * 60_000;

  // A session with no durable clock has nothing to bound: `noProgressElapsedMs`
  // falls back to `startedAt`, which is the later timestamp for a new session.
  expect(baselineProgressAt(undefined, warningMs, now)).toBe("2026-08-17T02:00:00.000Z");
  expect(baselineProgressAt("not-a-date", warningMs, now)).toBe("2026-08-17T02:00:00.000Z");

  // A session that was already wedged for two hours keeps everything beyond one
  // warning interval, so a restart costs the backstop 10 minutes, not 2 hours.
  expect(baselineProgressAt("2026-08-17T00:00:00.000Z", warningMs, now))
    .toBe("2026-08-17T01:50:00.000Z");
  // A clock newer than the floor is never moved forward.
  expect(baselineProgressAt("2026-08-17T01:59:00.000Z", warningMs, now))
    .toBe("2026-08-17T01:59:00.000Z");
  // A zero or negative warning interval grants no grace at all.
  expect(baselineProgressAt("2026-08-17T00:00:00.000Z", 0, now))
    .toBe("2026-08-17T02:00:00.000Z");
  expect(baselineProgressAt("2026-08-17T00:00:00.000Z", -1_000, now))
    .toBe("2026-08-17T02:00:00.000Z");
});
