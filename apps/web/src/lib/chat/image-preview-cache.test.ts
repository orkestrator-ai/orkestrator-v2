import { afterEach, describe, expect, test } from "bun:test";
import {
  clearImagePreviewCache,
  imagePreviewCacheKey,
  readImagePreviewCache,
  writeImagePreviewCache,
} from "./image-preview-cache";

describe("image preview cache", () => {
  afterEach(() => {
    clearImagePreviewCache();
  });

  test("separates the same path by container and by URL spelling", () => {
    const local = imagePreviewCacheKey(undefined, "/w/a.png", undefined);
    const inContainer = imagePreviewCacheKey("container-1", "/w/a.png", undefined);
    const otherContainer = imagePreviewCacheKey("container-2", "/w/a.png", undefined);
    const withUrl = imagePreviewCacheKey(undefined, "/w/a.png", "file:///w/a.png");

    expect(new Set([local, inContainer, otherContainer, withUrl]).size).toBe(4);

    writeImagePreviewCache(inContainer, "data:image/png;base64,one");
    expect(readImagePreviewCache(inContainer)).toBe("data:image/png;base64,one");
    // A different container serving the same path must not read the first
    // container's bytes.
    expect(readImagePreviewCache(otherContainer)).toBeNull();
  });

  test("returns null for a key that was never written", () => {
    expect(readImagePreviewCache(imagePreviewCacheKey(undefined, "/w/missing.png", undefined)))
      .toBeNull();
  });

  test("evicts the least recently used entry beyond the count bound", () => {
    const keys = Array.from({ length: 33 }, (_, index) =>
      imagePreviewCacheKey(undefined, `/w/${index}.png`, undefined));
    for (const key of keys.slice(0, 32)) {
      writeImagePreviewCache(key, "data:image/png;base64,x");
    }

    // Reading the oldest key promotes it, so the next-oldest is evicted first.
    expect(readImagePreviewCache(keys[0]!)).toBe("data:image/png;base64,x");
    writeImagePreviewCache(keys[32]!, "data:image/png;base64,x");

    expect(readImagePreviewCache(keys[0]!)).toBe("data:image/png;base64,x");
    expect(readImagePreviewCache(keys[1]!)).toBeNull();
    expect(readImagePreviewCache(keys[32]!)).toBe("data:image/png;base64,x");
  });

  test("evicts on the total size bound before the count bound is reached", () => {
    const big = "d".repeat(7 * 1024 * 1024);
    const keys = Array.from({ length: 4 }, (_, index) =>
      imagePreviewCacheKey(undefined, `/w/big-${index}.png`, undefined));
    for (const key of keys) {
      writeImagePreviewCache(key, big);
    }

    // Four 7 MB previews exceed the 24 MB budget at only four of 32 entries.
    expect(readImagePreviewCache(keys[0]!)).toBeNull();
    expect(readImagePreviewCache(keys[3]!)).toBe(big);
  });

  test("refuses to retain a single preview larger than the entry bound", () => {
    const key = imagePreviewCacheKey(undefined, "/w/huge.png", undefined);
    const neighbour = imagePreviewCacheKey(undefined, "/w/small.png", undefined);
    writeImagePreviewCache(neighbour, "data:image/png;base64,small");

    writeImagePreviewCache(key, "d".repeat(8 * 1024 * 1024 + 1));

    // Caching it would have evicted everything else to hold one image.
    expect(readImagePreviewCache(key)).toBeNull();
    expect(readImagePreviewCache(neighbour)).toBe("data:image/png;base64,small");
  });

  test("does not double-count a key that is written twice", () => {
    const key = imagePreviewCacheKey(undefined, "/w/rewritten.png", undefined);
    const filler = imagePreviewCacheKey(undefined, "/w/filler.png", undefined);
    const big = "d".repeat(7 * 1024 * 1024);

    writeImagePreviewCache(filler, "data:image/png;base64,filler");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      writeImagePreviewCache(key, big);
    }

    expect(readImagePreviewCache(key)).toBe(big);
    expect(readImagePreviewCache(filler)).toBe("data:image/png;base64,filler");
  });
});
