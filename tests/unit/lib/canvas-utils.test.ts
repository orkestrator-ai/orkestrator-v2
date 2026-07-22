import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  encodeCanvasAsPngWithinSize,
  releaseCanvas,
  resizeCanvasIfNeeded,
  resizeCanvasToMaxDimension,
} from "../../../apps/web/src/lib/canvas-utils";

const originalCreateElement = document.createElement.bind(document);
const originalConsoleError = console.error.bind(console);

afterEach(() => {
  document.createElement = originalCreateElement;
  console.error = originalConsoleError;
});

function canvas(width: number, height: number) {
  return { width, height } as HTMLCanvasElement;
}

function pngDataUrl(decodedSize: number): string {
  return `data:image/png;base64,${Buffer.alloc(decodedSize).toString("base64")}`;
}

function encodedCanvas(width: number, height: number, dataUrl: string) {
  return {
    width,
    height,
    toDataURL: mock(() => dataUrl),
  } as unknown as HTMLCanvasElement;
}

function resizableCanvas(dataUrl: string) {
  const drawImage = mock(() => undefined);
  return {
    canvas: {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: mock(() => dataUrl),
    } as unknown as HTMLCanvasElement,
    drawImage,
  };
}

function installCanvasFactory(canvases: HTMLCanvasElement[]) {
  let index = 0;
  const createElement = mock(() => canvases[index++]);
  document.createElement = createElement as typeof document.createElement;
  return createElement;
}

