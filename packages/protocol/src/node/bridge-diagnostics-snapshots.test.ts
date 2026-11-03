import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BRIDGE_DIAGNOSTICS_INTERVAL_MS,
  BRIDGE_DIAGNOSTICS_KEEPALIVE_MS,
  BridgeRunDiagnostics,
  bridgeDiagnosticsStreamEnabled,
  COUNTER_CHANGE_THRESHOLDS,
  createBufferedDebugLogger,
  flushBufferedDebugLoggers,
  setLiveBridgeDiagnostics,
  STALL_NO_DELTA_MS,
  STALL_TICK_DELAY_MS,
  STALL_TOOL_PENDING_MS,
} from "./bridge-diagnostics.js";
import { applyBridgeLogPolicy, resetBridgeLogPolicyForTests } from "./bridge-log-policy.js";
import { configureLogger, resetLogger } from "../logger.js";
import { legacyDebugLogDetail, resolveLogDetail } from "../log-policy.js";

const TICK = BRIDGE_DIAGNOSTICS_INTERVAL_MS;
type Snapshot = Record<string, any>;

/**
 * A scope on a fake clock whose timer is driven by hand: `tick()` is what the
 * interval does every minute, so a test decides exactly when a look happens.
 */
function harness(stream: () => boolean = () => false, metrics?: () => Record<string, unknown>) {
  let now = 1_000_000;
  const written: Snapshot[] = [];
  const scope = new BridgeRunDiagnostics(
    "pi",
    { id: "session", status: "running" },
    () => now,
    ({ payload }) => written.push(JSON.parse(payload)),
    TICK,
    metrics,
    stream,
  );
  return {
    scope,
    written,
    events: () => written.map((entry) => entry.event as string),
    advance(ms: number) {
      now += ms;
    },
    /** One timer tick `ms` after the last one, late by `ms - TICK`. */
    tick(ms = TICK) {
      now += ms;
      scope.report("heartbeat");
    },
    /** A healthy stretch of `ms`: a delta every ten seconds and a look every minute. */
    run(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += TICK) {
        for (let at = 0; at < TICK; at += 10_000) {
          now += 10_000;
          scope.activity("message_update");
        }
        scope.report("heartbeat");
      }
    },
  };
}

// An agent running these tests may itself have been launched with the flag on.
const FLAGS = ["ORKESTRATOR_BRIDGE_DEBUG", "PI_BRIDGE_DEBUG"] as const;
const inherited = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of FLAGS) delete process.env[name];
  resetLogger();
  resetBridgeLogPolicyForTests();
});

afterEach(() => {
  for (const name of FLAGS) {
    if (inherited[name] === undefined) delete process.env[name];
    else process.env[name] = inherited[name];
  }
  resetLogger();
  resetBridgeLogPolicyForTests();
});

