import { afterEach, describe, expect, test } from "bun:test";
import { shouldPublishTerminalGeometry } from "./terminal-geometry-owner";

afterEach(() => {
  delete window.orkestrator;
});

describe("terminal geometry ownership", () => {
  test("retains existing behavior outside isolated Electron windows", () => {
    expect(shouldPublishTerminalGeometry(false, false)).toBe(true);
  });

  test("allows only the focused terminal in the focused Electron window", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    expect(shouldPublishTerminalGeometry(true, true)).toBe(true);
    expect(shouldPublishTerminalGeometry(false, true)).toBe(false);
    expect(shouldPublishTerminalGeometry(true, false)).toBe(false);
  });
});
