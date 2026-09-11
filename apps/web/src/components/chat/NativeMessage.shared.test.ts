/**
 * The browser-side tool-detail cache is shared by every transcript row, so one
 * oversized image must not be able to clear it out.
 */
import { describe, expect, test } from "bun:test";
import { cacheToolDetails, cachedToolDetails } from "./NativeMessage.shared";

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

  test("retains a detail within the per-entry ceiling", () => {
    const detail = { detailRef: "shared-cache-within-limit", toolOutput: "kept" };
    cacheToolDetails(detail);
    expect(cachedToolDetails(detail.detailRef)).toEqual(detail);
  });
});
