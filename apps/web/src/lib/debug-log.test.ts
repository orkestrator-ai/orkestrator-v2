import { afterEach, describe, expect, mock, test } from "bun:test";
import { createLogger } from "@orkestrator/protocol/logger";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { applyRendererLogLevel, DEBUG_LOG_STORAGE_KEY, readDebugPreference } from "./debug-log";

describe("readDebugPreference", () => {
  test("is off when nothing is stored", () => {
    expect(readDebugPreference(null)).toBe(false);
    expect(readDebugPreference(undefined)).toBe(false);
    expect(readDebugPreference("")).toBe(false);
    expect(readDebugPreference("   ")).toBe(false);
  });

  test("is off for the conventional negative spellings, in any case or padding", () => {
    for (const value of ["0", "false", "off", "no", "FALSE", " Off ", "No"]) {
      expect(readDebugPreference(value)).toBe(false);
    }
  });

  test("is on for anything else", () => {
    for (const value of ["1", "true", "yes", "on", "verbose", " 1 "]) {
      expect(readDebugPreference(value)).toBe(true);
    }
  });
});

describe("applyRendererLogLevel", () => {
  const log = createLogger("web.pane-layout");
  let logs: LogCapture | undefined;

  afterEach(() => {
    logs?.restore();
    localStorage.removeItem(DEBUG_LOG_STORAGE_KEY);
  });

  test("with the preference off, a debug site builds no arguments and writes nothing", () => {
    logs = captureLogs();
    applyRendererLogLevel();
    const fields = mock(() => ({ count: 1 }));

    log.debug("persist.failed", fields);

    expect(log.isEnabled("debug")).toBe(false);
    expect(fields).not.toHaveBeenCalled();
    expect(logs.lines).toEqual([]);
  });

  test("with the preference on, the same site writes at debug", () => {
    logs = captureLogs();
    localStorage.setItem(DEBUG_LOG_STORAGE_KEY, "1");
    applyRendererLogLevel();

    log.debug("persist.failed", () => ({ count: 1 }));

    expect(log.isEnabled("debug")).toBe(true);
    expect(logs.lines).toEqual(["[web.pane-layout] persist.failed count=1"]);
  });
});
