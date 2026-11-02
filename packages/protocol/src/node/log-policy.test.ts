import { afterEach, describe, expect, test } from "bun:test";
import { configureLogger, createLogger, resetLogger } from "../logger.js";
import type { ApplicationLogPolicy } from "./application-logging.js";
import {
  applyApplicationLogPolicy,
  applyLogDetail,
  effectiveLogDetail,
  isLogPolicyChangedRecord,
  logPolicyChangedRecord,
  logPolicyKey,
} from "./log-policy.js";

afterEach(() => resetLogger());

const policy = (enabled: boolean): ApplicationLogPolicy => ({
  saving: { enabled, retentionDays: 7 },
  detail: { level: "info", areaLevels: { bridge: "debug" } },
});

describe("applying log detail", () => {
  test("a logger created earlier takes the new level on its next call", () => {
    const log = createLogger("updater");
    expect(log.isEnabled("debug")).toBe(false);
    applyLogDetail({ level: "info", areaLevels: { updater: "debug" } }, {});
    expect(log.isEnabled("debug")).toBe(true);
    applyLogDetail({ level: "error", areaLevels: {} }, {});
    expect(log.isEnabled("warn")).toBe(false);
  });

  test("keeps the format and sink the entrypoint chose", () => {
    const lines: string[] = [];
    configureLogger({ format: "json", sink: ({ line }) => lines.push(line) });
    applyLogDetail({ level: "debug", areaLevels: {} }, {});
    createLogger("updater").debug("downloaded", { version: "1" });
    expect(JSON.parse(lines[0]!)).toMatchObject({ area: "updater", event: "downloaded" });
  });

  test("the environment stays on top of the settings", () => {
    expect(
      effectiveLogDetail(
        { level: "debug", areaLevels: { updater: "debug", bridge: "debug" } },
        { ORKESTRATOR_LOG_LEVEL: "warn,updater=trace" },
      ),
    ).toEqual({ level: "warn", areaLevels: { updater: "trace", bridge: "debug" } });
    const settings = { level: "debug" as const, areaLevels: {} };
    expect(effectiveLogDetail(settings, {})).toEqual(settings);
  });
});

describe("the audit line's order against saving", () => {
  function order(enabled: boolean): string[] {
    const calls: string[] = [];
    applyApplicationLogPolicy(
      policy(enabled),
      { updateSettings: () => calls.push("writer") },
      () => calls.push("audit"),
      {},
    );
    return calls;
  }

  test("turning saving on writes it after the writer starts", () => {
    expect(order(true)).toEqual(["writer", "audit"]);
  });

  test("turning saving off writes it before the writer stops", () => {
    expect(order(false)).toEqual(["audit", "writer"]);
  });

  test("a process with no writer of its own still audits", () => {
    let audited = 0;
    applyApplicationLogPolicy(policy(true), null, () => (audited += 1), {});
    expect(audited).toBe(1);
  });
});

describe("the audit record", () => {
  test("holds settings only", () => {
    const record = logPolicyChangedRecord(policy(true));
    expect(record).toMatchObject({ area: "logging", event: "policy.changed", level: "info" });
    expect(record.fields).toEqual({
      saving: true,
      retentionDays: 7,
      level: "info",
      areaLevels: "bridge=debug",
    });
    expect(isLogPolicyChangedRecord(record)).toBe(true);
  });

  test("the key tells policies apart", () => {
    expect(logPolicyKey(policy(true))).toBe(logPolicyKey(policy(true)));
    expect(logPolicyKey(policy(true))).not.toBe(logPolicyKey(policy(false)));
  });
});
