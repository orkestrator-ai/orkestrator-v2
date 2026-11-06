import { describe, expect, test } from "bun:test";
import {
  bridgeDebugEnvValue,
  defaultLogDetail,
  effectiveLogLevel,
  formatLogAreaLevels,
  legacyDebugLogDetail,
  LOG_DETAIL_EXPIRY_MS,
  logDetailAreas,
  logDetailExpiryAction,
  logDetailIsRaised,
  nextLogDetailExpiresAt,
  parseLogDetailExpiresAt,
  revertRaisedLogDetail,
  logDetailEnablesBridgeDiagnostics,
  parseBridgeLogPolicy,
  parseLogDetail,
  resolveLogDetail,
} from "./log-policy.js";
import { LOG_VOCABULARY } from "./log-vocabulary/index.js";

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
  test("offers the bridge scope first and controllable areas once", () => {
    const areas = logDetailAreas().map((entry) => entry.area);
    expect(areas.slice(0, 2)).toEqual(["bridge", "bridge.diagnostics"]);
    expect(areas).toContain("updater");
    expect(new Set(areas).size).toBe(areas.length);
    for (const entry of logDetailAreas()) expect(entry.description.length).toBeGreaterThan(0);
  });

  test("keeps renderer areas registered without offering ineffective live controls", () => {
    const offered = logDetailAreas().map((entry) => entry.area);
    const rendererAreas = Object.keys(LOG_VOCABULARY).filter(
      (area) => area.startsWith("web.") || area.startsWith("terminal."),
    );
    expect(rendererAreas).toContain("web.window");
    expect(rendererAreas).toContain("terminal.setup");
    for (const area of rendererAreas) expect(offered).not.toContain(area);
    for (const area of [
      "terminal",
      "backend.activity",
      "desktop.startup",
      "updater",
      "bridge",
      "bridge.diagnostics",
    ]) {
      expect(offered).toContain(area);
    }
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

describe("raised detail and its expiry", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  const inADay = new Date(now + LOG_DETAIL_EXPIRY_MS).toISOString();
  const bridgeDebug = { level: "info", areaLevels: { bridge: "debug" } } as const;

  test("only a level above info is raised; a quieter area is not", () => {
    expect(logDetailIsRaised(defaultLogDetail())).toBe(false);
    expect(logDetailIsRaised({ level: "warn", areaLevels: { updater: "error" } })).toBe(false);
    expect(logDetailIsRaised({ level: "debug", areaLevels: {} })).toBe(true);
    expect(logDetailIsRaised(bridgeDebug)).toBe(true);
  });

  test("reverting lowers raised levels and keeps quieter ones", () => {
    expect(
      revertRaisedLogDetail({
        level: "trace",
        areaLevels: { bridge: "debug", updater: "warn", desktop: "info" },
      }),
    ).toEqual({ level: "info", areaLevels: { desktop: "info", updater: "warn" } });
    expect(revertRaisedLogDetail({ level: "warn", areaLevels: { git: "trace" } })).toEqual({
      level: "warn",
      areaLevels: {},
    });
  });

  test("a write that raises detail stores an expiry a day out", () => {
    expect(nextLogDetailExpiresAt({ logDetail: bridgeDebug }, { logDetail: {} }, now)).toBe(inADay);
  });

  test("an older client's write (no expiry keys) still gets one", () => {
    expect(nextLogDetailExpiresAt({ logDetail: bridgeDebug }, null, now)).toBe(inADay);
  });

  test("detail at info, or kept on, stores none", () => {
    expect(nextLogDetailExpiresAt({ logDetail: defaultLogDetail() }, null, now)).toBeUndefined();
    expect(
      nextLogDetailExpiresAt({ logDetail: bridgeDebug, logDetailKeepRaised: true }, null, now),
    ).toBeUndefined();
  });

  test("the same raised levels keep their expiry; changed ones start again", () => {
    const stored = { logDetail: bridgeDebug, logDetailExpiresAt: "2026-11-05T20:00:00.000Z" };
    expect(nextLogDetailExpiresAt({ logDetail: bridgeDebug }, stored, now)).toBe(
      "2026-11-05T20:00:00.000Z",
    );
    expect(
      nextLogDetailExpiresAt({ logDetail: { level: "debug", areaLevels: {} } }, stored, now),
    ).toBe(inADay);
    // Turning "keep" off starts a fresh day rather than reverting at once.
    expect(
      nextLogDetailExpiresAt(
        { logDetail: bridgeDebug },
        { logDetail: bridgeDebug, logDetailKeepRaised: true },
        now,
      ),
    ).toBe(inADay);
  });

  test("the check stamps, clears and reverts, and is otherwise quiet", () => {
    expect(logDetailExpiryAction({ logDetail: defaultLogDetail() }, now)).toEqual({ kind: "none" });
    expect(logDetailExpiryAction({ logDetail: bridgeDebug }, now)).toEqual({
      kind: "stamp",
      expiresAt: inADay,
    });
    // A config from before the split with saving on maps to bridge detail, so it expires too.
    expect(logDetailExpiryAction({ debugLogging: true }, now).kind).toBe("stamp");
    expect(
      logDetailExpiryAction({ logDetail: defaultLogDetail(), logDetailExpiresAt: inADay }, now),
    ).toEqual({ kind: "clear" });
    expect(
      logDetailExpiryAction(
        { logDetail: bridgeDebug, logDetailKeepRaised: true, logDetailExpiresAt: inADay },
        now,
      ),
    ).toEqual({ kind: "clear" });
    expect(
      logDetailExpiryAction({ logDetail: bridgeDebug, logDetailExpiresAt: inADay }, now),
    ).toEqual({ kind: "none" });
    expect(
      logDetailExpiryAction(
        { logDetail: bridgeDebug, logDetailExpiresAt: "2026-11-05T12:00:00.000Z" },
        now,
      ),
    ).toEqual({ kind: "revert", detail: defaultLogDetail() });
  });

  test("an expiry that is not a timestamp counts as none", () => {
    expect(parseLogDetailExpiresAt("tomorrow")).toBeNull();
    expect(parseLogDetailExpiresAt(1_793_000_000_000)).toBeNull();
    expect(
      logDetailExpiryAction({ logDetail: bridgeDebug, logDetailExpiresAt: "soon" }, now),
    ).toEqual({ kind: "stamp", expiresAt: inADay });
  });
});
