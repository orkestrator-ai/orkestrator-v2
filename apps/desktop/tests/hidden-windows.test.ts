import { describe, expect, test } from "bun:test";
import type { BrowserWindowConstructorOptions } from "electron";
import { hiddenWindowConstructor, hiddenWindowOptions } from "../electron/hidden-windows";
import { hiddenWindowsForRuntime } from "../electron/runtime-profile";

class FakeBrowserWindow {
  static readonly created: FakeBrowserWindow[] = [];
  static getAllWindows(): FakeBrowserWindow[] {
    return FakeBrowserWindow.created;
  }
  constructor(readonly options?: BrowserWindowConstructorOptions) {
    FakeBrowserWindow.created.push(this);
  }
}

describe("hidden windows", () => {
  test("never show, and keep painting and running timers while hidden", () => {
    const options = hiddenWindowOptions({
      title: "Profile",
      show: true,
      webPreferences: { sandbox: true, preload: "/app/preload.js" },
    });
    expect(options).toEqual({
      title: "Profile",
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: { sandbox: true, preload: "/app/preload.js", backgroundThrottling: false },
    });
    expect(hiddenWindowOptions()).toMatchObject({ show: false });
  });

  test("the constructor hides every window and stays Electron's own class", () => {
    const Hidden = hiddenWindowConstructor(FakeBrowserWindow);
    const window = new Hidden({ title: "Chooser", webPreferences: { sandbox: true } });
    expect(window).toBeInstanceOf(FakeBrowserWindow);
    expect(window.options).toMatchObject({ title: "Chooser", show: false });
    expect(Hidden.getAllWindows()).toContain(window);
  });

  test("only an agent-test profile on macOS honours the request", () => {
    const asked = { ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS: "1" };
    expect(hiddenWindowsForRuntime("agent-test", "darwin", asked)).toBe(true);
    expect(hiddenWindowsForRuntime("agent-test", "darwin", {})).toBe(false);
    expect(
      hiddenWindowsForRuntime("agent-test", "darwin", {
        ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS: "true",
      }),
    ).toBe(false);
    expect(hiddenWindowsForRuntime("agent-test", "linux", asked)).toBe(false);
    expect(hiddenWindowsForRuntime("agent-test", "win32", asked)).toBe(false);
    expect(hiddenWindowsForRuntime("development", "darwin", asked)).toBe(false);
    expect(hiddenWindowsForRuntime("production", "darwin", asked)).toBe(false);
  });
});
