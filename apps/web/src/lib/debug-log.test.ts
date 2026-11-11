import { afterEach, describe, expect, mock, test } from "bun:test";
import { createLogger } from "@orkestrator/protocol/logger";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import {
  applyRendererLogLevel,
  canOfferDeveloperTools,
  canOfferWebInspector,
  DEBUG_LOG_STORAGE_KEY,
  readDebugPreference,
  rendererDebugLoggingActive,
  reportRendererDebugLogging,
  reportWebInspectable,
  setRendererDebugPreference,
} from "./debug-log";

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

describe("the Settings switch and the desktop report", () => {
  afterEach(() => {
    localStorage.removeItem(DEBUG_LOG_STORAGE_KEY);
    applyRendererLogLevel();
  });

  test("turning it on writes the key for this window and reloads", () => {
    const reload = mock(() => undefined);
    expect(setRendererDebugPreference(true, { reload })).toBe(true);
    expect(localStorage.getItem(DEBUG_LOG_STORAGE_KEY)).toBe("1");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("turning it off clears the key and reloads", () => {
    localStorage.setItem(DEBUG_LOG_STORAGE_KEY, "1");
    const reload = mock(() => undefined);
    expect(setRendererDebugPreference(false, { reload })).toBe(true);
    expect(localStorage.getItem(DEBUG_LOG_STORAGE_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("storage that refuses the write does not reload", () => {
    const reload = mock(() => undefined);
    const storage = {
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
    };
    expect(setRendererDebugPreference(true, { storage, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  test("what is in force is what the renderer started with, not what is stored since", () => {
    applyRendererLogLevel();
    expect(rendererDebugLoggingActive()).toBe(false);
    setRendererDebugPreference(true, { reload: () => undefined });
    expect(rendererDebugLoggingActive()).toBe(false);
    applyRendererLogLevel();
    expect(rendererDebugLoggingActive()).toBe(true);
  });

  test("the desktop hears the state at start, on or off; a browser has nothing to tell", () => {
    const setRendererDebugLogging = mock(async (_enabled: boolean) => true);
    localStorage.setItem(DEBUG_LOG_STORAGE_KEY, "1");
    applyRendererLogLevel();
    reportRendererDebugLogging({ setRendererDebugLogging });
    localStorage.removeItem(DEBUG_LOG_STORAGE_KEY);
    applyRendererLogLevel();
    reportRendererDebugLogging({ setRendererDebugLogging });
    expect(setRendererDebugLogging.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);
    expect(canOfferDeveloperTools({})).toBe(false);
    expect(() => reportRendererDebugLogging({})).not.toThrow();
    expect(() => reportRendererDebugLogging(undefined)).not.toThrow();
  });

  test("the iOS shell hears the same state for Safari's Web Inspector; elsewhere nothing", () => {
    const setWebInspectable = mock(async (_enabled: boolean) => true);
    localStorage.setItem(DEBUG_LOG_STORAGE_KEY, "1");
    applyRendererLogLevel();
    reportWebInspectable({ setWebInspectable });
    localStorage.removeItem(DEBUG_LOG_STORAGE_KEY);
    applyRendererLogLevel();
    reportWebInspectable({ setWebInspectable });
    expect(setWebInspectable.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);
    expect(canOfferWebInspector({ setWebInspectable })).toBe(true);
    expect(canOfferWebInspector({})).toBe(false);
    expect(canOfferWebInspector(undefined)).toBe(false);
    const rejecting = mock(async () => {
      throw new Error("older app");
    });
    expect(() => reportWebInspectable({ setWebInspectable: rejecting })).not.toThrow();
    expect(() => reportWebInspectable({})).not.toThrow();
  });
});

test("a throwing localStorage getter returns false without reloading", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const reload = mock(() => undefined);
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    expect(setRendererDebugPreference(true, { reload })).toBe(false);
    expect(setRendererDebugPreference(false, { reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
