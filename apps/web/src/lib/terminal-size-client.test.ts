import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { TERMINAL_SIZE_INPUT_CLAIM_INTERVAL_MS } from "@orkestrator/protocol/terminal-size-ownership";
import {
  resetTerminalSizeClientIdForTests,
  TerminalInputClaimThrottle,
  terminalSizeClientId,
} from "./terminal-size-client";

const STORAGE_KEY = "orkestrator:terminal-size-client-id";

afterEach(() => {
  sessionStorage.removeItem(STORAGE_KEY);
  resetTerminalSizeClientIdForTests();
});

describe("terminalSizeClientId", () => {
  test("is stable for the window and survives a reload through sessionStorage", () => {
    const first = terminalSizeClientId();
    expect(terminalSizeClientId()).toBe(first);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(first);
    const entries = spyOn(performance, "getEntriesByType").mockReturnValue([
      { type: "reload" } as PerformanceNavigationTiming,
    ]);
    try {
      resetTerminalSizeClientIdForTests();
      expect(terminalSizeClientId()).toBe(first);
    } finally {
      entries.mockRestore();
    }
  });

  test("a fresh document ignores the identity copied from another live tab", () => {
    const original = terminalSizeClientId();
    resetTerminalSizeClientIdForTests();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(original);
    const duplicate = terminalSizeClientId();
    expect(duplicate).not.toBe(original);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(duplicate);
  });

  test("replaces a stored value that is not a usable id", () => {
    sessionStorage.setItem(STORAGE_KEY, "not a valid id");
    const id = terminalSizeClientId();
    expect(id).not.toBe("not a valid id");
    expect(id).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(id);
  });
});

describe("TerminalInputClaimThrottle", () => {
  test("claims on the first keystroke, then once per interval", () => {
    let now = 0;
    const throttle = new TerminalInputClaimThrottle(undefined, () => now);
    expect(throttle.shouldClaim()).toBe(true);
    now += TERMINAL_SIZE_INPUT_CLAIM_INTERVAL_MS - 1;
    expect(throttle.shouldClaim()).toBe(false);
    now += 1;
    expect(throttle.shouldClaim()).toBe(true);
  });

  test("another claim restarts the interval", () => {
    let now = 0;
    const throttle = new TerminalInputClaimThrottle(1_000, () => now);
    now = 5_000;
    throttle.noteClaim();
    now += 999;
    expect(throttle.shouldClaim()).toBe(false);
    now += 1;
    expect(throttle.shouldClaim()).toBe(true);
  });
});
