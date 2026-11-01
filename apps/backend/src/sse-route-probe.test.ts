import { describe, expect, test } from "bun:test";
import {
  analyzeArrivals,
  HELD_FLOOR_MS,
  parseMeasureOptions,
  parseServeOptions,
  type TickArrival,
} from "../scripts/sse-route-probe.js";
const INTERVAL_MS = 1_000;
function arrivals(delays: readonly number[], clockOffsetMs = 86_400_000): TickArrival[] {
  return delays.map((delay, seq) => {
    const sentAtMs = 1_000_000 + seq * INTERVAL_MS;
    return { seq, sentAtMs, arrivedAtMs: sentAtMs + clockOffsetMs + delay };
  });
}
describe("analyzeArrivals", () => {
  test("a steady route holds nothing, whatever the two clocks' offset", () => {
    for (const offset of [0, 86_400_000, -86_400_000]) {
      expect(analyzeArrivals(arrivals([40, 42, 41, 45, 40], offset), 5, INTERVAL_MS)).toMatchObject(
        {
          ticks: 5,
          missing: 0,
          duplicates: 0,
          outOfOrder: 0,
          heldTicks: 0,
          delayMaxMs: 5,
        },
      );
    }
  });

  test("a route that releases ticks in a batch shows every held tick", () => {
    // Four ticks held until the fifth arrives: the first waited four intervals.
    const batched = arrivals([4_000, 3_000, 2_000, 1_000, 0]);
    expect(analyzeArrivals(batched, 5, INTERVAL_MS)).toMatchObject({
      heldTicks: 4,
      delayMaxMs: 4_000,
      heldThresholdMs: INTERVAL_MS / 2,
    });
  });

  test("the threshold never drops below the floor on a fast schedule", () => {
    const fast = analyzeArrivals(arrivals([0, HELD_FLOOR_MS]), 2, 10);
    expect(fast).toMatchObject({
      heldThresholdMs: HELD_FLOOR_MS,
      heldTicks: 0,
    });
    expect(analyzeArrivals(arrivals([0, HELD_FLOOR_MS + 1]), 2, 10).heldTicks).toBe(1);
  });

  test("counts missing, duplicate and out-of-order ticks", () => {
    const [first, second, third] = arrivals([0, 0, 0]) as [TickArrival, TickArrival, TickArrival];
    const result = analyzeArrivals([first, third, second, second], 5, INTERVAL_MS);
    expect(result).toMatchObject({
      ticks: 3,
      missing: 2,
      duplicates: 1,
      outOfOrder: 2,
    });
  });

  test("an empty run reports every tick as missing", () => {
    expect(analyzeArrivals([], 3, INTERVAL_MS)).toMatchObject({
      ticks: 0,
      missing: 3,
      delayMaxMs: 0,
    });
  });
});

describe("options", () => {
  test("refuses the production ports", () => {
    expect(() => parseServeOptions(["--port", "34121"])).toThrow("production backend");
    expect(() => parseServeOptions(["--port", "34122"])).toThrow("production backend");
  });

  test("serves gzip on an ephemeral loopback port by default", () => {
    expect(parseServeOptions([])).toEqual({
      bind: "127.0.0.1",
      port: 0,
      compression: "on",
      keepaliveMs: 25_000,
    });
    expect(() => parseServeOptions(["--compression", "brotli"])).toThrow("--compression");
  });

  test("measures what a browser sends unless told otherwise", () => {
    const required = ["--url", "http://127.0.0.1:1", "--token-file", "/tmp/token"];
    expect(parseMeasureOptions(required)).toMatchObject({
      acceptEncoding: "gzip, deflate, br, zstd",
      http2: false,
      keepaliveEvents: true,
      frames: 30,
      intervalMs: 1_000,
      idleMs: 60_000,
    });
    expect(
      parseMeasureOptions([...required, "--accept-encoding", "none", "--http2"]),
    ).toMatchObject({ acceptEncoding: null, http2: true });
    expect(() => parseMeasureOptions(["--url", "http://127.0.0.1:1"])).toThrow("--token-file");
  });
});
