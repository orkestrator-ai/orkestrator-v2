import { afterEach, expect, mock, test } from "bun:test";
import { pngExportSize, rasterizeSvgToPng, standaloneSvg } from "./svg-export";
import { PREVIEW_CAPTURE_POLICY } from "@orkestrator/protocol/rich-content-policy";
const OriginalImage = globalThis.Image;
const create = URL.createObjectURL;
const revoke = URL.revokeObjectURL;
afterEach(() => {
  globalThis.Image = OriginalImage;
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
});
test("standalone dimensions replace responsive attributes without changing text", () => {
  const svg = standaloneSvg(
    '<svg viewBox="0 0 20 10" width="100%" height="auto" style="max-width:100%"><text>漢字</text></svg>',
    20,
    10,
  );
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(svg).toContain('width="20" height="10"');
  expect(svg).toContain("漢字");
  expect(svg).not.toContain("100%");
});
test("PNG size stays inside pixel and dimension bounds", () => {
  const size = pngExportSize(20_000, 10_000);
  expect(size.width).toBeLessThanOrEqual(PREVIEW_CAPTURE_POLICY.maxDimension);
  expect(size.width * size.height).toBeLessThanOrEqual(PREVIEW_CAPTURE_POLICY.maxPixels);
});
test("failed image decoding releases its object URL", async () => {
  URL.createObjectURL = () => "blob:test-svg";
  const released = mock(() => undefined);
  URL.revokeObjectURL = released;
  globalThis.Image = class {
    decode() {
      return Promise.reject(new Error("bad image"));
    }
  } as unknown as typeof Image;
  await expect(rasterizeSvgToPng("<svg/>", 20, 10)).rejects.toThrow("rasterize");
  expect(released).toHaveBeenCalledWith("blob:test-svg");
});
