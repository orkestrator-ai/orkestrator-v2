import { describe, expect, test } from "bun:test";
import { estimateOrderedEventBytes, mergeRateLimitWindows, messageSnapshotIntervalMs, normalizedMessageSnapshotChars } from "./app-server-runtime.js";
import type { EngineRateLimitWindow, EngineRateLimitWindowUpdate } from "./engine/types.js";


test("large message snapshots use a progressively lower streaming cadence", () => {
  expect(messageSnapshotIntervalMs(255 * 1024)).toBe(100);
  expect(messageSnapshotIntervalMs(256 * 1024)).toBe(250);
  expect(messageSnapshotIntervalMs(1024 * 1024)).toBe(500);
});



test("snapshot sizing includes nested tool, reasoning, diff and subagent content", () => {
  const message = {
    id: "large-parts",
    role: "assistant" as const,
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const reasoningChars = normalizedMessageSnapshotChars({
    ...message,
    parts: [{ type: "thinking" as const, content: "r".repeat(300 * 1024) }],
  });
  const toolChars = normalizedMessageSnapshotChars({
    ...message,
    parts: [{
      type: "tool-result" as const,
      content: "",
      toolOutput: "o".repeat(300 * 1024),
    }],
  });
  const nestedChars = normalizedMessageSnapshotChars({
    ...message,
    parts: [
      {
        type: "tool-invocation" as const,
        content: "apply",
        toolArgs: { nested: { prompt: "a".repeat(96 * 1024) } },
        toolDiff: { diff: "d".repeat(96 * 1024) },
      },
      {
        type: "subagent" as const,
        content: "worker",
        subagentPrompt: "p".repeat(48 * 1024),
        subagentActions: [{
          type: "tool-result" as const,
          content: "",
          toolOutput: "o".repeat(48 * 1024),
        }],
      },
    ],
  });

  expect(messageSnapshotIntervalMs(reasoningChars)).toBe(250);
  expect(messageSnapshotIntervalMs(toolChars)).toBe(250);
  expect(messageSnapshotIntervalMs(nestedChars)).toBe(250);
});



test("snapshot sizing is bounded and tolerates cyclic metadata", () => {
  const cyclicMessage: Record<string, unknown> = {
    id: "cyclic",
    role: "assistant",
    content: "visible",
    parts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  cyclicMessage.self = cyclicMessage;

  expect(
    normalizedMessageSnapshotChars(
      cyclicMessage as unknown as Parameters<typeof normalizedMessageSnapshotChars>[0],
    ),
  ).toBeGreaterThan(0);
  expect(normalizedMessageSnapshotChars({
    id: "bounded",
    role: "assistant",
    content: "x".repeat(2 * 1024 * 1024),
    parts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  })).toBe(1024 * 1024);
});



describe("mergeRateLimitWindows", () => {
  const primary: EngineRateLimitWindow = {
    slot: "primary",
    label: "Five hour",
    usedPercent: 60,
    resetsAt: "2026-07-30T20:00:00.000Z",
    windowMinutes: 300,
  };

  test("returns the retained snapshot unchanged for an empty update", () => {
    const retained = [primary];

    expect(mergeRateLimitWindows(retained, [])).toBe(retained);
  });

  test("adds a new slot and restores stable primary-first ordering", () => {
    const secondary: EngineRateLimitWindow = {
      slot: "secondary",
      label: "Weekly",
      usedPercent: 20,
    };

    expect(mergeRateLimitWindows([secondary], [primary])).toEqual([
      primary,
      secondary,
    ]);
  });

  test("preserves omitted fields while updating the fields that are present", () => {
    const sparseUpdate: EngineRateLimitWindowUpdate = {
      slot: "primary",
      usedPercent: 65,
    };

    expect(mergeRateLimitWindows([primary], [sparseUpdate])).toEqual([{
      ...primary,
      usedPercent: 65,
    }]);
  });

  test("uses a slot fallback only until an explicit provider label is observed", () => {
    const unlabeled: EngineRateLimitWindowUpdate = {
      slot: "primary",
      usedPercent: 10,
    };
    const initial = mergeRateLimitWindows([], [unlabeled]);
    expect(initial).toEqual([{
      slot: "primary",
      label: "Primary",
      usedPercent: 10,
    }]);

    expect(mergeRateLimitWindows([primary], [unlabeled])).toEqual([{
      ...primary,
      usedPercent: 10,
    }]);

    expect(mergeRateLimitWindows([primary], [{
      slot: "primary",
      label: "New plan name",
    }])).toEqual([{
      ...primary,
      label: "New plan name",
    }]);
  });
});



describe("estimateOrderedEventBytes", () => {
  test("charges strings by their UTF-16 storage and scalars a flat node cost", () => {
    expect(estimateOrderedEventBytes("")).toBe(2);
    expect(estimateOrderedEventBytes("abcd")).toBe(10);
    expect(estimateOrderedEventBytes(42)).toBe(16);
    expect(estimateOrderedEventBytes(null)).toBe(16);
    expect(estimateOrderedEventBytes(undefined)).toBe(16);
    expect(estimateOrderedEventBytes(true)).toBe(16);
  });

  test("charges keys as well as values so a wide object is not free", () => {
    const wide = estimateOrderedEventBytes({ aa: 1, bb: 2 });
    const narrow = estimateOrderedEventBytes({ a: 1, b: 2 });
    expect(wide).toBeGreaterThan(narrow);
    expect(estimateOrderedEventBytes([1, 2, 3]))
      .toBeGreaterThan(estimateOrderedEventBytes([1]));
  });

  /**
   * The walk is bounded so a pathological structure cannot make the *estimate*
   * the expensive part of a bounded queue. It is a heuristic, so undercounting
   * past the cap is deliberate.
   */
  test("stops descending at the depth cap instead of walking forever", () => {
    let deep: unknown = "leaf".repeat(64);
    for (let index = 0; index < 40; index += 1) deep = { next: deep };
    const start = performance.now();
    const estimate = estimateOrderedEventBytes(deep);
    expect(performance.now() - start).toBeLessThan(50);
    // Nine nested nodes plus their keys, and nothing for the truncated tail.
    expect(estimate).toBeLessThan(400);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateOrderedEventBytes(cyclic)).toBeLessThan(400);
  });
});
