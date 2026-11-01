import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { configureLogger } from "@orkestrator/protocol/logger";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { createUpdaterLibraryLogger } from "../electron/updater-log";

let capture: LogCapture;

beforeEach(() => {
  capture = captureLogs();
});

afterEach(() => capture.restore());

describe("electron-updater logging", () => {
  test("keeps the library's levels under the updater area", () => {
    const logger = createUpdaterLibraryLogger();
    logger.info("Checking for update");
    logger.warn("slow");
    logger.error("failed");
    expect(capture.outputs.map(({ method, line }) => [method, line])).toEqual([
      ["info", '[updater] library.message message="Checking for update"'],
      ["warn", "[updater] library.message message=slow"],
      ["error", "[updater] library.message message=failed"],
    ]);
  });

  test("by default the differential download plan is neither built nor written", () => {
    const logger = createUpdaterLibraryLogger();
    // How DifferentialDownloader reaches its plan: it checks for the method first.
    const buildPlan = mock(() => JSON.stringify([{ start: 0, end: 1, kind: "COPY" }], null, 2));
    if (logger.debug != null) logger.debug(buildPlan());
    expect(buildPlan).not.toHaveBeenCalled();
    expect(capture.lines).toEqual([]);
  });

  test("with debug on, a pretty-printed plan is one bounded line", () => {
    configureLogger({ areaLevels: { updater: "debug" } });
    const logger = createUpdaterLibraryLogger();
    const plan = Array.from({ length: 2600 }, (_, start) => ({
      start,
      end: start + 1,
      kind: "COPY",
    }));
    logger.debug?.(JSON.stringify(plan, null, 2));
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]).not.toContain("\n");
    // The 2 KiB field bound applies before the newlines are escaped.
    expect(capture.lines[0]!.length).toBeLessThan(3000);
    expect(capture.outputs[0]?.method).toBe("debug");
  });

  test("a level change applies without recreating the logger", () => {
    const logger = createUpdaterLibraryLogger();
    expect(logger.debug).toBeUndefined();
    configureLogger({ level: "debug" });
    expect(logger.debug).toBeFunction();
  });

  test("strips signed URL parameters and takes errors through the safe formatter", () => {
    const logger = createUpdaterLibraryLogger();
    logger.info("Downloading https://x.test/a.zip?signature=abcdef123456&sig=abcdef123456");
    expect(capture.lines[0]).not.toContain("abcdef123456");
    logger.warn(Object.assign(new Error("native failure"), { stderr: "private" }));
    expect(capture.lines[1]).not.toContain("private");
    expect(capture.lines[1]).toContain("error.outputOmitted=true");
  });

  test("a value that is neither text nor an error is not copied", () => {
    createUpdaterLibraryLogger().info({ secret: "private" });
    expect(capture.lines).toEqual(['[updater] library.message message="[non-text]"']);
  });
});
