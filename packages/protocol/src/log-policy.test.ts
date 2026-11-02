import { describe, expect, test } from "bun:test";
import {
  bridgeDebugEnvValue,
  defaultLogDetail,
  effectiveLogLevel,
  formatLogAreaLevels,
  legacyDebugLogDetail,
  logDetailAreas,
  logDetailEnablesBridgeDiagnostics,
  parseBridgeLogPolicy,
  parseLogDetail,
  resolveLogDetail,
} from "./log-policy.js";

describe("the upgrade from a single debug switch", () => {
  test("whoever had it on keeps bridge detail, and nothing else changes", () => {
    const detail = resolveLogDetail({ debugLogging: true });
    expect(detail).toEqual(legacyDebugLogDetail());
    expect(detail.level).toBe("info");
    expect(logDetailEnablesBridgeDiagnostics(detail)).toBe(true);
    expect(bridgeDebugEnvValue({ debugLogging: true })).toBe("1");
  });

  test("whoever had it off gets the defaults", () => {
    expect(resolveLogDetail({ debugLogging: false })).toEqual(defaultLogDetail());
    expect(resolveLogDetail({})).toEqual(defaultLogDetail());
    expect(bridgeDebugEnvValue({})).toBe("0");
  });

  test("a stored value wins over the switch, in both directions", () => {
    const quiet = { level: "info" as const, areaLevels: {} };
    expect(resolveLogDetail({ debugLogging: true, logDetail: quiet })).toEqual(quiet);
    expect(bridgeDebugEnvValue({ debugLogging: true, logDetail: quiet })).toBe("0");
    const detailed = { level: "info", areaLevels: { "bridge.diagnostics": "trace" } };
    expect(bridgeDebugEnvValue({ debugLogging: false, logDetail: detailed })).toBe("1");
  });

  test("a stored value that does not parse takes the mapping, never silently off", () => {
    expect(resolveLogDetail({ debugLogging: true, logDetail: { level: "loud" } })).toEqual(
      legacyDebugLogDetail(),
    );
  });
});

describe("parseLogDetail", () => {
  test("accepts a valid setting and sorts its areas", () => {
    const parsed = parseLogDetail({
      level: "warn",
      areaLevels: { updater: "debug", bridge: "trace" },
    });
    expect(parsed).toEqual({ level: "warn", areaLevels: { bridge: "trace", updater: "debug" } });
    expect(Object.keys(parsed!.areaLevels)).toEqual(["bridge", "updater"]);
  });

  test("defaults missing areas", () => {
    expect(parseLogDetail({ level: "info" })).toEqual({ level: "info", areaLevels: {} });
  });

  test.each([
    [null],
    ["info"],
    [[]],
    [{}],
    [{ level: "loud" }],
    [{ level: "info", areaLevels: [] }],
    [{ level: "info", areaLevels: { updater: "loud" } }],
    [{ level: "info", areaLevels: { "Not An Area": "debug" } }],
    [{ level: "info", areaLevels: { __proto__x: "debug" } }],
    [{ level: "info", areaLevels: { ["a".repeat(65)]: "debug" } }],
  ])("refuses %j", (value) => {
    expect(parseLogDetail(value)).toBeNull();
  });

  test("bounds the number of areas", () => {
    const areaLevels = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`area${index}`, "debug"]),
    );
    expect(parseLogDetail({ level: "info", areaLevels })).toBeNull();
  });
});

describe("effective levels", () => {
  test("an area takes its own level, then its nearest parent's, then the default", () => {
    const detail = { level: "warn" as const, areaLevels: { bridge: "debug" as const } };
    expect(effectiveLogLevel(detail, "bridge.diagnostics")).toBe("debug");
    expect(effectiveLogLevel(detail, "updater")).toBe("warn");
    expect(
      effectiveLogLevel(
        { level: "warn", areaLevels: { bridge: "debug", "bridge.diagnostics": "error" } },
        "bridge.diagnostics",
      ),
    ).toBe("error");
  });

  test("bridge snapshots need debug or trace in force for their area", () => {
    expect(logDetailEnablesBridgeDiagnostics({ level: "debug", areaLevels: {} })).toBe(true);
    expect(logDetailEnablesBridgeDiagnostics({ level: "info", areaLevels: {} })).toBe(false);
    expect(
      logDetailEnablesBridgeDiagnostics({ level: "trace", areaLevels: { bridge: "warn" } }),
    ).toBe(false);
  });

  test("the audit form holds only names and levels", () => {
    expect(
      formatLogAreaLevels({ level: "info", areaLevels: { updater: "debug", bridge: "trace" } }),
    ).toBe("bridge=trace,updater=debug");
  });
});

describe("logDetailAreas", () => {
  test("offers the bridge scope first and every listed area once", () => {
    const areas = logDetailAreas().map((entry) => entry.area);
    expect(areas.slice(0, 2)).toEqual(["bridge", "bridge.diagnostics"]);
    expect(areas).toContain("updater");
    expect(new Set(areas).size).toBe(areas.length);
    for (const entry of logDetailAreas()) expect(entry.description.length).toBeGreaterThan(0);
  });
});

describe("parseBridgeLogPolicy", () => {
  test("needs a sequence as well as a valid setting", () => {
    expect(parseBridgeLogPolicy({ level: "info", areaLevels: {}, seq: 5 })).toEqual({
      level: "info",
      areaLevels: {},
      seq: 5,
    });
    expect(parseBridgeLogPolicy({ level: "info", areaLevels: {} })).toBeNull();
    expect(parseBridgeLogPolicy({ level: "info", seq: -1 })).toBeNull();
    expect(parseBridgeLogPolicy({ level: "info", seq: 1.5 })).toBeNull();
    expect(parseBridgeLogPolicy({ level: "loud", seq: 1 })).toBeNull();
  });
});
