import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLogger, getLogFormat } from "../logger.js";
import { captureLogs, type LogCapture } from "../testing/log-capture.js";
import {
  BRIDGE_LOG_RELAY_ENV,
  configureBridgeLogger,
  configureLoggerFromEnvironment,
  LOG_FORMAT_ENV,
  LOG_LEVEL_ENV,
  parseLogLevels,
} from "./logger-environment.js";

let capture: LogCapture;

beforeEach(() => {
  capture = captureLogs();
});

afterEach(() => capture.restore());

describe("parseLogLevels", () => {
  test("accepts the documented startup example", () => {
    expect(parseLogLevels("warn,updater=debug,desktop.dialog=trace")).toEqual({
      level: "warn",
      areaLevels: { updater: "debug", "desktop.dialog": "trace" },
      invalid: [],
    });
  });

  test("reads a default and per-area levels", () => {
    expect(parseLogLevels("warn, updater=debug ,desktop=trace")).toEqual({
      level: "warn",
      areaLevels: { updater: "debug", desktop: "trace" },
      invalid: [],
    });
  });

  test("a parent of a listed area is a valid scope", () => {
    expect(parseLogLevels("desktop=debug").areaLevels).toEqual({ desktop: "debug" });
  });

  test("reports what it could not use", () => {
    expect(parseLogLevels("loud,nope=debug,updater=loud,__proto__=debug").invalid).toEqual([
      "loud",
      "nope=debug",
      "updater=loud",
      "__proto__=debug",
    ]);
  });

  test("empty means no change", () => {
    expect(parseLogLevels(undefined)).toEqual({ areaLevels: {}, invalid: [] });
    expect(parseLogLevels(" , ")).toEqual({ areaLevels: {}, invalid: [] });
  });
});

describe("configureLoggerFromEnvironment", () => {
  const log = createLogger("updater");

  test("defaults to info and text", () => {
    configureLoggerFromEnvironment({});
    expect(log.isEnabled("info")).toBe(true);
    expect(log.isEnabled("debug")).toBe(false);
    expect(getLogFormat()).toBe("text");
  });

  test("applies levels and format from the environment", () => {
    configureLoggerFromEnvironment({
      [LOG_LEVEL_ENV]: "error,updater=debug",
      [LOG_FORMAT_ENV]: "json",
    });
    expect(log.isEnabled("debug")).toBe(true);
    expect(createLogger("preview").isEnabled("warn")).toBe(false);
    expect(getLogFormat()).toBe("json");
  });

  test("a supervised process writes records whatever format the user chose", () => {
    configureLoggerFromEnvironment({ [LOG_FORMAT_ENV]: "text" }, { relayToSupervisor: true });
    expect(getLogFormat()).toBe("json");
  });

  test("warns about a bad value without echoing it", () => {
    configureLoggerFromEnvironment({ [LOG_LEVEL_ENV]: "private-text", [LOG_FORMAT_ENV]: "yaml" });
    expect(capture.lines).toEqual([
      `[logging] config.invalid variable=${LOG_LEVEL_ENV} entries=1`,
      `[logging] config.invalid variable=${LOG_FORMAT_ENV} entries=1`,
    ]);
  });
});

describe("configureBridgeLogger", () => {
  test("a bridge the backend relays writes JSON whatever format was asked for, and does not pass the flag on", () => {
    const env = { [BRIDGE_LOG_RELAY_ENV]: "1", [LOG_FORMAT_ENV]: "text" } as NodeJS.ProcessEnv;
    configureBridgeLogger(env);
    expect(getLogFormat()).toBe("json");
    expect(env[BRIDGE_LOG_RELAY_ENV]).toBeUndefined();
  });

  test("any other bridge follows the environment", () => {
    configureBridgeLogger({});
    expect(getLogFormat()).toBe("text");
    configureBridgeLogger({ [LOG_FORMAT_ENV]: "json" });
    expect(getLogFormat()).toBe("json");
  });

  test("the level reaches a bridge's areas, including through the bridge parent", () => {
    configureBridgeLogger({ [LOG_LEVEL_ENV]: "warn,bridge=debug,bridge.pi=error" });
    expect(createLogger("bridge.codex").isEnabled("debug")).toBe(true);
    expect(createLogger("bridge.pi").isEnabled("warn")).toBe(false);
    expect(createLogger("event-loop").isEnabled("info")).toBe(false);
  });
});
