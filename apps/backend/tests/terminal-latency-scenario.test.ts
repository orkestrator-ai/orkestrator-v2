import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LEVELS,
  distribution,
  EchoTracker,
  parseLatencyArgs,
  parseLevel,
  percentile,
  SseFrameReader,
  type SseEvent,
} from "../scripts/terminal-latency/scenario";

describe("terminal latency benchmark helpers", () => {
  test("parses a custom level and rejects a malformed one", () => {
    expect(parseLevel("soak:8,4,2,1")).toEqual({
      name: "soak",
      buildTerminals: 8,
      toolTerminals: 4,
      agents: 2,
      observers: 1,
    });
    expect(() => parseLevel("soak:8,4")).toThrow("name:build,tool,agents,observers");
  });

  test("selects levels and applies flags over the defaults", () => {
    const options = parseLatencyArgs([
      "--only",
      "busy",
      "--keystrokes",
      "50",
      "--history",
      "off",
      "--client-parse",
      "off",
      "--json",
    ]);
    expect(options.levels).toEqual(DEFAULT_LEVELS.filter((level) => level.name === "busy"));
    expect(options).toMatchObject({
      keystrokes: 50,
      history: false,
      clientParse: false,
      json: true,
    });
    expect(parseLatencyArgs(["--level", "a:1,0,0,0", "--level", "b:0,1,0,0"]).levels).toHaveLength(
      2,
    );
    expect(() => parseLatencyArgs(["--only", "nope"])).toThrow("Unknown level nope");
    expect(() => parseLatencyArgs(["--keystrokes", "0"])).toThrow("positive integer");
    expect(() => parseLatencyArgs(["--history", "maybe"])).toThrow("on or off");
    expect(() => parseLatencyArgs(["--frobnicate"])).toThrow("Unknown option --frobnicate");
  });

  test("summarizes with nearest-rank percentiles", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile([], 0.95)).toBe(0);
    expect(distribution([3, 1, 2])).toEqual({ count: 3, p50: 2, p95: 3, p99: 3, max: 3 });
  });

  test("reads gateway SSE frames split anywhere, with comments and ids", () => {
    const events: SseEvent[] = [];
    const comments: string[] = [];
    const reader = new SseFrameReader(
      (event) => events.push(event),
      (comment) => comments.push(comment),
    );
    const stream =
      ": connected\n\n" +
      `id: 7\ndata: ${JSON.stringify({ event: "terminal-output-a", payload: { text: "x\n" } })}\n\n` +
      `data: ${JSON.stringify({ event: "native-agent-session-activity", payload: {} })}\n\n`;
    for (let offset = 0; offset < stream.length; offset += 5) {
      reader.push(stream.slice(offset, offset + 5));
    }
    expect(comments).toEqual(["connected"]);
    expect(events).toEqual([
      { event: "terminal-output-a", payload: { text: "x\n" } },
      { event: "native-agent-session-activity", payload: {} },
    ]);
    const bounded = new SseFrameReader(() => {}, undefined, 8);
    expect(() => bounded.push("data: unterminated")).toThrow("bound");
  });

  test("matches one outstanding key to its echo", async () => {
    const tracker = new EchoTracker();
    const echoed = tracker.expect("q");
    tracker.observe("abc", 1);
    tracker.observe("xqz", 2);
    tracker.observe("q", 3);
    expect(await echoed).toBe(2);
    const next = tracker.expect("r");
    expect(() => tracker.expect("s")).toThrow("already outstanding");
    tracker.cancel();
    tracker.observe("r", 4);
    const after = tracker.expect("r");
    tracker.observe("r", 5);
    expect(await after).toBe(5);
    void next;
  });
});
