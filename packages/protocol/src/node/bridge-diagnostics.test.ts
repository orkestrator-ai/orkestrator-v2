import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bridgeDebugEnabled,
  BridgeRunDiagnostics,
  createBridgeDiagnostics,
  createBufferedDebugLogger,
  safeDiagnosticMetrics,
  setLiveBridgeDiagnostics,
} from "./bridge-diagnostics.js";

describe("shared bridge diagnostics", () => {
  test("one app setting controls every bridge and overrides inherited flags", () => {
    for (const bridge of ["claude", "codex", "cursor", "pi", "acp"] as const) {
      const legacy = `${bridge.toUpperCase()}_BRIDGE_DEBUG`;
      expect(bridgeDebugEnabled(bridge, {})).toBe(false);
      expect(bridgeDebugEnabled(bridge, { [legacy]: "1" })).toBe(true);
      expect(bridgeDebugEnabled(bridge, { ORKESTRATOR_BRIDGE_DEBUG: "0", [legacy]: "1" })).toBe(
        false,
      );
      expect(bridgeDebugEnabled(bridge, { ORKESTRATOR_BRIDGE_DEBUG: "1", [legacy]: "0" })).toBe(
        true,
      );
      expect(bridgeDebugEnabled(bridge, { ORKESTRATOR_BRIDGE_DEBUG: "true" })).toBe(false);
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
      (line) => lines.push(line),
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
      expect(lines[0]).toContain('"durationMs":12');
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
      (line) => lines.push(line),
    );
    disabled.record("event-1");
    disabled.close();
    expect(lines).toHaveLength(0);
    const logger = createBufferedDebugLogger(
      "claude",
      labels,
      () => true,
      (line) => lines.push(line),
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
      (line) => lines.push(line),
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
});

describe("diagnostics that follow a live setting", () => {
  const state = { id: "session-1", status: "running" };
  const originalInfo = console.info;
  const originalFlag = process.env.ORKESTRATOR_BRIDGE_DEBUG;
  let lines: string[] = [];

  beforeEach(() => {
    lines = [];
    console.info = (line: unknown) => lines.push(String(line));
    delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
    setLiveBridgeDiagnostics(undefined);
  });

  afterEach(() => {
    console.info = originalInfo;
    if (originalFlag === undefined) delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
    else process.env.ORKESTRATOR_BRIDGE_DEBUG = originalFlag;
    setLiveBridgeDiagnostics(undefined);
  });

  const parsed = () => lines.map((line) => JSON.parse(line.slice("[bridge-diagnostics] ".length)));

  test("a scope opened while off writes nothing, and counts anyway", () => {
    const scope = createBridgeDiagnostics("pi", state);
    scope.activity("message_update");
    scope.tool("call-1", "shell", "started");
    scope.report("heartbeat");
    expect(lines).toEqual([]);
    scope.close();
    expect(lines).toEqual([]);
  });

  test("turning detail on mid-turn reports the turn so far at once", () => {
    const scope = createBridgeDiagnostics("pi", state);
    scope.activity("message_update");
    scope.tool("call-1", "shell", "started");
    setLiveBridgeDiagnostics(true);
    const [snapshot] = parsed();
    expect(snapshot.event).toBe("heartbeat");
    expect(snapshot.deltaCount).toBe(1);
    expect(snapshot.pendingToolCount).toBe(1);
    expect(snapshot.pendingTools[0].kind).toBe("shell");
    scope.close();
    expect(parsed().at(-1).event).toBe("closed");
  });

  test("turning detail off stops a scope mid-turn; turning it on again resumes", () => {
    setLiveBridgeDiagnostics(true);
    const scope = createBridgeDiagnostics("pi", state);
    expect(parsed().map((entry) => entry.event)).toEqual(["send-started"]);
    setLiveBridgeDiagnostics(false);
    scope.report("heartbeat");
    expect(lines).toHaveLength(1);
    setLiveBridgeDiagnostics(true);
    expect(lines).toHaveLength(2);
    // Already on: a repeated setting is not a second snapshot.
    setLiveBridgeDiagnostics(true);
    expect(lines).toHaveLength(2);
    scope.close();
  });

  test("a closed scope is not reported again", () => {
    const scope = createBridgeDiagnostics("pi", state);
    scope.close();
    setLiveBridgeDiagnostics(true);
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