describe("change-driven snapshots at info", () => {
  test("a healthy turn writes its lifecycle and the keepalive, and no other look", () => {
    const h = harness();
    try {
      h.scope.sent("run-1");
      for (let minute = 0; minute < 9; minute++) {
        h.scope.tool(`call-${minute}`, "shell", "started");
        h.advance(5_000);
        h.scope.activity("tool_execution_end");
        h.scope.tool(`call-${minute}`, "shell", "completed");
        h.tick(TICK - 5_000);
        h.scope.activity("message_update");
      }
      expect(h.events()).toEqual(["send-started", "send-resolved"]);
      h.tick();
      expect(h.events()).toEqual(["send-started", "send-resolved", "heartbeat"]);
      expect(h.written.at(-1)).toMatchObject({ phase: "following", completedTools: 9 });
      // The keepalive counts from the last snapshot written, not the scope's start.
      h.run(BRIDGE_DIAGNOSTICS_KEEPALIVE_MS - TICK);
      expect(h.events()).toHaveLength(3);
      h.run(TICK);
      expect(h.events()).toHaveLength(4);
    } finally {
      h.scope.close();
    }
    expect(h.events().at(-1)).toBe("closed");
  });

  test("no delta for the threshold writes a snapshot at the next look, once", () => {
    const h = harness();
    try {
      h.scope.sent("run-1");
      h.scope.activity("message_update");
      h.tick();
      expect(h.events()).toEqual(["send-started", "send-resolved"]);
      h.tick();
      expect(h.written.at(-1)).toMatchObject({
        event: "heartbeat",
        lastDeltaAgoMs: STALL_NO_DELTA_MS,
      });
      // Nothing changed: the ages are what the last snapshot implies.
      h.tick();
      h.tick();
      expect(h.events()).toHaveLength(3);
      // The stall clearing is written too, so a gap after it means healthy.
      h.scope.activity("message_update");
      h.tick();
      expect(h.events()).toHaveLength(4);
      expect(h.written.at(-1)!.lastDeltaAgoMs).toBe(TICK);
    } finally {
      h.scope.close();
    }
  });

  test("a turn that never produced a delta stalls from its start", () => {
    const h = harness();
    try {
      h.tick();
      expect(h.events()).toEqual(["send-started"]);
      h.tick();
      expect(h.written.at(-1)).toMatchObject({
        event: "heartbeat",
        phase: "sending",
        lastDeltaAgoMs: null,
        elapsedMs: STALL_NO_DELTA_MS,
      });
    } finally {
      h.scope.close();
    }
  });

  test("an idle process scope is not stalled; one waiting on a request is", () => {
    const h = harness();
    try {
      h.scope.checkpoint("attached");
      // Attaching is a phase change, written once; idling after it is not a stall.
      for (let minute = 0; minute < 5; minute++) h.tick();
      expect(h.events()).toEqual(["send-started", "heartbeat"]);
      expect(h.written.at(-1)).toMatchObject({ phase: "attached", pendingToolCount: 0 });
      // A request sent after a long idle spell waits from when it was sent.
      h.scope.tool("request-1", "session/prompt", "started");
      h.tick();
      expect(h.events()).toHaveLength(3);
      expect(h.written.at(-1)).toMatchObject({ pendingToolCount: 1, lastDeltaAgoMs: null });
      h.tick();
      expect(h.events()).toHaveLength(4);
      expect(h.written.at(-1)).toMatchObject({
        phase: "attached",
        pendingToolCount: 1,
        pendingTools: [{ ageMs: STALL_NO_DELTA_MS }],
      });
    } finally {
      h.scope.close();
    }
  });

  test("one tool pending for the threshold writes a snapshot while deltas still arrive", () => {
    const h = harness();
    try {
      h.scope.sent("run-1");
      h.run(TICK);
      h.scope.tool("long-build", "shell", "started");
      h.run(9 * TICK);
      // Only the tool appearing so far: it is a change, not yet a stall.
      expect(h.events()).toEqual(["send-started", "send-resolved", "heartbeat"]);
      expect(h.written.at(-1)!.pendingTools[0].ageMs).toBe(TICK);
      h.run(TICK);
      expect(h.events()).toHaveLength(4);
      expect(h.written.at(-1)!.pendingTools[0].ageMs).toBe(STALL_TOOL_PENDING_MS);
      // Tools that start and finish between two looks leave the pending set unchanged.
      for (let minute = 0; minute < 3; minute++) {
        h.scope.tool(`short-${minute}`, "read", "started");
        h.scope.tool(`short-${minute}`, "read", "completed");
        h.run(TICK);
      }
      expect(h.events()).toHaveLength(4);
      // A second tool is written when it appears and again when it crosses the threshold.
      h.scope.tool("second", "shell", "started");
      h.run(STALL_TOOL_PENDING_MS);
      expect(h.events()).toHaveLength(6);
      expect(h.written.at(-1)!.pendingTools[1].ageMs).toBe(STALL_TOOL_PENDING_MS);
      // The stall clearing is written.
      h.scope.tool("long-build", "shell", "completed");
      h.scope.tool("second", "shell", "completed");
      h.run(TICK);
      expect(h.events()).toHaveLength(7);
      expect(h.written.at(-1)!.pendingToolCount).toBe(0);
    } finally {
      h.scope.close();
    }
  });

  test("a late timer writes a snapshot carrying its delay; a small delay does not", () => {
    const h = harness();
    try {
      h.scope.sent("run-1");
      h.scope.activity("message_update");
      h.tick(TICK + STALL_TICK_DELAY_MS - 1);
      expect(h.events()).toEqual(["send-started", "send-resolved"]);
      h.scope.activity("message_update");
      h.tick(TICK + STALL_TICK_DELAY_MS);
      expect(h.written.at(-1)).toMatchObject({
        event: "heartbeat",
        tickDelayMs: STALL_TICK_DELAY_MS,
      });
    } finally {
      h.scope.close();
    }
  });

  test("consecutive late ticks each preserve their independent delay", () => {
    const h = harness();
    try {
      h.scope.checkpoint("attached");
      h.tick(TICK + STALL_TICK_DELAY_MS);
      h.tick(TICK + 70_000);
      expect(
        h.written.filter((entry) => entry.event === "heartbeat").map((entry) => entry.tickDelayMs),
      ).toEqual([STALL_TICK_DELAY_MS, 70_000]);
    } finally {
      h.scope.close();
    }
  });

  test.each(["sink", "serialization"])(
    "a failed %s retries the unchanged stall on the next look",
    (failure) => {
      let now = 1_000_000;
      let fail = false;
      const written: Snapshot[] = [];
      const state = { id: "session", revision: 0 };
      const scope = new BridgeRunDiagnostics(
        "pi",
        state,
        () => now,
        ({ payload }) => {
          if (fail && failure === "sink") throw new Error("unavailable");
          written.push(JSON.parse(payload));
        },
        TICK,
        undefined,
        () => false,
      );
      try {
        scope.sent("run");
        fail = true;
        // Force JSON.stringify to fail without changing any stall/counter inputs.
        if (failure === "serialization")
          Object.defineProperty(state, "revision", { get: () => 1n, configurable: true });
        now += TICK;
        scope.report("heartbeat");
        now += TICK;
        scope.report("heartbeat");
        expect(written).toHaveLength(2);
        fail = false;
        if (failure === "serialization") Object.defineProperty(state, "revision", { value: 0 });
        now += TICK;
        scope.report("heartbeat");
        expect(written.at(-1)).toMatchObject({ event: "heartbeat", lastDeltaAgoMs: null });
        expect(written).toHaveLength(3);
        now += TICK;
        scope.report("heartbeat");
        expect(written).toHaveLength(3);
      } finally {
        scope.close();
      }
    },
  );

  test("a written overflow record advances the baseline", () => {
    let now = 1_000_000;
    const written: Snapshot[] = [];
    const state = { id: "session", revision: 0 };
    const scope = new BridgeRunDiagnostics(
      "pi",
      state,
      () => now,
      ({ payload }) => written.push(JSON.parse(payload)),
      TICK,
      undefined,
      () => false,
    );
    try {
      // A malformed runtime metadata value still passes through the byte bound.
      Object.defineProperty(state, "revision", { value: "x".repeat(9_000) });
      now += TICK;
      scope.report("heartbeat");
      now += TICK;
      scope.report("heartbeat");
      expect(written.at(-1)).toMatchObject({ event: "snapshot-overflow" });
      expect(written).toHaveLength(2);
      now += TICK;
      scope.report("heartbeat");
      expect(written).toHaveLength(2);
    } finally {
      scope.close();
    }
  });

  test("the production logger's rejected sink write leaves the stall eligible for retry", () => {
    let now = 1_000_000;
    let reject = false;
    const written: Snapshot[] = [];
    configureLogger({
      sink: ({ record }) => {
        if (reject) throw new Error("unavailable");
        written.push(JSON.parse(record!.fields!.payload as string));
      },
    });
    const scope = new BridgeRunDiagnostics(
      "pi",
      { id: "session" },
      () => now,
      undefined,
      TICK,
      undefined,
      () => false,
    );
    try {
      reject = true;
      now += TICK;
      scope.report("heartbeat");
      now += TICK;
      scope.report("heartbeat");
      expect(written).toHaveLength(1);
      reject = false;
      now += TICK;
      scope.report("heartbeat");
      expect(written.map((entry) => entry.event)).toEqual(["send-started", "heartbeat"]);
      now += TICK;
      scope.report("heartbeat");
      expect(written).toHaveLength(2);
    } finally {
      scope.close();
    }
  });

  describe("a change", () => {
    /** A turn that keeps streaming, so no stall signal is involved. */
    function moving() {
      const h = harness();
      h.scope.sent("run-1");
      h.run(TICK);
      expect(h.events()).toEqual(["send-started", "send-resolved"]);
      return h;
    }

    test("of phase is written once; the unchanged phase is not written again", () => {
      const h = moving();
      try {
        h.scope.terminalSettled("resolved");
        h.run(TICK);
        expect(h.events()).toHaveLength(3);
        expect(h.written.at(-1)).toMatchObject({
          event: "heartbeat",
          phase: "draining",
          terminal: "resolved",
        });
        h.run(3 * TICK);
        expect(h.events()).toHaveLength(3);
        h.scope.checkpoint("cancelling");
        h.run(TICK);
        expect(h.events()).toHaveLength(4);
        expect(h.written.at(-1)!.phase).toBe("cancelling");
      } finally {
        h.scope.close();
      }
    });

    test("of the pending tools is written: a tool appearing, being replaced or finishing", () => {
      const h = moving();
      try {
        h.scope.tool("call-1", "shell", "started");
        h.run(TICK);
        expect(h.events()).toHaveLength(3);
        expect(h.written.at(-1)).toMatchObject({ pendingToolCount: 1 });
        // Still pending and under its threshold: nothing new to say.
        h.run(3 * TICK);
        expect(h.events()).toHaveLength(3);
        // Same count, different tool: the set changed.
        h.scope.tool("call-1", "shell", "completed");
        h.scope.tool("call-2", "read", "started");
        h.run(TICK);
        expect(h.events()).toHaveLength(4);
        expect(h.written.at(-1)!.pendingTools).toMatchObject([{ kind: "read" }]);
        h.scope.tool("call-2", "read", "completed");
        h.run(TICK);
        expect(h.events()).toHaveLength(5);
        expect(h.written.at(-1)!.pendingToolCount).toBe(0);
        h.run(TICK);
        expect(h.events()).toHaveLength(5);
      } finally {
        h.scope.close();
      }
    });

    test("of a counter over its threshold is written; under it is not", () => {
      const h = moving();
      try {
        h.scope.count("stderrBytes", COUNTER_CHANGE_THRESHOLDS.stderrBytes - 1);
        h.run(TICK);
        expect(h.events()).toHaveLength(2);
        h.scope.count("stderrBytes", 1);
        h.run(TICK);
        expect(h.events()).toHaveLength(3);
        // The delta is measured from the last snapshot, not from the scope's start.
        h.scope.count("stderrBytes", COUNTER_CHANGE_THRESHOLDS.stderrBytes - 1);
        h.run(TICK);
        expect(h.events()).toHaveLength(3);
        for (const counter of [
          "timeouts",
          "protocolErrors",
          "requestsSent",
          "responsesReceived",
        ] as const) {
          h.scope.count(counter);
          h.run(TICK);
          expect(h.written.at(-1)!.counters[counter]).toBe(1);
        }
        expect(h.events()).toHaveLength(7);
      } finally {
        h.scope.close();
      }
    });

    test("notifications are the delta stream, not a change", () => {
      const h = moving();
      try {
        h.scope.count("notificationsReceived", 10_000);
        h.run(TICK);
        expect(h.events()).toHaveLength(2);
      } finally {
        h.scope.close();
      }
    });

    test("is written during a stall too, and an unchanged stall is not", () => {
      const h = harness();
      try {
        h.scope.sent("run-1");
        h.tick();
        h.tick();
        expect(h.events()).toEqual(["send-started", "send-resolved", "heartbeat"]);
        h.tick();
        expect(h.events()).toHaveLength(3);
        h.scope.tool("call-1", "shell", "started");
        h.tick();
        expect(h.events()).toHaveLength(4);
        expect(h.written.at(-1)).toMatchObject({ pendingToolCount: 1 });
        h.tick();
        expect(h.events()).toHaveLength(4);
      } finally {
        h.scope.close();
      }
    });

    test("an unchanged, moving turn writes nothing between keepalives", () => {
      const h = moving();
      try {
        h.scope.tool("long-call", "task", "started");
        h.run(TICK);
        expect(h.events()).toHaveLength(3);
        h.scope.count("stderrBytes", 100);
        // Short of the keepalive and of the tool's pending threshold.
        h.run(BRIDGE_DIAGNOSTICS_KEEPALIVE_MS - 2 * TICK);
        expect(h.events()).toHaveLength(3);
      } finally {
        h.scope.close();
      }
    });
  });

  test("a scope opened while info was off writes its first look once info is on", () => {
    configureLogger({ areaLevels: { "bridge.diagnostics": "warn" } });
    const h = harness();
    try {
      h.scope.sent("run-1");
      h.scope.activity("message_update");
      h.tick();
      expect(h.events()).toEqual([]);
      configureLogger({ areaLevels: {} });
      h.scope.activity("message_update");
      h.tick();
      expect(h.events()).toEqual(["heartbeat"]);
      h.scope.activity("message_update");
      h.tick();
      expect(h.events()).toEqual(["heartbeat"]);
    } finally {
      h.scope.close();
    }
  });
});

