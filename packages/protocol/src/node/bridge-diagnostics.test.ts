import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bridgeDebugEnabled,
  BridgeRunDiagnostics,
  createBridgeDiagnostics,
  createBufferedDebugLogger,
  MAX_BRIDGE_DIAGNOSTIC_BYTES,
  safeDiagnosticMetrics,
  setLiveBridgeDiagnostics,
  writeBridgeDiagnostic,
} from "./bridge-diagnostics.js";
import { configureLogger, emitLogRecord, parseLogRecordLine } from "../logger.js";
import { captureLogs } from "../testing/log-capture.js";
import { bridgeDiagnosticPayloads } from "../testing/bridge-diagnostic-lines.js";

describe("shared bridge diagnostics", () => {
  test("one app setting controls every bridge; per-bridge flags are not read", () => {
    for (const bridge of ["claude", "codex", "cursor", "pi", "acp"] as const) {
      const retired = `${bridge.toUpperCase()}_BRIDGE_DEBUG`;
      expect(bridgeDebugEnabled(bridge, {})).toBe(false);
      expect(bridgeDebugEnabled(bridge, { [retired]: "1" })).toBe(false);
      expect(bridgeDebugEnabled(bridge, { ORKESTRATOR_BRIDGE_DEBUG: "1" })).toBe(true);
      expect(bridgeDebugEnabled(bridge, { ORKESTRATOR_BRIDGE_DEBUG: "0", [retired]: "1" })).toBe(
        false,
      );
      expect(bridgeDebugEnabled(bridge, { ORKESTRATOR_BRIDGE_DEBUG: "true" })).toBe(false);
      expect(bridgeDebugEnabled(bridge, { ORKESTRATOR_BRIDGE_DEBUG: " 1 " })).toBe(true);
      for (const off of ["0", "false", "off", "no", " Off "]) {
        expect(bridgeDebugEnabled(bridge, { ORKESTRATOR_BRIDGE_DEBUG: off })).toBe(false);
      }
    }
  });

  test("health snapshots retain transport evidence but drop content, paths and errors", () => {
    expect(
      safeDiagnosticMetrics({
        pendingRequests: 4,
        generation: 3,
        notificationQueueDepth: 7,
        state: "ready",
        circuitOpen: false,
        lastError: "SECRET",
        codexHome: "/SECRET",
        notificationsReceived: 99,
        requestsSent: NaN,
        stderr: "SECRET",
        custom: "SECRET",
      }),
    ).toEqual({
      pendingRequests: 4,
      generation: 3,
      notificationQueueDepth: 7,
      state: "ready",
      circuitOpen: false,
      notificationsReceived: 99,
    });
  });

  test("debug events are batched and only source-defined labels and scalar metrics survive", () => {
    const lines: string[] = [];
    const logger = createBufferedDebugLogger(
      "claude",
      new Set(["result"]),
      () => true,
      ({ payload }) => lines.push(payload),
    );
    try {
      for (let i = 0; i < 10000; i++)
        logger.record(
          "result",
          { result: "SECRET", durationMs: 12, config: { token: "SECRET" } },
          new Error("SECRET"),
          "SECRET",
        );
      logger.record("SECRET", { result: "SECRET" });
      expect(lines).toHaveLength(0);
      logger.flush();
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("SECRET");
      expect(lines[0]).toContain('"count":10000');
      expect(lines[0]).toContain('"durationMs":{"n":10000,"min":12,"max":12,"sum":120000}');
      expect(lines[0]).toContain('"dropped":1');
      logger.flush();
      expect(lines).toHaveLength(1);
    } finally {
      logger.close();
    }
  });

  test("disabled loggers do not emit; event queues and emitted entries are bounded", () => {
    const lines: string[] = [];
    const labels = new Set(Array.from({ length: 100 }, (_, i) => `event-${i}`));
    const disabled = createBufferedDebugLogger(
      "claude",
      labels,
      () => false,
      ({ payload }) => lines.push(payload),
    );
    disabled.record("event-1");
    disabled.close();
    expect(lines).toHaveLength(0);
    const logger = createBufferedDebugLogger(
      "claude",
      labels,
      () => true,
      ({ payload }) => lines.push(payload),
    );
    for (const label of labels) logger.record(label, { durationMs: 5 });
    logger.close();
    expect(lines[0]).toContain('"dropped":84');
    expect(Buffer.byteLength(lines[0]!)).toBeLessThan(8300);
    const count = lines.length;
    logger.record("event-1");
    logger.flush();
    expect(lines.length).toBe(count);
  });

  test("periodic metrics are sampled afresh without any UI, and stop on close", () => {
    let pendingRequests = 2;
    const lines: string[] = [];
    const diagnostics = new BridgeRunDiagnostics(
      "acp",
      { id: "SECRET" },
      () => 0,
      ({ payload }) => lines.push(payload),
      60000,
      () => ({ pendingRequests, token: "SECRET" }),
    );
    diagnostics.count("stderrBytes", 123);
    diagnostics.checkpoint("attached");
    pendingRequests = 5;
    diagnostics.report("heartbeat");
    expect(lines.at(-1)).toContain('"pendingRequests":5');
    expect(lines.at(-1)).toContain('"stderrBytes":123');
    expect(lines.join("\n")).not.toContain("SECRET");
    diagnostics.close();
    const count = lines.length;
    diagnostics.report("heartbeat");
    expect(lines).toHaveLength(count);
  });

  describe("through the shared logger", () => {
    test("an entry is info in the bridge.diagnostics area and its text keeps the searched tag", () => {
      const capture = captureLogs();
      try {
        const diagnostics = new BridgeRunDiagnostics("codex", { id: "session" });
        diagnostics.close();
        const [record] = capture.records();
        expect(record).toMatchObject({
          level: "info",
          area: "bridge.diagnostics",
          event: "send-started",
          fields: { bridge: "codex" },
        });
        expect(capture.lines[0]).toStartWith(
          '[bridge-diagnostics] send-started bridge=codex payload="',
        );
        expect(bridgeDiagnosticPayloads(capture.lines).map((payload) => payload.event)).toEqual([
          "send-started",
          "closed",
        ]);
      } finally {
        capture.restore();
      }
    });

    test("a snapshot at the bound is written whole, through a relay too; one over it becomes an overflow record", () => {
      const capture = captureLogs();
      try {
        configureLogger({ format: "json" });
        const prefix = '{"bridge":"cursor","event":"sdk-snapshot","pad":"';
        const whole = `${prefix}${"x".repeat(MAX_BRIDGE_DIAGNOSTIC_BYTES - prefix.length - 2)}"}`;
        expect(Buffer.byteLength(whole)).toBe(MAX_BRIDGE_DIAGNOSTIC_BYTES);
        writeBridgeDiagnostic({ bridge: "cursor", event: "sdk-snapshot", payload: whole });
        const relayed = parseLogRecordLine(capture.lines[0]!);
        expect(relayed?.fields?.payload).toBe(whole);
        emitLogRecord(relayed!);
        expect(capture.records()[1]?.fields?.payload).toBe(whole);

        const labels = Array.from({ length: 16 }, (_, index) => `${"e".repeat(150)}-${index}`);
        const logger = createBufferedDebugLogger("claude", new Set(labels), () => true);
        const metrics = Object.fromEntries(
          [
            "httpStatus",
            "durationMs",
            "costUSD",
            "answerCount",
            "sdkMessageCount",
            "mcpServerCount",
            "pluginCount",
            "slashCommandCount",
            "subscriberCount",
            "revision",
            "pendingRequests",
            "pendingApprovals",
            "generation",
            "restartCount",
            "notificationQueueDepth",
            "notificationQueueHighWaterMark",
            "unknownNotifications",
            "unknownServerRequests",
            "requestsSent",
            "responsesReceived",
          ].map((name) => [name, 1]),
        );
        for (const label of labels) logger.record(label, metrics);
        logger.close();
        const overflow = capture.records().at(-1)!;
        expect(overflow.event).toBe("snapshot-overflow");
        expect(JSON.parse(overflow.fields!.payload as string)).toMatchObject({
          bridge: "claude",
          event: "snapshot-overflow",
        });
      } finally {
        capture.restore();
      }
    });

    test("a level replaced at runtime applies to an open scope, and an off level builds no snapshot", () => {
      const capture = captureLogs();
      let metricsReads = 0;
      try {
        const diagnostics = new BridgeRunDiagnostics(
          "acp",
          { id: "session" },
          () => 0,
          undefined,
          60_000,
          () => {
            metricsReads += 1;
            return {};
          },
        );
        const logger = createBufferedDebugLogger("acp", new Set(["label"]), () => true);
        expect(capture.records()).toHaveLength(1);
        expect(metricsReads).toBe(1);

        configureLogger({ areaLevels: { "bridge.diagnostics": "warn" } });
        diagnostics.report("heartbeat");
        logger.record("label");
        logger.flush();
        expect(capture.records()).toHaveLength(1);
        expect(metricsReads).toBe(1);

        configureLogger({ areaLevels: {} });
        diagnostics.report("heartbeat");
        logger.record("label");
        logger.flush();
        expect(capture.records().map((record) => record.event)).toEqual([
          "send-started",
          "heartbeat",
          "debug-events",
        ]);
        diagnostics.close();
        logger.close();
      } finally {
        capture.restore();
      }
    });
  });
});

