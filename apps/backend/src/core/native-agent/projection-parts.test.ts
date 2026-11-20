import { describe, expect, test } from "bun:test";
import type { NativeAgentProjectionContext, ToolDetailCacheEntry } from "./projection-context.js";
import { NativeAgentProjectionParts } from "./projection-parts.js";

/** The parts owner reads only the host clock, the storage and the options at construction. */
function createParts(options: NativeAgentProjectionContext["options"] = {}) {
  const context = {
    host: { now: () => Date.now(), options },
    storage: {},
    options,
    catalogs: {},
  } as unknown as NativeAgentProjectionContext;
  return new NativeAgentProjectionParts(context);
}

function entry(sessionKey: string, bytes: number, toolOutput = "out"): ToolDetailCacheEntry {
  return { sessionKey, details: { detailRef: "ref", toolOutput }, bytes };
}

/** Seed one detail the way a projection does, charging its bytes. */
function seed(parts: NativeAgentProjectionParts, ref: string, value: ToolDetailCacheEntry): void {
  const internal = parts as unknown as {
    toolDetailCache: Map<string, ToolDetailCacheEntry>;
    toolDetailCacheBytes: number;
  };
  internal.toolDetailCache.set(ref, value);
  internal.toolDetailCacheBytes += value.bytes;
}

describe("NativeAgentProjectionParts", () => {
  test("a dropped detail is removed and un-counted only while it is still the cached entry", () => {
    const parts = createParts();
    const first = entry("s1", 100);
    seed(parts, "ref", first);
    expect(parts.cacheGauges().toolDetailBytes).toBe(100);

    parts.dropToolDetail("ref", entry("s1", 100));
    expect(parts.toolDetail("ref")).toBe(first);
    expect(parts.cacheGauges().toolDetailBytes).toBe(100);

    parts.dropToolDetail("ref", first);
    expect(parts.toolDetail("ref")).toBeUndefined();
    expect(parts.cacheGauges().toolDetailBytes).toBe(0);
  });

  test("a resolved body replaces the entry read and moves the charge by the difference", () => {
    const parts = createParts();
    const read = entry("s1", 100);
    seed(parts, "ref", read);
    const resolved = entry("s1", 250, "resolved");

    parts.replaceToolDetail("ref", read, resolved);
    expect(parts.toolDetail("ref")).toBe(resolved);
    expect(parts.cacheGauges().toolDetailBytes).toBe(250);

    // A stale read (the cache moved on) leaves the newer entry alone.
    parts.replaceToolDetail("ref", read, entry("s1", 999, "stale"));
    expect(parts.toolDetail("ref")).toBe(resolved);
    expect(parts.cacheGauges().toolDetailBytes).toBe(250);
  });

  test("touching a detail makes it the most recently used", () => {
    const parts = createParts();
    const older = entry("s1", 10);
    seed(parts, "a", older);
    seed(parts, "b", entry("s1", 10));
    parts.touchToolDetail("a", older);
    expect(Array.from(parts.forTesting().toolDetailCache.keys())).toEqual(["b", "a"]);
  });

  test("a pin is counted until released", () => {
    const parts = createParts();
    parts.pinToolDetail("ref");
    expect(parts.cacheGauges().pinnedToolDetails).toBe(1);
    parts.unpinToolDetail("ref");
    expect(parts.cacheGauges().pinnedToolDetails).toBe(0);
  });

  test("projected rows register their details, and a forgotten session's rows are dropped", () => {
    const parts = createParts();
    const rows = [
      {
        id: "m1",
        role: "assistant",
        content: "done",
        parts: [
          {
            type: "tool-invocation",
            toolName: "bash",
            toolState: "success",
            toolArgs: { command: "echo hi" },
            toolOutput: `output ${"x".repeat(300)}`,
          },
        ],
        createdAt: "2026-11-17T00:00:00.000Z",
      },
    ];
    const projected = parts.projectionMessages("s1", rows, 10);
    const detailRef = (projected.messages[0] as { parts: Array<{ detailRef?: string }> }).parts[0]!
      .detailRef!;
    expect(parts.toolDetail(detailRef)?.sessionKey).toBe("s1");
    expect(parts.cacheGauges().projectedMessages).toBe(1);

    parts.forgetSession("s1");
    expect(parts.cacheGauges().projectedMessages).toBe(0);

    parts.clearToolDetails();
    expect(parts.toolDetail(detailRef)).toBeUndefined();
    expect(parts.cacheGauges().toolDetailBytes).toBe(0);
  });

  test("the progressive shutdown clear empties rows, pages and cursor handles but keeps tool details", () => {
    const parts = createParts();
    seed(parts, "ref", entry("s1", 40));
    parts.projectionMessages(
      "s1",
      [
        {
          id: "m1",
          role: "assistant",
          content: "hi",
          parts: [{ type: "text", content: "hi" }],
          createdAt: "2026-11-17T00:00:00.000Z",
        },
      ],
      10,
    );
    parts.clearRowsAndPages();
    const gauges = parts.cacheGauges();
    expect(gauges.projectedMessages).toBe(0);
    expect(gauges.directHistoryPages).toBe(0);
    expect(gauges.directHistoryCursorHandles).toBe(0);
    expect(gauges.toolDetailBytes).toBe(40);
  });
});
