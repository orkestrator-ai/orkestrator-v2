import { describe, expect, test } from "bun:test";
import { boundedScreenshotDataUrl } from "../electron/browser-preview-capture-image";
import type { CaptureImageLike } from "../electron/browser-preview-capture-page";

const MAX_BYTES = 8 * 1024 * 1024;

/** A PNG whose size follows its area, as an incompressible screenshot's does. */
function screenshot(width: number, height: number, bytesPerPixel: number, encodes: number[]) {
  const image = (w: number, h: number): CaptureImageLike =>
    ({
      getSize: () => ({ width: w, height: h }),
      getScaleFactors: () => [1],
      resize: ({ width: next, height: tall }: { width: number; height: number }) =>
        image(next, tall),
      toDataURL: () => {
        encodes.push(w * h);
        const bytes = Math.ceil(w * h * bytesPerPixel);
        return `data:image/png;base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`;
      },
    }) as unknown as CaptureImageLike;
  return image(width, height);
}

describe("bounded screenshot encoding", () => {
  test("a screenshot within the limit is encoded once", () => {
    const encodes: number[] = [];
    boundedScreenshotDataUrl(screenshot(1280, 800, 1, encodes));
    expect(encodes).toHaveLength(1);
  });

  // DK-5 names "up to 12 PNG encodes". That is the loop's cap: a screenshot whose
  // size follows its area fits on the first resize, however far over it starts.
  for (const bytesPerPixel of [2.2, 4, 8]) {
    test(`an oversized screenshot at ${bytesPerPixel} bytes a pixel settles in two encodes`, () => {
      const encodes: number[] = [];
      const dataUrl = boundedScreenshotDataUrl(screenshot(2000, 2000, bytesPerPixel, encodes));
      expect(encodes).toHaveLength(2);
      const base64 = dataUrl.slice("data:image/png;base64,".length);
      expect((base64.length / 4) * 3).toBeLessThanOrEqual(MAX_BYTES);
    });
  }
});