describe("the per-minute stream at debug", () => {
  test("writes every look, changed or not, as before", () => {
    const h = harness(() => true);
    try {
      h.scope.sent("run-1");
      h.run(5 * TICK);
      expect(h.events()).toEqual([
        "send-started",
        "send-resolved",
        "heartbeat",
        "heartbeat",
        "heartbeat",
        "heartbeat",
        "heartbeat",
      ]);
    } finally {
      h.scope.close();
    }
  });

  test("a level changed mid-turn applies to the running turn, up and down", () => {
    const h = harness(() => bridgeDiagnosticsStreamEnabled("pi"));
    try {
      h.scope.sent("run-1");
      h.run(2 * TICK);
      expect(h.events()).toHaveLength(2);
      configureLogger({ areaLevels: { "bridge.diagnostics": "debug" } });
      h.run(2 * TICK);
      expect(h.events()).toHaveLength(4);
      configureLogger({ areaLevels: { bridge: "trace" } });
      h.run(TICK);
      expect(h.events()).toHaveLength(5);
      configureLogger({ areaLevels: {} });
      h.run(2 * TICK);
      expect(h.events()).toHaveLength(5);
    } finally {
      h.scope.close();
    }
  });

  test("the backend's switch applies to the running turn, up and down", () => {
    const h = harness(() => bridgeDiagnosticsStreamEnabled("pi"));
    try {
      h.scope.sent("run-1");
      h.run(TICK);
      expect(h.events()).toHaveLength(2);
      // Turning it on reports the turn at once, then every minute.
      setLiveBridgeDiagnostics(true);
      expect(h.events()).toHaveLength(3);
      h.run(2 * TICK);
      expect(h.events()).toHaveLength(5);
      setLiveBridgeDiagnostics(false);
      h.run(2 * TICK);
      expect(h.events()).toHaveLength(5);
    } finally {
      h.scope.close();
    }
  });

  test("a config saved with debugLogging on before the split keeps the per-minute stream", () => {
    const detail = resolveLogDetail({ debugLogging: true });
    expect(detail).toEqual(legacyDebugLogDetail());
    const answer = applyBridgeLogPolicy({ seq: 1, ...detail });
    expect(answer.body).toMatchObject({ applied: true, diagnostics: true });
    const h = harness(() => bridgeDiagnosticsStreamEnabled("pi"));
    try {
      h.scope.sent("run-1");
      h.run(3 * TICK);
      expect(h.events().filter((event) => event === "heartbeat")).toHaveLength(3);
    } finally {
      h.scope.close();
    }
  });
});

