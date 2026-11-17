import { describe, expect, test } from "bun:test";
import type { ElectronApplication } from "playwright";
import {
  describeLostFocus,
  explainLostFocus,
  parseLsappinfoInfo,
  readFrontApplication,
  type WindowFocusFacts,
} from "./window-focus-loss";

// Shape of `lsappinfo info <ASN>` on macOS 27.2 (mbp3, 2026-11-17).
const LSAPPINFO_INFO = `"Other App" ASN:0x0-0x2114112: (in front)
    bundleID="com.example.other"
    pid = 4242 token=[sess=1 pid=4242 uid:501,501,501] type="Foreground" flavor=3
`;

function facts(overrides: Partial<WindowFocusFacts> = {}): WindowFocusFacts {
  return {
    windowFocused: false,
    appHasFocusedWindow: false,
    electronPid: 1000,
    front: { kind: "front", application: { name: "Other App", pid: 4242 } },
    ...overrides,
  };
}

/** An Electron app whose main process answers `readWindowFocus` with these windows. */
function fakeApp(windows: { windowFocused: boolean; appHasFocusedWindow: boolean }) {
  return {
    evaluate: async () => windows,
    process: () => ({ pid: 1000 }),
  } as unknown as ElectronApplication;
}

describe("window focus loss", () => {
  test("reads the front application's name and pid from lsappinfo", () => {
    expect(parseLsappinfoInfo(LSAPPINFO_INFO)).toEqual({ name: "Other App", pid: 4242 });
    expect(parseLsappinfoInfo("[ NULL ]")).toBeUndefined();
  });

  test("asks lsappinfo for the front application only on macOS", () => {
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return args[0] === "front"
        ? { status: 0, stdout: "ASN:0x0-0x2114112:\n" }
        : { status: 0, stdout: LSAPPINFO_INFO };
    };
    expect(readFrontApplication("linux", run)).toEqual({ kind: "not-macos" });
    expect(calls).toEqual([]);
    expect(readFrontApplication("darwin", run)).toEqual({
      kind: "front",
      application: { name: "Other App", pid: 4242 },
    });
    expect(calls).toEqual([
      ["lsappinfo", "front"],
      ["lsappinfo", "info", "ASN:0x0-0x2114112:"],
    ]);
    expect(readFrontApplication("darwin", () => ({ status: 1, stdout: "" }))).toEqual({
      kind: "unavailable",
      reason: "lsappinfo front named no application",
    });
  });

  test("names the lost focus and the application that took the key window", () => {
    const note = describeLostFocus(facts(), true);
    expect(note).toStartWith("Lost window focus: the window had the key focus at the start");
    expect(note).toContain("BrowserWindow.isFocused() is false.");
    expect(note).toContain(
      'macOS has "Other App" (pid 4242) in front, not this Electron app (pid 1000): another application took the key window.',
    );
    expect(note).not.toContain("inactive");
  });

  test("says when the window never had the key focus", () => {
    expect(describeLostFocus(facts(), false)).toStartWith(
      "No window focus: the window did not get the key focus at the start",
    );
  });

  test("says when the app is still in front but its host window lost the key", () => {
    const note = describeLostFocus(
      facts({
        appHasFocusedWindow: true,
        front: { kind: "front", application: { name: "Electron", pid: 1000 } },
      }),
      true,
    );
    expect(note).toContain("(another of the app's windows is focused)");
    expect(note).toContain("macOS still has this Electron app (pid 1000) in front");
  });

  test("off macOS, names the loss without a front application", () => {
    const note = describeLostFocus(facts({ front: { kind: "not-macos" } }), true);
    expect(note).toStartWith("Lost window focus:");
    expect(note).not.toContain("in front");
  });

  test("explains nothing while the window still has the key focus", () => {
    expect(describeLostFocus(facts({ windowFocused: true }), true)).toBeUndefined();
  });

  test("keeps the original failure, its stack frames and cause when it adds the loss", async () => {
    const original = new Error('expect(locator).toBeFocused() failed\nReceived: "inactive"');
    original.stack = `Error: ${original.message}\n    at tabActivate (web-annotations-electron.spec.ts:2389:3)`;
    const explained = await explainLostFocus(
      original,
      fakeApp({ windowFocused: false, appHasFocusedWindow: false }),
      true,
      () => ({ kind: "front", application: { name: "Other App", pid: 4242 } }),
    );
    expect(explained).not.toBe(original);
    if (!(explained instanceof Error)) throw new Error("expected an Error");
    expect(explained.message).toStartWith("Lost window focus:");
    expect(explained.message).toContain('"Other App" (pid 4242) in front');
    expect(explained.message).toEndWith(original.message);
    expect(explained.cause).toBe(original);
    expect(explained.stack).toEndWith(
      "\n    at tabActivate (web-annotations-electron.spec.ts:2389:3)",
    );
  });

  test("rethrows the failure unchanged while focused, before focus was read, or when the read fails", async () => {
    const original = new Error("unrelated");
    const front = () => ({ kind: "not-macos" }) as const;
    const focused = fakeApp({ windowFocused: true, appHasFocusedWindow: true });
    expect(await explainLostFocus(original, focused, true, front)).toBe(original);
    const unfocused = fakeApp({ windowFocused: false, appHasFocusedWindow: false });
    expect(await explainLostFocus(original, unfocused, undefined, front)).toBe(original);
    const closed = {
      evaluate: async () => {
        throw new Error("Target page, context or browser has been closed");
      },
      process: () => ({ pid: 1000 }),
    } as unknown as ElectronApplication;
    expect(await explainLostFocus(original, closed, true, front)).toBe(original);
  });
});
