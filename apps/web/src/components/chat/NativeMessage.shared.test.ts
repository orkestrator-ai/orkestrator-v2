/**
 * The browser-side tool-detail cache is shared by every transcript row, so one
 * oversized image must not be able to clear it out.
 */
import { describe, expect, test } from "bun:test";
import { cacheToolDetails, cachedToolDetails, getAgentExpansionKey } from "./NativeMessage.shared";
import type { NativeAgentActivityPart } from "@/lib/chat/native-message-types";

test("background metadata arriving later preserves an existing durable agent expansion key", () => {
  const parts: NativeAgentActivityPart[] = [
    { type: "subagent", content: "Reviewer", subagentId: "agent-1" },
    {
      type: "task-group",
      content: "Tester",
      task: { type: "tool-invocation", content: "Agent", toolUseId: "tool-1" },
      childTools: [],
    },
  ];
  const backgroundTask = { id: "background-1", status: "running" as const };
  for (const part of parts) {
    const withSnapshot: NativeAgentActivityPart =
      part.type === "task-group"
        ? { ...part, task: { ...part.task, backgroundTask } }
        : { ...part, backgroundTask };
    expect(getAgentExpansionKey(withSnapshot, "new-row-part")).toBe(
      getAgentExpansionKey(part, "original-row-part"),
    );
  }
});

describe("tool detail browser cache", () => {
  test("does not retain one oversized detail at the expense of the rest", () => {
    const small = { detailRef: "shared-cache-small-ref", toolOutput: "small output" };
    cacheToolDetails(small);

    // Above the 8 MiB per-entry ceiling: two of these would fill the entire
    // 32 MiB budget and evict every small tool result.
    const oversized = "x".repeat(9 * 1024 * 1024);
    cacheToolDetails({ detailRef: "shared-cache-huge-1", fileDataUrl: oversized });
    cacheToolDetails({ detailRef: "shared-cache-huge-2", fileDataUrl: oversized });

    expect(cachedToolDetails(small.detailRef)).toEqual(small);
    expect(cachedToolDetails("shared-cache-huge-1")).toBeUndefined();
    expect(cachedToolDetails("shared-cache-huge-2")).toBeUndefined();
  });

  test.each(["quota", "missing"] as const)(
    "live details cannot enter the shared cache (%s)",
    (reason) => {
      const detailRef = `shared-cache-live-${reason}`;
      cacheToolDetails({ detailRef, fileDataUrl: "old" });
      cacheToolDetails({
        detailRef,
        fileDataUrl: "current",
        fileSnapshot: { status: "live", reason, capturedAt: "2026-10-29T10:00:00Z" },
      });
      expect(cachedToolDetails(detailRef)).toBeUndefined();
    },
  );

  test("retains a detail within the per-entry ceiling", () => {
    const detail = { detailRef: "shared-cache-within-limit", toolOutput: "kept" };
    cacheToolDetails(detail);
    expect(cachedToolDetails(detail.detailRef)).toEqual(detail);
  });
});