describe("diagnostics that follow a live setting", () => {
  const state = { id: "session-1", status: "running" };
  const originalFlag = process.env.ORKESTRATOR_BRIDGE_DEBUG;
  let capture: ReturnType<typeof captureLogs>;
  let lines: string[] = [];

  beforeEach(() => {
    capture = captureLogs();
    lines = capture.lines;
    delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
    setLiveBridgeDiagnostics(undefined);
  });

  afterEach(() => {
    capture.restore();
    if (originalFlag === undefined) delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
    else process.env.ORKESTRATOR_BRIDGE_DEBUG = originalFlag;
    setLiveBridgeDiagnostics(undefined);
  });

  const parsed = () => bridgeDiagnosticPayloads(lines);

  test("a scope opened with the stream off writes an unchanged look's lifecycle only, and counts anyway", () => {
    const scope = createBridgeDiagnostics("pi", state);
    scope.activity("message_update");
    scope.report("heartbeat");
    expect(parsed().map((entry) => entry.event)).toEqual(["send-started"]);
    scope.close();
    expect(parsed().map((entry) => entry.event)).toEqual(["send-started", "closed"]);
    expect(parsed().at(-1)?.deltaCount).toBe(1);
  });

  test("turning detail on mid-turn reports the turn so far at once", () => {
    const scope = createBridgeDiagnostics("pi", state);
    try {
      scope.activity("message_update");
      scope.tool("call-1", "shell", "started");
      setLiveBridgeDiagnostics(true);
      const snapshot = parsed().at(-1)!;
      expect(snapshot.event).toBe("heartbeat");
      expect(snapshot.deltaCount).toBe(1);
      expect(snapshot.pendingToolCount).toBe(1);
      expect(snapshot.pendingTools[0].kind).toBe("shell");
    } finally {
      scope.close();
    }
    expect(parsed().at(-1)?.event).toBe("closed");
  });

  test("turning detail off stops the stream mid-turn; turning it on again resumes", () => {
    setLiveBridgeDiagnostics(true);
    const scope = createBridgeDiagnostics("pi", state);
    try {
      expect(parsed().map((entry) => entry.event)).toEqual(["send-started"]);
      scope.report("heartbeat");
      expect(lines).toHaveLength(2);
      setLiveBridgeDiagnostics(false);
      scope.report("heartbeat");
      expect(lines).toHaveLength(2);
      setLiveBridgeDiagnostics(true);
      expect(lines).toHaveLength(3);
      // Already on: a repeated setting is not a second snapshot.
      setLiveBridgeDiagnostics(true);
      expect(lines).toHaveLength(3);
    } finally {
      scope.close();
    }
  });

  test("a closed scope is not reported again", () => {
    const scope = createBridgeDiagnostics("pi", state);
    scope.close();
    const count = lines.length;
    setLiveBridgeDiagnostics(true);
    scope.report("heartbeat");
    expect(lines).toHaveLength(count);
  });

  test("bridge.diagnostics at warn writes nothing, lifecycle included", () => {
    configureLogger({ areaLevels: { "bridge.diagnostics": "warn" } });
    const scope = createBridgeDiagnostics("pi", state);
    scope.report("heartbeat");
    scope.close();
    expect(lines).toEqual([]);
  });

  test("a live setting overrides the environment in both directions", () => {
    process.env.ORKESTRATOR_BRIDGE_DEBUG = "1";
    expect(bridgeDebugEnabled("codex")).toBe(true);
    setLiveBridgeDiagnostics(false);
    expect(bridgeDebugEnabled("codex")).toBe(false);
    process.env.ORKESTRATOR_BRIDGE_DEBUG = "0";
    setLiveBridgeDiagnostics(true);
    expect(bridgeDebugEnabled("codex")).toBe(true);
    // An injected environment is a question about that environment, not this process.
    expect(bridgeDebugEnabled("codex", { ORKESTRATOR_BRIDGE_DEBUG: "0" })).toBe(false);
  });

  test("a buffered logger follows the setting from its next event", () => {
    let enabled = false;
    const logger = createBufferedDebugLogger("claude", new Set(["result"]), () => enabled);
    logger.record("result");
    logger.flush();
    expect(lines).toEqual([]);
    enabled = true;
    logger.record("result");
    logger.flush();
    expect(parsed()[0].events[0]).toMatchObject({ event: "result", count: 1 });
    logger.close();
  });
});
