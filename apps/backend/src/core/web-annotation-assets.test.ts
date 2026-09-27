import { describe, expect, test } from "bun:test";
import { WEB_ANNOTATION_CAPACITY } from "@orkestrator/protocol/web-annotations";
import { fixtureAnnotation, fixtureRequest } from "@orkestrator/protocol/web-annotations-fixtures";
import {
  decodeBase64Png,
  liveAnnotationCount,
  maxBase64Chars,
  planAssetCollection,
  reachableAssetIds,
  retainedRequestCount,
  validatePngBytes,
} from "./web-annotation-assets.js";
import { emptyManifest } from "./web-annotation-storage.js";
import { makePng } from "./web-annotation-test-support.js";

describe("web annotation PNG validation", () => {
  test("accepts a valid PNG and reports dimensions and digest", () => {
    const png = makePng(5, 7);
    const result = decodeBase64Png(png.toString("base64"));
    expect(result.width).toBe(5);
    expect(result.height).toBe(7);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bytes.equals(png)).toBe(true);
  });

  test("rejects non-PNG, corrupt, truncated, and trailing data", () => {
    expect(() => validatePngBytes(Buffer.from("GIF89a".padEnd(64, "x")))).toThrow("not a PNG");
    const png = makePng();
    const corrupt = Buffer.from(png);
    corrupt[20] = corrupt[20]! ^ 0xff;
    expect(() => validatePngBytes(corrupt)).toThrow("checksum");
    expect(() => validatePngBytes(png.subarray(0, png.byteLength - 6))).toThrow();
    expect(() => validatePngBytes(Buffer.concat([png, Buffer.from([1, 2, 3])]))).toThrow(
      "trailing",
    );
  });

  test("rejects oversized dimensions and bytes with capacity errors", () => {
    expect(() => validatePngBytes(makePng(2_001, 1))).toThrow(WEB_ANNOTATION_CAPACITY);
    expect(() => validatePngBytes(makePng(10, 10), { maxBytes: 20 })).toThrow(
      WEB_ANNOTATION_CAPACITY,
    );
  });

  test("bounds base64 before decoding and rejects malformed base64", () => {
    const tooLong = "A".repeat(maxBase64Chars(100) + 4);
    expect(() => decodeBase64Png(tooLong, { maxBytes: 100 })).toThrow(WEB_ANNOTATION_CAPACITY);
    expect(() => decodeBase64Png("not base64!")).toThrow("base64");
    expect(() => decodeBase64Png("")).toThrow();
    expect(() => decodeBase64Png(42)).toThrow();
  });
});

describe("web annotation asset collection policy", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;

  function manifestWithAssets() {
    const manifest = emptyManifest("env-a", new Date(now).toISOString());
    const asset = (id: string, orphanedAt: string | null) => ({
      id,
      digest: id.padEnd(64, "0"),
      bytes: 10,
      width: 1,
      height: 1,
      createdAt: new Date(now - 2 * day).toISOString(),
      orphanedAt,
    });
    manifest.assets = {
      referenced: asset("referenced", new Date(now - 2 * day).toISOString()),
      fresh: asset("fresh", null),
      young: asset("young", new Date(now - day + 1_000).toISOString()),
      old: asset("old", new Date(now - day - 1).toISOString()),
      pending: asset("pending", new Date(now - 2 * day).toISOString()),
    };
    manifest.captures = {
      c1: {
        id: "c1",
        annotationId: "a1",
        revision: 1,
        producer: "desktop-native",
        state: "complete",
        assetIds: ["referenced"],
        createdAt: new Date(now).toISOString(),
        bytes: 1,
      },
    };
    return manifest;
  }

  test("marks, unmarks, and removes only unreachable assets past the grace period", () => {
    const manifest = manifestWithAssets();
    const plan = planAssetCollection(manifest, now, { pending: ["pending"] });
    expect(plan.unmark.sort()).toEqual(["pending", "referenced"]);
    expect(plan.markOrphaned).toEqual(["fresh"]);
    expect(plan.remove).toEqual(["old"]);
  });

  test("reachability covers captures, results, requests, thumbnails, and pending work", () => {
    const manifest = manifestWithAssets();
    manifest.results.r1 = {
      id: "r1",
      requestId: "q1",
      revision: 1,
      provenance: "user-capture",
      provisional: false,
      assetIds: ["young"],
      captureIds: [],
      supersedes: null,
      createdAt: "",
      bytes: 1,
    };
    const reachable = reachableAssetIds(manifest, ["pending"]);
    expect(reachable.has("referenced")).toBe(true);
    expect(reachable.has("young")).toBe(true);
    expect(reachable.has("pending")).toBe(true);
    expect(reachable.has("old")).toBe(false);
  });

  test("a deleted annotation's own capture and thumbnail stop holding images", () => {
    const manifest = manifestWithAssets();
    manifest.annotations.a1 = fixtureAnnotation({
      id: "a1",
      state: "deleted",
      thumbnailAssetId: "fresh",
    });
    manifest.captures.c2 = {
      ...manifest.captures.c1!,
      id: "c2",
      assetIds: ["young"],
      resultOf: { requestId: "q1" },
    };
    const reachable = reachableAssetIds(manifest);
    expect(reachable.has("referenced")).toBe(false);
    expect(reachable.has("fresh")).toBe(false);
    // Result evidence belongs to the request and outlives the note.
    expect(reachable.has("young")).toBe(true);
  });

  test("removal is batched", () => {
    const manifest = emptyManifest("env-a", new Date(now).toISOString());
    for (let index = 0; index < 30; index++) {
      manifest.assets[`a${index}`] = {
        id: `a${index}`,
        digest: String(index).padEnd(64, "0"),
        bytes: 1,
        width: 1,
        height: 1,
        createdAt: "",
        orphanedAt: new Date(now - 2 * day).toISOString(),
      };
    }
    expect(planAssetCollection(manifest, now, { batch: 20 }).remove).toHaveLength(20);
  });
});

describe("web annotation capacity accounting", () => {
  test("tombstones do not count against the annotation limit", () => {
    const manifest = emptyManifest("env-a", "2026-09-24T12:00:00.000Z");
    manifest.annotations.a1 = fixtureAnnotation({ id: "a1" });
    manifest.annotations.a2 = fixtureAnnotation({ id: "a2", state: "resolved" });
    manifest.annotations.a3 = fixtureAnnotation({ id: "a3", state: "deleted" });
    expect(liveAnnotationCount(manifest)).toBe(2);
  });

  test("settled requests of deleted annotations do not count against the request limit", () => {
    const manifest = emptyManifest("env-a", "2026-09-24T12:00:00.000Z");
    manifest.annotations["annotation-1"] = fixtureAnnotation({ state: "deleted" });
    manifest.requests.done = fixtureRequest("completed", { id: "done" });
    manifest.requests.running = fixtureRequest("running", { id: "running" });
    expect(retainedRequestCount(manifest)).toBe(1);
    manifest.annotations["annotation-1"] = fixtureAnnotation({ state: "open" });
    expect(retainedRequestCount(manifest)).toBe(2);
  });
});
