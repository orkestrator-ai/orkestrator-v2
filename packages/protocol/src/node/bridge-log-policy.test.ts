import { afterEach, describe, expect, test } from "bun:test";
import { configureLogger, createLogger, parseLogRecordLine, resetLogger } from "../logger.js";
import { captureLogs } from "../testing/log-capture.js";
import { bridgeDebugEnabled } from "./bridge-diagnostics.js";
import { configureBridgeLogger, LOG_LEVEL_ENV } from "./logger-environment.js";
import {
  applyBridgeLogPolicy,
  MAX_BRIDGE_LOG_POLICY_BYTES,
  readBridgeLogPolicyBody,
  resetBridgeLogPolicyForTests,
} from "./bridge-log-policy.js";

afterEach(() => {
  resetBridgeLogPolicyForTests();
  resetLogger();
});

describe("applyBridgeLogPolicy", () => {
  test.each([
    ["error", "debug", false],
    ["debug", "error", true],
  ] as const)(
    "retains the consumed startup override %s during live updates",
    (override, level, diagnostics) => {
      const env: NodeJS.ProcessEnv = { [LOG_LEVEL_ENV]: override };
      configureBridgeLogger(env);
      expect({ ...env }).toEqual({});
      expect(applyBridgeLogPolicy({ seq: 1, level, areaLevels: {} }, env).body).toMatchObject({
        diagnostics,
      });
      expect(createLogger("bridge.codex").isEnabled("debug")).toBe(diagnostics);
      expect(applyBridgeLogPolicy({ seq: 2, level, areaLevels: {} }, env).body).toMatchObject({
        diagnostics,
      });
    },
  );

  test.each([
    ["bridge.claude", "prompt.accepted"],
    ["bridge.codex", "app-server.exited"],
    ["bridge.cursor", "agent.archive-failed"],
    ["bridge.pi", "http.route-failed"],
    ["bridge.acp", "evidence.record-failed"],
  ] as const)("the next %s line follows the setting, up and down", (area, event) => {
    const capture = captureLogs();
    try {
      const log = createLogger(area) as unknown as {
        debug(event: string): void;
        info(event: string): void;
      };
      const written = () => capture.records().map((record) => record.level);

      log.debug(event);
      expect(written()).toEqual([]);

      applyBridgeLogPolicy({ seq: 1, level: "info", areaLevels: { bridge: "debug" } });
      log.debug(event);
      expect(written()).toEqual(["debug"]);
      expect(capture.records()[0]).toMatchObject({ area, event });

      applyBridgeLogPolicy({ seq: 2, level: "error", areaLevels: {} });
      log.info(event);
      log.debug(event);
      expect(written()).toEqual(["debug"]);
    } finally {
      capture.restore();
    }
  });

  test("a relaying bridge keeps writing records the backend can parse", () => {
    const capture = captureLogs();
    try {
      configureLogger({ format: "json" });
      applyBridgeLogPolicy({ seq: 1, level: "debug", areaLevels: {} });
      createLogger("bridge.codex").debug("app-server.exited");
      expect(parseLogRecordLine(capture.lines[0]!)).toMatchObject({
        level: "debug",
        area: "bridge.codex",
      });
    } finally {
      capture.restore();
    }
  });

  test("replaces this process's levels and its diagnostics switch at once", () => {
    const log = createLogger("updater");
    expect(log.isEnabled("debug")).toBe(false);
    expect(
      applyBridgeLogPolicy({
        seq: 1,
        level: "info",
        areaLevels: { updater: "debug", bridge: "debug" },
      }),
    ).toEqual({ status: 200, body: { applied: true, seq: 1, diagnostics: true } });
    expect(log.isEnabled("debug")).toBe(true);
    expect(bridgeDebugEnabled("claude")).toBe(true);

    expect(applyBridgeLogPolicy({ seq: 2, level: "info", areaLevels: {} }).body).toMatchObject({
      diagnostics: false,
    });
    expect(log.isEnabled("debug")).toBe(false);
    expect(bridgeDebugEnabled("claude")).toBe(false);
  });

  test("the receiving bridge applies its own environment over stored settings", () => {
    expect(
      applyBridgeLogPolicy(
        { seq: 1, level: "error", areaLevels: {} },
        { ORKESTRATOR_LOG_LEVEL: "debug" },
      ).body,
    ).toMatchObject({ diagnostics: true });
    expect(createLogger("updater").isEnabled("debug")).toBe(true);
    expect(
      applyBridgeLogPolicy(
        { seq: 2, level: "debug", areaLevels: {} },
        { ORKESTRATOR_LOG_LEVEL: "error" },
      ).body,
    ).toMatchObject({ diagnostics: false });
    expect(createLogger("updater").isEnabled("info")).toBe(false);
  });

  test("a delayed older policy cannot undo a newer one", () => {
    applyBridgeLogPolicy({ seq: 5, level: "debug", areaLevels: {} });
    expect(applyBridgeLogPolicy({ seq: 4, level: "error", areaLevels: {} })).toEqual({
      status: 200,
      body: { applied: false, stale: true, seq: 5 },
    });
    expect(createLogger("updater").isEnabled("debug")).toBe(true);
  });

  test("a retry of the same policy is answered the same", () => {
    const first = applyBridgeLogPolicy({ seq: 5, level: "debug", areaLevels: {} });
    expect(applyBridgeLogPolicy({ seq: 5, level: "debug", areaLevels: {} })).toEqual(first);
  });

  test.each([[null], [{}], [{ level: "debug" }], [{ seq: 1, level: "loud" }]])(
    "refuses %j, changing nothing",
    (value) => {
      expect(applyBridgeLogPolicy(value)).toEqual({
        status: 400,
        body: { error: "Invalid log policy" },
      });
      expect(createLogger("updater").isEnabled("debug")).toBe(false);
    },
  );
});

describe("readBridgeLogPolicyBody", () => {
  const request = (body: string) => new Request("http://bridge/", { method: "POST", body });

  test("reads JSON", async () => {
    expect(await readBridgeLogPolicyBody(request('{"seq":1}'))).toEqual({ seq: 1 });
  });

  test("is null for a body that is not JSON, empty or over the bound", async () => {
    expect(await readBridgeLogPolicyBody(request("{ torn"))).toBeNull();
    expect(
      await readBridgeLogPolicyBody(new Request("http://bridge/", { method: "POST" })),
    ).toBeNull();
    const big = JSON.stringify({ pad: "x".repeat(MAX_BRIDGE_LOG_POLICY_BYTES) });
    expect(await readBridgeLogPolicyBody(request(big))).toBeNull();
  });
});
