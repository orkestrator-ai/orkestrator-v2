import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  encodeCanvasAsPngWithinSize,
  releaseCanvas,
  resizeCanvasIfNeeded,
  resizeCanvasToMaxDimension,
} from "../../../apps/web/src/lib/canvas-utils";

const originalCreateElement = document.createElement.bind(document);

afterEach(() => {
  document.createElement = originalCreateElement;
});

function canvas(width: number, height: number) {
  return { width, height } as HTMLCanvasElement;
}

describe("canvas utilities", () => {
  test("returns canvases that are already within limits unchanged", () => {
    const source = canvas(100, 50);
    expect(resizeCanvasIfNeeded(source, 100 * 50 * 4)).toBe(source);
    expect(resizeCanvasToMaxDimension(source, 100)).toBe(source);
  });

  test("resizes by RGBA size and releases the source canvas", () => {
    const drawImage = mock(() => undefined);
    const target = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
    document.createElement = mock(() => target) as typeof document.createElement;
    const source = canvas(400, 200);

    expect(resizeCanvasIfNeeded(source, 40_000)).toBe(target);
    expect([target.width, target.height]).toEqual([141, 70]);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 141, 70);
    expect([source.width, source.height]).toEqual([0, 0]);
  });

  test("resizes the longest dimension while preserving aspect ratio", () => {
    const drawImage = mock(() => undefined);
    const target = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
    document.createElement = mock(() => target) as typeof document.createElement;
    const source = canvas(4000, 1000);

    resizeCanvasToMaxDimension(source, 2000);
    expect([target.width, target.height]).toEqual([2000, 500]);
    expect([source.width, source.height]).toEqual([0, 0]);
  });

  test("keeps the source when a resize context is unavailable and can release explicitly", () => {
    const target = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    document.createElement = mock(() => target) as typeof document.createElement;
    const source = canvas(3000, 1000);
    expect(resizeCanvasToMaxDimension(source, 2000)).toBe(source);
    releaseCanvas(source);
    expect([source.width, source.height]).toEqual([0, 0]);
  });

  test("downscales an encoded PNG until it fits the attachment size", () => {
    const drawImage = mock(() => undefined);
    const source = {
      width: 2000,
      height: 1000,
      toDataURL: () => `data:image/png;base64,${"A".repeat(1200)}`,
    } as HTMLCanvasElement;
    const target = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: () => "data:image/png;base64,QUJD",
    } as unknown as HTMLCanvasElement;
    document.createElement = mock(() => target) as typeof document.createElement;

    const encoded = encodeCanvasAsPngWithinSize(source, 600);

    expect(encoded).toMatchObject({
      canvas: target,
      dataUrl: "data:image/png;base64,QUJD",
      base64Data: "QUJD",
    });
    expect(target.width).toBeLessThan(2000);
    expect(target.height).toBeLessThan(1000);
    expect(drawImage).toHaveBeenCalled();
  });
});
