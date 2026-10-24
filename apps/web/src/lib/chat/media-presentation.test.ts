import { describe, expect, test } from "bun:test";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  checkLoadedImage,
  dataUrlByteLength,
  exceedsImageDecodeCeiling,
  imageDimensionsFromDataUrl,
  INLINE_MEDIA_PLAYBACK_MAX_BYTES,
  mediaLoadFailure,
} from "./media-presentation";

/** A PNG signature plus an IHDR declaring `width` × `height` (no pixel data needed). */
function pngHeaderDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

describe("media dimensions", () => {
  test("reads intrinsic PNG dimensions from the header", () => {
    expect(imageDimensionsFromDataUrl(pngHeaderDataUrl(640, 360))).toEqual({
      width: 640,
      height: 360,
    });
  });

  test("returns null for remote URLs, non-images and zero sizes", () => {
    expect(imageDimensionsFromDataUrl("https://example.com/a.png")).toBe(null);
    expect(imageDimensionsFromDataUrl(`data:text/plain;base64,${btoa("hello")}`)).toBe(null);
    expect(imageDimensionsFromDataUrl(pngHeaderDataUrl(0, 10))).toBe(null);
    expect(imageDimensionsFromDataUrl(undefined)).toBe(null);
  });

  test("applies the image decode ceiling from the policy", () => {
    const max = FRONTEND_RENDER_POLICY.imageDecodeMaxPixels;
    expect(exceedsImageDecodeCeiling(null)).toBe(false);
    expect(exceedsImageDecodeCeiling({ width: max, height: 1 })).toBe(false);
    expect(exceedsImageDecodeCeiling({ width: max, height: 2 })).toBe(true);
  });

  test("checkLoadedImage accepts images and refuses wrong types and oversized headers", () => {
    expect(checkLoadedImage(pngHeaderDataUrl(4, 3))).toEqual({
      ok: true,
      dimensions: { width: 4, height: 3 },
    });
    expect(checkLoadedImage("https://example.com/a.png")).toEqual({ ok: true, dimensions: null });
    expect(checkLoadedImage(`data:image/png;base64,${btoa("%PDF-1.7 body")}`)).toMatchObject({
      ok: false,
      reason: "type",
    });
    expect(checkLoadedImage(`data:text/plain;base64,${btoa("hello")}`)).toMatchObject({
      ok: false,
      reason: "type",
    });
    expect(checkLoadedImage(pngHeaderDataUrl(10_000, 5_000))).toMatchObject({
      ok: false,
      reason: "pixels",
    });
  });

  test("dataUrlByteLength counts decoded bytes", () => {
    expect(dataUrlByteLength(`data:video/mp4;base64,${btoa("abcd")}`)).toBe(4);
    expect(dataUrlByteLength("https://example.com/a.mp4")).toBe(null);
  });
});

describe("mediaLoadFailure", () => {
  test.each([
    [
      new Error("Invalid file path: file is outside Orkestrator workspace storage"),
      "outside-workspace",
    ],
    [new Error("Unsafe container media path"), "outside-workspace"],
    [
      new Error(
        JSON.stringify({
          code: "policy_denied",
          message: "The file is outside the environment's workspace",
        }),
      ),
      "outside-workspace",
    ],
    [new Error(JSON.stringify({ code: "policy_denied", message: "No" })), "denied"],
    [Object.assign(new Error("open failed"), { code: "EACCES" }), "denied"],
    [new Error("EPERM: operation not permitted, open '/x'"), "denied"],
    [new Error("File exceeds 10485760 bytes"), "too-large"],
    [new Error(JSON.stringify({ code: "capacity_exceeded", message: "Big" })), "too-large"],
    [new Error("ENOENT: no such file or directory, open '/x.png'"), "unavailable"],
    [new Error(JSON.stringify({ code: "not_found", message: "Gone" })), "unavailable"],
    [new Error("No readable local media path available"), "unavailable"],
    ["offline", "unavailable"],
  ])("%p → %s", (error, expected) => {
    expect(mediaLoadFailure(error)).toBe(expected as ReturnType<typeof mediaLoadFailure>);
  });

  test("the playback bound is the 8 MiB per-attachment limit", () => {
    expect(INLINE_MEDIA_PLAYBACK_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});