describe("canvas utilities", () => {
  test("returns canvases that are already within limits unchanged", () => {
    const source = canvas(100, 50);
    expect(resizeCanvasIfNeeded(source, 100 * 50 * 4)).toBe(source);
    expect(resizeCanvasToMaxDimension(source, 100)).toBe(source);
  });

  test("resizes by RGBA size and releases the source canvas", () => {
    const drawImage = mock(() => undefined);
    const target = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
    } as unknown as HTMLCanvasElement;
    installCanvasFactory([target]);
    const source = canvas(400, 200);

    expect(resizeCanvasIfNeeded(source, 40_000)).toBe(target);
    expect([target.width, target.height]).toEqual([141, 70]);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 141, 70);
    expect([source.width, source.height]).toEqual([0, 0]);
  });

  test("keeps the source when the RGBA resize context is unavailable", () => {
    console.error = mock(() => undefined);
    const target = {
      width: 0,
      height: 0,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    installCanvasFactory([target]);
    const source = canvas(400, 200);

    expect(resizeCanvasIfNeeded(source, 40_000)).toBe(source);
    expect([source.width, source.height]).toEqual([400, 200]);
    expect([target.width, target.height]).toEqual([0, 0]);
  });

  test("resizes wide and tall canvases without creating a zero-sized edge", () => {
    const wide = resizableCanvas(pngDataUrl(1));
    const tall = resizableCanvas(pngDataUrl(1));
    installCanvasFactory([wide.canvas, tall.canvas]);
    const wideSource = canvas(4000, 1);
    const tallSource = canvas(1, 4000);

    expect(resizeCanvasToMaxDimension(wideSource, 2000)).toBe(wide.canvas);
    expect([wide.canvas.width, wide.canvas.height]).toEqual([2000, 1]);
    expect(wide.drawImage).toHaveBeenCalledWith(wideSource, 0, 0, 2000, 1);

    expect(resizeCanvasToMaxDimension(tallSource, 2000)).toBe(tall.canvas);
    expect([tall.canvas.width, tall.canvas.height]).toEqual([1, 2000]);
    expect(tall.drawImage).toHaveBeenCalledWith(tallSource, 0, 0, 1, 2000);
  });

  test("clamps RGBA resize dimensions to at least one pixel", () => {
    const target = resizableCanvas(pngDataUrl(1));
    installCanvasFactory([target.canvas]);
    const source = canvas(4000, 1);

    expect(resizeCanvasIfNeeded(source, 4000)).toBe(target.canvas);
    expect([target.canvas.width, target.canvas.height]).toEqual([2000, 1]);
    expect(target.drawImage).toHaveBeenCalledWith(source, 0, 0, 2000, 1);
  });

  test("keeps the source when the dimension resize context is unavailable", () => {
    console.error = mock(() => undefined);
    const target = {
      width: 0,
      height: 0,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    installCanvasFactory([target]);
    const source = canvas(3000, 1000);

    expect(resizeCanvasToMaxDimension(source, 2000)).toBe(source);
    expect([source.width, source.height]).toEqual([3000, 1000]);
    expect([target.width, target.height]).toEqual([0, 0]);
  });

  test("releases a canvas explicitly", () => {
    const source = canvas(3000, 1000);
    releaseCanvas(source);
    expect([source.width, source.height]).toEqual([0, 0]);
  });

  test("returns an encoded PNG that already fits without resizing", () => {
    const dataUrl = pngDataUrl(8);
    const source = encodedCanvas(200, 100, dataUrl);
    const createElement = installCanvasFactory([]);

    expect(encodeCanvasAsPngWithinSize(source, 8)).toEqual({
      canvas: source,
      dataUrl,
      base64Data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    });
    expect(createElement).not.toHaveBeenCalled();
    expect([source.width, source.height]).toEqual([200, 100]);
  });

  test("uses decoded byte size at max-minus-one, max, and max-plus-one boundaries", () => {
    const belowDataUrl = pngDataUrl(7);
    const exactDataUrl = pngDataUrl(8);
    const aboveDataUrl = pngDataUrl(9);
    const below = encodedCanvas(1, 1, belowDataUrl);
    const exact = encodedCanvas(1, 1, exactDataUrl);
    const above = encodedCanvas(1, 1, aboveDataUrl);

    expect(encodeCanvasAsPngWithinSize(below, 8)?.base64Data).toBe(
      belowDataUrl.slice(belowDataUrl.indexOf(",") + 1),
    );
    expect(encodeCanvasAsPngWithinSize(exact, 8)?.base64Data).toBe(
      exactDataUrl.slice(exactDataUrl.indexOf(",") + 1),
    );
    expect(encodeCanvasAsPngWithinSize(above, 8)).toBeNull();
    expect([above.width, above.height]).toEqual([0, 0]);
  });

  test.each([
    ["a data URL without a comma", "data:image/png;base64"],
    ["an empty data URL payload", "data:image/png;base64,"],
    ["padding before the payload suffix", "data:image/png;base64,QU=JD="],
    ["an incomplete base64 quantum", "data:image/png;base64,QQ="],
  ])("rejects and releases %s", (_description, dataUrl) => {
    const source = encodedCanvas(100, 50, dataUrl);
    expect(encodeCanvasAsPngWithinSize(source, 100)).toBeNull();
    expect([source.width, source.height]).toEqual([0, 0]);
  });

  test("continues after a non-decreasing PNG size when a later resize fits", () => {
    const source = encodedCanvas(1000, 500, pngDataUrl(12));
    const first = resizableCanvas(pngDataUrl(13));
    const second = resizableCanvas(pngDataUrl(8));
    const createElement = installCanvasFactory([first.canvas, second.canvas]);

    const encoded = encodeCanvasAsPngWithinSize(source, 8);

    expect(encoded?.canvas).toBe(second.canvas);
    expect(encoded?.base64Data).toBe(
      pngDataUrl(8).slice(pngDataUrl(8).indexOf(",") + 1),
    );
    expect(createElement).toHaveBeenCalledTimes(2);
    expect([source.width, source.height]).toEqual([0, 0]);
    expect([first.canvas.width, first.canvas.height]).toEqual([0, 0]);
    expect(second.canvas.width).toBeGreaterThan(0);
    expect(second.canvas.height).toBeGreaterThan(0);
  });

  test("releases both canvases when an encode-triggered resize has no context", () => {
    console.error = mock(() => undefined);
    const source = encodedCanvas(1000, 500, pngDataUrl(12));
    const target = {
      width: 0,
      height: 0,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    installCanvasFactory([target]);

    expect(encodeCanvasAsPngWithinSize(source, 8)).toBeNull();
    expect([source.width, source.height]).toEqual([0, 0]);
    expect([target.width, target.height]).toEqual([0, 0]);
  });

  test("returns a fitting final candidate on the sixth encoding attempt", () => {
    const source = encodedCanvas(10_000, 5000, pngDataUrl(12));
    const targets = Array.from({ length: 5 }, (_, index) =>
      resizableCanvas(pngDataUrl(index === 4 ? 8 : 12)),
    );
    const createElement = installCanvasFactory(targets.map(({ canvas }) => canvas));

    const encoded = encodeCanvasAsPngWithinSize(source, 8);

    expect(encoded?.canvas).toBe(targets[4]?.canvas);
    expect(createElement).toHaveBeenCalledTimes(5);
    expect(targets[4]?.canvas.width).toBeGreaterThan(0);
    expect(targets[4]?.canvas.height).toBeGreaterThan(0);
  });

  test("stops after six oversized encodings and releases every canvas", () => {
    const source = encodedCanvas(10_000, 5000, pngDataUrl(12));
    const targets = Array.from({ length: 5 }, () =>
      resizableCanvas(pngDataUrl(12)),
    );
    const createElement = installCanvasFactory(targets.map(({ canvas }) => canvas));

    expect(encodeCanvasAsPngWithinSize(source, 8)).toBeNull();
    expect(createElement).toHaveBeenCalledTimes(5);
    expect(source.toDataURL).toHaveBeenCalledTimes(1);
    for (const target of targets) {
      expect(target.canvas.toDataURL).toHaveBeenCalledTimes(1);
      expect([target.canvas.width, target.canvas.height]).toEqual([0, 0]);
    }
    expect([source.width, source.height]).toEqual([0, 0]);
  });
});
