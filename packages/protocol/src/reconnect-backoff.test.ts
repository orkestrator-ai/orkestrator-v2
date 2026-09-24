import { describe, expect, test } from "bun:test";
import {
  ReconnectBackoff,
  type ReconnectBackoffPolicy,
  reconnectDelayMs,
} from "./reconnect-backoff.js";

const POLICY: ReconnectBackoffPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  healthyAfterMs: 30_000,
};
const HIGH = () => 0.999_999;
const LOW = () => 0;

describe("reconnectDelayMs", () => {
  test("doubles per consecutive failure up to the cap", () => {
    const delays = Array.from({ length: 8 }, (_, failures) =>
      reconnectDelayMs(POLICY, failures, HIGH),
    );
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  test("equal jitter keeps every delay within [base / 2, base]", () => {
    expect(reconnectDelayMs(POLICY, 0, LOW)).toBe(500);
    expect(reconnectDelayMs(POLICY, 3, LOW)).toBe(4_000);
    expect(reconnectDelayMs(POLICY, 10, LOW)).toBe(15_000);
    expect(reconnectDelayMs(POLICY, 0, () => 0.5)).toBe(750);
  });

  test("the first retry is never slower than the initial delay", () => {
    for (let sample = 0; sample < 1; sample += 0.05) {
      expect(reconnectDelayMs(POLICY, 0, () => sample)).toBeLessThanOrEqual(1_000);
    }
  });

  test("spreads simultaneous reconnects instead of keeping them in lock-step", () => {
    const samples = [0.02, 0.31, 0.47, 0.66, 0.93];
    const delays = samples.map((sample) => reconnectDelayMs(POLICY, 4, () => sample));
    expect(new Set(delays).size).toBe(samples.length);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(8_000);
      expect(delay).toBeLessThanOrEqual(16_000);
    }
  });

  test("honours a custom multiplier, full jitter and no jitter", () => {
    expect(reconnectDelayMs({ ...POLICY, multiplier: 3, jitterRatio: 0 }, 2, LOW)).toBe(9_000);
    expect(reconnectDelayMs({ ...POLICY, jitterRatio: 1 }, 2, LOW)).toBe(0);
    expect(reconnectDelayMs({ ...POLICY, jitterRatio: 1 }, 2, HIGH)).toBe(4_000);
  });

  test("stays bounded for hostile inputs", () => {
    expect(reconnectDelayMs(POLICY, Number.POSITIVE_INFINITY, HIGH)).toBe(30_000);
    expect(reconnectDelayMs(POLICY, -3, HIGH)).toBe(1_000);
    expect(reconnectDelayMs(POLICY, Number.NaN, HIGH)).toBe(1_000);
    expect(reconnectDelayMs(POLICY, 2, () => 7)).toBe(4_000);
    expect(reconnectDelayMs(POLICY, 2, () => -1)).toBe(2_000);
    expect(reconnectDelayMs(POLICY, 2, () => Number.NaN)).toBe(2_000);
    // A cap below the initial delay cannot make the first retry faster than asked.
    expect(reconnectDelayMs({ ...POLICY, maxDelayMs: 10 }, 5, HIGH)).toBe(1_000);
  });
});

describe("ReconnectBackoff", () => {
  function tracker() {
    let now = 0;
    const backoff = new ReconnectBackoff(POLICY, { now: () => now, random: HIGH });
    return {
      backoff,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  test("repeated failures to connect climb the ladder", () => {
    const { backoff } = tracker();
    expect([backoff.nextDelayMs(), backoff.nextDelayMs(), backoff.nextDelayMs()]).toEqual([
      1_000, 2_000, 4_000,
    ]);
    expect(backoff.failures).toBe(3);
  });

  test("a connection that closes immediately does not reset the ladder", () => {
    const { backoff, advance } = tracker();
    backoff.nextDelayMs();
    backoff.nextDelayMs();

    backoff.connected();
    advance(50);
    expect(backoff.nextDelayMs()).toBe(4_000);
  });

  test("a connection that stayed healthy resets it, so the next retry is fast again", () => {
    const { backoff, advance } = tracker();
    for (let index = 0; index < 6; index += 1) backoff.nextDelayMs();

    backoff.connected();
    advance(29_999);
    backoff.connected();
    advance(1);
    expect(backoff.nextDelayMs()).toBe(1_000);
    expect(backoff.nextDelayMs()).toBe(2_000);
  });

  test("health is measured per connection, not accumulated across them", () => {
    const { backoff, advance } = tracker();
    backoff.nextDelayMs();
    for (let index = 0; index < 3; index += 1) {
      backoff.connected();
      advance(20_000);
      backoff.nextDelayMs();
    }
    expect(backoff.failures).toBe(4);
  });

  test("reset forgets history", () => {
    const { backoff } = tracker();
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(1_000);
  });
});
