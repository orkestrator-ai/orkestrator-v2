import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { configureLogger, resetLogger, type LogRecord } from "@orkestrator/protocol/logger";
import { setLiveBridgeDiagnostics } from "@orkestrator/protocol/node/bridge-diagnostics";
import { applyLogDetail } from "@orkestrator/protocol/node/log-policy";
import { createRequestLogger, debugLog, flushDebugLogs, isDebugLoggingEnabled } from "./logger.js";

describe("debug event policy", () => {
  const envKeys = ["ORKESTRATOR_LOG_LEVEL", "ORKESTRATOR_BRIDGE_DEBUG"];
  let savedEnv: (string | undefined)[];
  let records: LogRecord[];

  beforeEach(() => {
    savedEnv = envKeys.map((key) => process.env[key]);
    for (const key of envKeys) delete process.env[key];
    setLiveBridgeDiagnostics(undefined);
    flushDebugLogs();
    resetLogger();
    records = [];
    configureLogger({ sink: ({ record }) => record && records.push(record) });
  });

  afterEach(() => {
    flushDebugLogs();
    setLiveBridgeDiagnostics(undefined);
    resetLogger();
    envKeys.forEach((key, index) => {
      if (savedEnv[index] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[index];
    });
  });

  test("log-level-only configuration restores buffered and HTTP debug events", async () => {
    process.env.ORKESTRATOR_LOG_LEVEL = "bridge.diagnostics=debug";
    applyLogDetail({ level: "info", areaLevels: {} });
    expect(isDebugLoggingEnabled()).toBe(true);
    debugLog("[session-manager] SDK event received", { durationMs: 12 });
    const app = new Hono();
    app.use("*", createRequestLogger());
    app.get("/global/health", (context) => context.text("ok"));
    await app.request("/global/health");
    flushDebugLogs();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ area: "bridge.diagnostics", event: "debug-events" });
    expect(JSON.parse(records[0]!.fields!.payload as string)).toMatchObject({
      bridge: "claude",
      events: [
        { event: "[session-manager] SDK event received", count: 1 },
        { event: "http-request", count: 1 },
      ],
    });
  });

  test("already-created loggers follow live levels and the backend switch", () => {
    const event = "[session-manager] SDK event received";
    const recordAndFlush = () => {
      debugLog(event);
      flushDebugLogs();
    };
    recordAndFlush();
    expect(records).toHaveLength(0);
    configureLogger({ areaLevels: { "bridge.diagnostics": "debug" } });
    recordAndFlush();
    expect(records).toHaveLength(1);
    configureLogger({ areaLevels: {} });
    recordAndFlush();
    expect(records).toHaveLength(1);
    setLiveBridgeDiagnostics(true);
    recordAndFlush();
    expect(records).toHaveLength(2);
    setLiveBridgeDiagnostics(false);
    recordAndFlush();
    expect(records).toHaveLength(2);
  });
});

describe("createRequestLogger", () => {
  test("follows the setting per request, so a change needs no restart", async () => {
    const records: unknown[] = [];
    let enabled = false;
    const app = new Hono();
    app.use(
      "*",
      createRequestLogger(
        () => enabled,
        (...parts) => {
          records.push(parts);
        },
      ),
    );
    app.get("/global/health", (context) => context.text("ok"));

    expect((await app.request("/global/health")).status).toBe(200);
    expect(records).toEqual([]);
    enabled = true;
    await app.request("/global/health");
    expect(records).toHaveLength(1);
    enabled = false;
    await app.request("/global/health");
    expect(records).toHaveLength(1);
  });

  test("never records URL paths or query parameters", async () => {
    const token = "live-bridge-credential";
    const records: unknown[] = [];
    const app = new Hono();
    app.use(
      "*",
      createRequestLogger(
        () => true,
        (...parts) => {
          records.push(parts);
        },
      ),
    );
    app.get("/event/subscribe", (context) => context.text("ok"));

    await app.request(`/event/subscribe?token=${token}&cursor=4`);

    expect(JSON.stringify(records)).not.toContain(token);
    expect(JSON.stringify(records)).not.toContain("/event/subscribe");
    expect(JSON.stringify(records)).not.toContain("cursor");
    expect(records).toEqual([["http-request", expect.objectContaining({ httpStatus: 200 })]]);
  });
});
