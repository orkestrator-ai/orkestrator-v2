import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLogger, getLogFormat } from "../logger.js";
import { captureLogs, type LogCapture } from "../testing/log-capture.js";
import {
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
