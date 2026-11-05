import { describe, expect, test } from "bun:test";
import { boundedScreenshotPng, cropPng } from "../electron/browser-preview-capture-image";
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
      toPNG: () => {
        encodes.push(w * h);
        return Buffer.alloc(Math.ceil(w * h * bytesPerPixel));
      },
    }) as unknown as CaptureImageLike;
  return image(width, height);
}

describe("bounded screenshot encoding", () => {
  test("a screenshot within the limit is encoded once", () => {
    const encodes: number[] = [];
    boundedScreenshotPng(screenshot(1280, 800, 1, encodes));
    expect(encodes).toHaveLength(1);
  });

  // DK-5 names "up to 12 PNG encodes". That is the loop's cap: a screenshot whose
  // size follows its area fits on the first resize, however far over it starts.
  for (const bytesPerPixel of [2.2, 4, 8]) {
    test(`an oversized screenshot at ${bytesPerPixel} bytes a pixel settles in two encodes`, () => {
      const encodes: number[] = [];
      const png = boundedScreenshotPng(screenshot(2000, 2000, bytesPerPixel, encodes));
      expect(encodes).toHaveLength(2);
      expect(png.length).toBeLessThanOrEqual(MAX_BYTES);
    });
  }

  test("a frame that encodes to nothing is refused", () => {
    expect(() => boundedScreenshotPng(screenshot(10, 10, 0, []))).toThrow(
      "The browser frame did not return a PNG image",
    );
  });
});

describe("region crop encoding", () => {
  const rect = { x: 2, y: 3, width: 5, height: 7 };
  const api = (toPNG: () => Buffer) =>
    ({
      createFromBitmap: () => {
        throw new Error("unused");
      },
      createFromBuffer: () => ({
        getSize: () => ({ width: 20, height: 20 }),
        crop: ({ width, height }: { width: number; height: number }) => ({
          getSize: () => ({ width, height }),
          toPNG,
        }),
      }),
    }) as never;

  test("a crop returns the PNG's bytes and its size", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(
      cropPng(
        Buffer.alloc(1),
        rect,
        api(() => png),
      ),
    ).toEqual({ png, width: 5, height: 7 });
  });

  test("a crop that encodes to nothing, or an empty rectangle, has no crop", () => {
    const png = () => Buffer.alloc(0);
    expect(cropPng(Buffer.alloc(1), rect, api(png))).toBeNull();
    expect(
      cropPng(
        Buffer.alloc(1),
        { ...rect, width: 0 },
        api(() => Buffer.alloc(1)),
      ),
    ).toBeNull();
  });
});
