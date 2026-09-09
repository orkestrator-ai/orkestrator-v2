import { describe, expect, test } from "bun:test";
import {
  bridgeDebugEnabled,
  BridgeRunDiagnostics,
  createBufferedDebugLogger,
  safeDiagnosticMetrics,
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
    const logger = createBufferedDebugLogger("claude", new Set(["result"]), true, (line) =>
      lines.push(line),
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
    const disabled = createBufferedDebugLogger("claude", labels, false, (line) => lines.push(line));
    disabled.record("event-1");
    disabled.close();
    expect(lines).toHaveLength(0);
    const logger = createBufferedDebugLogger("claude", labels, true, (line) => lines.push(line));
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