describe("timers", () => {
  test("one unreferenced timer per scope, cleared on close", () => {
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    const created: Array<{ handle: ReturnType<typeof setInterval>; unref: boolean }> = [];
    const cleared: unknown[] = [];
    globalThis.setInterval = ((callback: () => void, ms: number) => {
      const handle = originalSet(callback, ms);
      const entry = { handle, unref: false };
      created.push(entry);
      const unref = handle.unref.bind(handle);
      handle.unref = () => {
        entry.unref = true;
        return unref();
      };
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      cleared.push(handle);
      originalClear(handle);
    }) as typeof clearInterval;
    try {
      const scope = new BridgeRunDiagnostics("codex", { id: "app-server" }, Date.now, () => {});
      expect(created).toHaveLength(1);
      expect(created[0]!.unref).toBe(true);
      scope.close();
      expect(cleared).toEqual([created[0]!.handle]);
    } finally {
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
    }
  });
});

describe("buffered debug logger", () => {
  test("aggregates every call's metrics rather than keeping the last", () => {
    const written: Snapshot[] = [];
    const logger = createBufferedDebugLogger(
      "claude",
      new Set(["http-request", "health"]),
      () => true,
      ({ payload }) => written.push(JSON.parse(payload)),
    );
    try {
      for (const [httpStatus, durationMs] of [
        [200, 10],
        [500, 30],
        [200, 20],
      ])
        logger.record("http-request", { httpStatus, durationMs });
      logger.record("health", { state: "ready", circuitOpen: false });
      logger.record("health", { state: "ready", circuitOpen: true });
      logger.record("health", { state: "failed" });
      logger.flush();
      expect(written[0]!.events).toEqual([
        {
          event: "http-request",
          count: 3,
          metrics: {
            httpStatus: { n: 3, min: 200, max: 500, sum: 900 },
            durationMs: { n: 3, min: 10, max: 30, sum: 60 },
          },
        },
        {
          event: "health",
          count: 3,
          metrics: {
            state: { ready: 2, failed: 1 },
            circuitOpen: { false: 1, true: 1 },
          },
        },
      ]);
      logger.flush();
      expect(written).toHaveLength(1);
    } finally {
      logger.close();
    }
  });

  test("an open logger is flushed at shutdown; a closed one is not flushed again", () => {
    const written: Snapshot[] = [];
    const write = ({ payload }: { payload: string }) => written.push(JSON.parse(payload));
    const open = createBufferedDebugLogger("claude", new Set(["result"]), () => true, write);
    const closed = createBufferedDebugLogger("claude", new Set(["result"]), () => true, write);
    try {
      closed.record("result");
      closed.close();
      expect(written).toHaveLength(1);
      open.record("result", { durationMs: 4 });
      expect(process.listeners("exit")).toContain(flushBufferedDebugLoggers);
      flushBufferedDebugLoggers();
      expect(written).toHaveLength(2);
      expect(written[1]!.events).toEqual([
        { event: "result", count: 1, metrics: { durationMs: { n: 1, min: 4, max: 4, sum: 4 } } },
      ]);
    } finally {
      open.close();
    }
  });

  test("a termination signal flushes and leaves the signal to its other handlers", () => {
    const written: Snapshot[] = [];
    const logger = createBufferedDebugLogger(
      "claude",
      new Set(["result"]),
      () => true,
      ({ payload }) => written.push(JSON.parse(payload)),
    );
    // With another handler present the flush must not raise the signal again.
    let handled = 0;
    const other = () => {
      handled++;
    };
    process.on("SIGTERM", other);
    try {
      logger.record("result");
      process.emit("SIGTERM", "SIGTERM");
      expect(written).toHaveLength(1);
      expect(handled).toBe(1);
    } finally {
      process.off("SIGTERM", other);
      logger.close();
    }
  });
});
