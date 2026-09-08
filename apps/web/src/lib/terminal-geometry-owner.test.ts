import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  publishTerminalGeometryIfOwned,
  shouldPublishTerminalGeometry,
} from "./terminal-geometry-owner";

afterEach(() => {
  delete window.orkestrator;
});

describe("terminal geometry ownership", () => {
  test("retains existing behavior outside isolated Electron windows", () => {
    expect(shouldPublishTerminalGeometry(false, false)).toBe(true);
  });

  test("allows every visible terminal in the focused Electron window", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    expect(shouldPublishTerminalGeometry(true, true)).toBe(true);
    expect(shouldPublishTerminalGeometry(false, true)).toBe(false);
    expect(shouldPublishTerminalGeometry(true, false)).toBe(false);
  });

  test("invokes a shared geometry publisher only for the owning window", async () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    const publish = mock(async () => undefined);

    await expect(publishTerminalGeometryIfOwned(true, 120, 40, publish, true)).resolves.toBe(true);
    await expect(publishTerminalGeometryIfOwned(true, 80, 24, publish, false)).resolves.toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(120, 40);
  });
});
