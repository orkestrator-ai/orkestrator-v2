import { describe, expect, test } from "bun:test";
import { elementResizeChanged } from "./DesignFrameView";

describe("element resize commit guard", () => {
  test("does not commit a pointer click without movement", () => {
    expect(elementResizeChanged({ width: 120, height: 80 }, 120, 80)).toBe(false);
  });

  test("commits a real width or height change", () => {
    expect(elementResizeChanged({ width: 120, height: 80 }, 121, 80)).toBe(true);
    expect(elementResizeChanged({ width: 120, height: 80 }, 120, 81)).toBe(true);
  });
});
