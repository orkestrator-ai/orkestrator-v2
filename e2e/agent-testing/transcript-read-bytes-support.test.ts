import { describe, expect, test } from "bun:test";
import {
  readWindowFigures,
  routeClass,
  summarizeWindows,
  windowFigures,
} from "./transcript-read-bytes-support";

const route = (count: number, bytes: number, decodedBytes = bytes) => ({
  count,
  bytes,
  decodedBytes,
  ms: 1,
  meanMs: 1,
  repeats: 0,
});
const counters = (routes: Record<string, ReturnType<typeof route>>) => ({
  routes,
  delta: {
    snapshots: 0,
    snapshotBytes: 0,
    estimatedDeltaBytes: 0,
    changedRows: 0,
    rows: 0,
    trimmedHeads: 0,
  },
});

describe("transcript read bytes support", () => {
  test("classifies the bridge routes the backend reads", () => {
    expect(routeClass("POST /sessions/activity")).toBe("background");
    expect(routeClass("GET /session/:id/activity")).toBe("background");
    expect(routeClass("GET /change-evidence?cursor&epoch")).toBe("background");
    expect(routeClass("POST /change-evidence/ack")).toBe("background");
    expect(routeClass("GET /session/:id/messages?limit")).toBe("transcript");
    expect(routeClass("GET /session/:id/transcript?limit&targetBytes&version=2")).toBe(
      "transcript",
    );
    expect(routeClass("GET /session/:id/transcript/detail?locator")).toBe("transcript");
    expect(routeClass("GET /session/:id")).toBe("state");
    expect(routeClass("GET /session/:id/status")).toBe("state");
    expect(routeClass("GET /session/:id/runtime-health")).toBe("other");
    expect(routeClass("POST /session/:id/prompt")).toBe("other");
    // Not a session route: `/sessions/:id` paths are labelled as such.
    expect(routeClass("GET /session/:id/messagesx")).toBe("other");
  });

  test("keeps background timers out of a window's figures", () => {
    const figures = windowFigures(
      { kind: "prompt-send", from: 1_000, to: 7_000, dispatchMs: 40, modelReachedMs: 140 },
      counters({
        "POST /session/:id/prompt": route(1, 117),
        "GET /session/:id": route(2, 7_000),
        "GET /session/:id/messages?limit": route(1, 330, 900),
        "POST /sessions/activity": route(3, 504),
        "GET /change-evidence?cursor&epoch": route(3, 2_203),
      }),
    );
    expect(figures).toMatchObject({
      kind: "prompt-send",
      ms: 6_000,
      dispatchMs: 40,
      modelReachedMs: 140,
      requests: 4,
      bytes: 7_447,
      decodedBytes: 8_017,
      transcriptRequests: 1,
      transcriptBytes: 330,
      stateRequests: 2,
      stateBytes: 7_000,
      backgroundRequests: 6,
      backgroundBytes: 2_707,
    });
    expect(Object.keys(figures.routes)).toHaveLength(5);
  });

  test("summarises each kind of window", () => {
    const reads: Record<number, ReturnType<typeof counters>> = {
      1: counters({ "GET /session/:id": route(1, 3_600) }),
      2: counters({ "GET /session/:id": route(1, 3_800), "GET /global/health": route(1, 33) }),
      3: counters({ "GET /session/:id/messages?limit": route(1, 1_200) }),
    };
    const { windows, summary } = readWindowFigures(
      [
        { kind: "turn-check", from: 1, to: 2 },
        { kind: "turn-check", from: 2, to: 3 },
        { kind: "pre-e9-turn-check", from: 3, to: 4 },
      ],
      (from) => reads[from]!,
    );
    expect(windows).toHaveLength(3);
    expect(summary["turn-check"]).toMatchObject({
      windows: 2,
      meanRequests: 1.5,
      meanBytes: 3_717,
      minBytes: 3_600,
      maxBytes: 3_833,
      meanTranscriptBytes: 0,
      meanStateBytes: 3_700,
      routes: { "GET /session/:id": { count: 2, bytes: 7_400 } },
    });
    expect(summary["pre-e9-turn-check"]?.meanTranscriptBytes).toBe(1_200);
    expect(summarizeWindows([])).toEqual({});
  });
});
