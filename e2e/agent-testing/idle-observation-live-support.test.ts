import { describe, expect, test } from "bun:test";
import {
  IDLE_OBSERVATION_CASES,
  droppableGatewayEvent,
  failedCases,
  freshToolResults,
  shellOutputContainsMarker,
  gapHistogram,
  readCadence,
  readGaps,
  selectedCases,
  sidebarActivityFromClass,
} from "./idle-observation-live-support";

describe("idle observation live support", () => {
  test("case selection keeps the canonical order and rejects unknown names", () => {
    expect(selectedCases(undefined)).toEqual([...IDLE_OBSERVATION_CASES]);
    expect(selectedCases(" hidden , approval ")).toEqual(["approval", "hidden"]);
    expect(() => selectedCases("approval,typo")).toThrow("typo");
  });

  test("read cadence counts reads and the largest gap inside the window", () => {
    expect(readGaps([0, 1_500, 4_500])).toEqual([1_500, 3_000]);
    const cadence = readCadence([0, 10_000, 25_000, 40_000, 70_000], 5_000, 65_000);
    expect(cadence).toEqual({ reads: 3, perMinute: 3, maxGapMs: 15_000 });
    expect(readCadence([], 0, 60_000)).toEqual({
      reads: 0,
      perMinute: 0,
      maxGapMs: null,
    });
  });

  test("read gaps are bucketed so one tick's burst reads apart from backoff steps", () => {
    expect(gapHistogram([0, 100, 1_600, 4_600, 14_600, 29_600, 99_000], 0, 30_000)).toEqual({
      "<250ms": 1,
      "250ms-2s": 1,
      "2-6s": 1,
      "6-12s": 1,
      ">=12s": 1,
    });
  });

  test("the sidebar icon class maps to its activity state", () => {
    expect(sidebarActivityFromClass("h-4 text-blue-500 animate-pulse")).toBe("working");
    expect(sidebarActivityFromClass("h-4 text-amber-500 animate-pulse")).toBe("waiting");
    expect(sidebarActivityFromClass("h-4 text-success")).toBe("idle");
    expect(sidebarActivityFromClass("h-4 text-muted-foreground")).toBe("stopped");
    expect(sidebarActivityFromClass(null)).toBe("unknown");
  });

  test("the fault seam never drops transport control frames", () => {
    expect(droppableGatewayEvent("native-agent-session-activity")).toBe(true);
    expect(droppableGatewayEvent("gateway.cursor")).toBe(false);
    expect(droppableGatewayEvent("gateway.reconcile-required")).toBe(false);
    expect(droppableGatewayEvent("native-event-stream-connected")).toBe(false);
    expect(droppableGatewayEvent("")).toBe(false);
  });

  test("background evidence excludes prompts, tool arguments, old results and assistant prose", () => {
    const marker = "IDLEQA-BGOUT-123456";
    const prompt = `Start a background task: sleep 20; echo ${marker}`;
    const messages = [
      {
        id: "prompt",
        role: "user",
        content: prompt,
        parts: [{ type: "tool-invocation", toolOutput: marker }],
      },
      { id: "old", role: "assistant", parts: [{ type: "tool-invocation", toolOutput: marker }] },
      {
        id: "call",
        role: "assistant",
        parts: [
          { type: "tool-invocation", toolArgs: { command: prompt }, content: prompt },
          { type: "text", content: marker },
        ],
      },
    ];
    const previous = new Set(["old"]);
    expect(
      freshToolResults(messages, previous).some((result) =>
        shellOutputContainsMarker(result.toolOutput, marker),
      ),
    ).toBe(false);
    const result = {
      id: "result",
      role: "assistant",
      parts: [
        {
          type: "task-group",
          task: { type: "tool-invocation", detailRef: "detail-1" },
          childTools: [{ type: "tool-invocation", toolOutput: `stdout:\n${marker}\r\n` }],
        },
      ],
    };
    expect(freshToolResults([result], previous)).toEqual([
      { detailRef: "detail-1" },
      { toolOutput: `stdout:\n${marker}\r\n` },
    ]);
    expect(
      freshToolResults([result], previous).some((entry) =>
        shellOutputContainsMarker(entry.toolOutput, marker),
      ),
    ).toBe(true);
    expect(shellOutputContainsMarker(`echo ${marker}`, marker)).toBe(false);
    expect(shellOutputContainsMarker(prompt, marker)).toBe(false);
  });

  test("only failed cases fail a provider", () => {
    expect(
      failedCases({
        hidden: { status: "passed", notes: [], timings: {} },
        subagents: { status: "not-exercised", notes: [], timings: {} },
        approval: {
          status: "failed",
          notes: [],
          timings: {},
          error: "no card",
        },
      }),
    ).toEqual(["approval: no card"]);
  });
});
