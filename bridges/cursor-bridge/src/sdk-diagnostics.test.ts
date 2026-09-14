import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as sdk from "@cursor/sdk";
import {
  CursorSdkDiagnostics,
  instrumentSdk,
  resetSdkDiagnosticsForTests,
  type SdkDiagnosticSeam,
} from "./sdk-diagnostics.js";
import { CursorRunDiagnostics } from "./run-diagnostics.js";
import { newSessionState } from "./agent-session.js";
import { dispatchPrompt } from "./prompt.js";
import type { SDKAgent } from "@cursor/sdk";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(id = "session-private") {
  let now = 1000;
  const lines: string[] = [];
  const scope = new CursorSdkDiagnostics(
    id,
    () => now,
    (line) => lines.push(line),
  );
  return {
    scope,
    lines,
    advance: (ms: number) => {
      now += ms;
    },
    snapshot: () => {
      scope.report("heartbeat");
      return JSON.parse(lines.at(-1)!.slice("[bridge-diagnostics] ".length));
    },
  };
}

const READ_REQUEST = { execId: "exec-read", message: { case: "readArgs" } };

function vendorExecContext() {
  return {
    get() {
      return undefined;
    },
    set() {
      return this;
    },
    delete() {
      return this;
    },
    with() {
      return this;
    },
    withName() {
      return this;
    },
  };
}

afterAll(() => {
  resetSdkDiagnosticsForTests();
});

describe("Cursor SDK boundary diagnostics", () => {
  test("the pinned Bun export exposes the actual detector and execution controller", () => {
    const hook = Reflect.get(sdk, "__orkestratorDiagnosticsV1");
    expect(typeof hook).toBe("function");
    hook((seam: SdkDiagnosticSeam) => {
      const detector = seam.stallDetectorPrototype;
      for (const name of [
        "startTimer",
        "trackActivity",
        "onServerSentHeartbeat",
        "onClientSentHeartbeat",
        "setPaused",
      ])
        expect(typeof Reflect.get(detector, name)).toBe("function");
      expect(typeof seam.execControllerPrototype.run).toBe("function");
      // Fail on a changed vendor loop: response-ready relies on awaiting the
      // write before advancing the executor iterator. No network/auth needed.
      expect(seam.execControllerPrototype.run.toString()).toContain("clientStream.write");
    });
  });

  test("distinguishes upstream silence, heartbeat-only traffic and stalled handlers", () => {
    const h = harness();
    const detector = {
      lastActivityTime: 1000,
      lastMeaningfulActivityTime: 1000,
      lastServerSentHeartbeatAt: 1000,
      lastClientSentHeartbeatAt: 1000,
      lastInboundMessage: { messageType: "execServerMessage" },
      handlerTracker: {
        handlers: new Map([
          ["execHandler", { state: "started", startedAt: 1000 }],
          [
            "checkpointController",
            { state: "errored", startedAt: 1000, endedAt: 1200, error: "SECRET" },
          ],
        ]),
      },
    };
    h.scope.transport(detector);
    h.scope.transportActivity(detector, "inbound_message", "execServerMessage:readArgs");
    h.advance(60_000);
    expect(h.snapshot().transports[0]).toMatchObject({
      lastInboundAgoMs: 60_000,
      serverHeartbeatAgoMs: 60_000,
      handlers: [
        { name: "execHandler", state: "started", durationMs: 60_000 },
        { name: "checkpointController", state: "errored", durationMs: 200 },
      ],
    });
    detector.lastActivityTime = detector.lastServerSentHeartbeatAt = 61_000;
    h.scope.transportActivity(detector, "inbound_message", "heartbeat");
    expect(h.snapshot().transports[0]).toMatchObject({
      lastInboundAgoMs: 0,
      serverHeartbeatAgoMs: 0,
      lastMeaningfulAgoMs: 60_000,
    });
    expect(h.lines.join("")).not.toContain("SECRET");
    h.scope.close();
  });

  test("dispatch reaches the real patched detector and correlates it with the bridge run", async () => {
    const previous = process.env.ORKESTRATOR_BRIDGE_DEBUG;
    const lines: string[] = [];
    const log = spyOn(console, "info").mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      process.env.ORKESTRATOR_BRIDGE_DEBUG = "1";
      const state = newSessionState();
      state.status = "running";
      const agent = {
        send: async () => {
          Reflect.get(
            sdk,
            "__orkestratorDiagnosticsV1",
          )((seam: SdkDiagnosticSeam) => {
            // Exercise the vendor's real methods without a server or timers.
            const detector = Object.assign(Object.create(seam.stallDetectorPrototype), {
              disposed: true,
              activityHistory: [],
            });
            detector.startTimer();
            detector.trackActivity("inbound_message", "execServerMessage:readArgs");
            detector.onServerSentHeartbeat();
            detector.trackActivity("inbound_message", "heartbeat");
          });
          return {
            id: "private-run-id",
            onDidChangeStatus: () => () => {},
            wait: async () => ({ status: "finished" }),
            async *stream() {},
            cancel: async () => {},
          };
        },
      } as unknown as SDKAgent;
      await (
        await dispatchPrompt(state, agent, { prompt: "private", images: [] })
      ).completion;
      const records = lines.map((line) => JSON.parse(line.slice("[bridge-diagnostics] ".length)));
      const sdkRecord = records.findLast((r) => r.event === "sdk-snapshot");
      const bridgeRecord = records.findLast((r) => r.event === "closed");
      expect(sdkRecord).toMatchObject({
        coverage: "installed",
        transportCount: 1,
        session: bridgeRecord.session,
        run: bridgeRecord.run,
        transports: [{ inboundCount: 2, heartbeatCount: 1, lastInbound: "heartbeat" }],
      });
      expect(lines.join("")).not.toContain("private");
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
      else process.env.ORKESTRATOR_BRIDGE_DEBUG = previous;
    }
  });

  test("tracks a real iterator through execution, blocked response write and completion", async () => {
    const h = harness();
    const result = { privateContents: "SECRET" };
    const toolReady = deferred();
    const wroteResult = deferred();
    const responseReady = deferred();
    let finalized = false;
    class Controller {
      controlledExecManager = {
        handleControlMessage() {},
        async *handle(_ctx: unknown, request: unknown) {
          expect(request).toEqual(READ_REQUEST);
          try {
            await toolReady.promise;
            yield result;
          } finally {
            finalized = true;
          }
        },
      };
      async run() {
        for await (const response of this.controlledExecManager.handle({}, READ_REQUEST)) {
          expect(response).toBe(result);
          responseReady.resolve();
          await wroteResult.promise;
        }
      }
    }
    const restore = instrumentSdk({
      stallDetectorPrototype: { startTimer() {}, trackActivity() {} },
      execControllerPrototype: Controller.prototype,
    });
    try {
      const completion = h.scope.follow(() => new Controller().run());
      expect(h.snapshot()).toMatchObject({
        pendingExecutionCount: 1,
        pendingExecutions: [{ stage: "executing", responses: 0 }],
      });
      toolReady.resolve();
      await responseReady.promise;
      h.advance(60000);
      expect(h.snapshot().pendingExecutions[0]).toMatchObject({
        stage: "response-ready",
        stageAgeMs: 60000,
        responses: 1,
      });
      wroteResult.resolve();
      await completion;
      expect(finalized).toBe(true);
      expect(h.snapshot()).toMatchObject({
        executionsCompleted: 1,
        pendingExecutionCount: 0,
        recentExecutions: [
          { stage: "completed", kind: "readArgs", id: expect.stringMatching(/^[0-9a-f]{16}$/) },
        ],
      });
      expect(h.lines.join("")).not.toContain("SECRET");
    } finally {
      toolReady.resolve();
      wroteResult.resolve();
      restore();
      h.scope.close();
    }
  });

  test("preserves failures and iterator cancellation, isolates concurrent turns", async () => {
    const a = harness("a");
    const b = harness("b");
    const error = new Error("SECRET failure");
    let cleanup = 0;
    class Controller {
      controlledExecManager = {
        handleControlMessage() {},
        async *handle(_ctx: unknown, request: unknown) {
          expect(request).toEqual(READ_REQUEST);
          try {
            yield 42;
            throw error;
          } finally {
            cleanup++;
          }
        },
      };
      async run(cancel: unknown) {
        for await (const value of this.controlledExecManager.handle({}, READ_REQUEST)) {
          if (cancel) break;
          expect(value).toBe(42);
        }
      }
    }
    const restore = instrumentSdk({
      stallDetectorPrototype: { startTimer() {}, trackActivity() {} },
      execControllerPrototype: Controller.prototype,
    });
    try {
      await Promise.all([
        expect(a.scope.follow(() => new Controller().run(false))).rejects.toBe(error),
        b.scope.follow(() => new Controller().run(true)),
      ]);
      expect(a.snapshot()).toMatchObject({
        executionsFailed: 1,
        recentExecutions: [{ stage: "failed" }],
      });
      expect(b.snapshot()).toMatchObject({
        executionsFailed: 0,
        recentExecutions: [{ stage: "closed" }],
      });
      expect(cleanup).toBe(2);
      expect(a.lines.join("") + b.lines.join("")).not.toContain("SECRET");
    } finally {
      restore();
      a.scope.close();
      b.scope.close();
    }
  });

  test("bounds hostile metadata and releases observation at turn closure", () => {
    const h = harness();
    const secret = "SECRET credential /private/path prompt text";
    const updates = [];
    for (let i = 0; i < 300; i++) {
      h.scope.transport({ lastInboundMessage: { messageType: secret }, ctx: { secret } });
      updates.push(
        h.scope.execution({ execId: secret + i, message: { case: secret, value: { secret } } }),
      );
    }
    expect(h.snapshot()).toMatchObject({
      pendingExecutionCount: 128,
      droppedExecutions: 172,
      transportCount: 16,
      droppedTransports: 284,
    });
    expect(h.snapshot().pendingExecutions).toHaveLength(8);
    for (const update of updates) update("completed");
    expect(h.snapshot().recentExecutions).toHaveLength(8);
    expect(h.lines.join("")).not.toContain(secret);
    for (const line of h.lines) expect(Buffer.byteLength(line)).toBeLessThan(8300);
    h.scope.close();
    const count = h.lines.length;
    h.scope.execution({});
    h.scope.report("heartbeat");
    expect(h.lines.length).toBe(count);
  });

  test("silent background turns emit SDK snapshots on the existing timer", async () => {
    const lines: string[] = [];
    const diagnostic = new CursorRunDiagnostics(
      newSessionState(),
      Date.now,
      (line) => lines.push(line),
      5,
    );
    try {
      const deadline = Date.now() + 1000;
      while (!lines.some((line) => line.includes('"boundary":"heartbeat"'))) {
        if (Date.now() > deadline) throw new Error("Missing background SDK snapshot");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      diagnostic.close();
      const count = lines.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(lines.length).toBe(count);
    } finally {
      diagnostic.close();
    }
  });

  test("sink failures never escape diagnostic callbacks", () => {
    const scope = new CursorSdkDiagnostics("session", Date.now, () => {
      throw new Error("unavailable");
    });
    expect(() => scope.report("heartbeat")).not.toThrow();
    scope.close();
  });

  test("dispatch follows a real patched ExecController.run and records the request", async () => {
    const previous = process.env.ORKESTRATOR_BRIDGE_DEBUG;
    const lines: string[] = [];
    const log = spyOn(console, "info").mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      process.env.ORKESTRATOR_BRIDGE_DEBUG = "1";
      const state = newSessionState();
      state.status = "running";
      const writes: unknown[] = [];
      const agent = {
        send: async () => {
          const hook = Reflect.get(sdk, "__orkestratorDiagnosticsV1") as (
            install: (seam: SdkDiagnosticSeam) => unknown,
          ) => unknown;
          expect(typeof hook).toBe("function");
          await Promise.resolve(
            hook((seam) => {
              const detector = Object.assign(Object.create(seam.stallDetectorPrototype), {
                disposed: true,
                activityHistory: [],
              });
              detector.startTimer();
              detector.trackActivity("inbound_message", "execServerMessage:readArgs");
              const controller = Object.create(seam.execControllerPrototype) as {
                serverStream: AsyncIterable<unknown>;
                clientStream: { write: (value: unknown) => Promise<void> };
                controlledExecManager: {
                  handleControlMessage: (...input: unknown[]) => void;
                  handle: (ctx: unknown, request: unknown) => AsyncIterable<unknown>;
                };
                run: (ctx: unknown) => Promise<void>;
              };
              controller.serverStream = (async function* () {
                yield READ_REQUEST;
              })();
              controller.clientStream = {
                write: async (value) => {
                  writes.push(value);
                },
              };
              controller.controlledExecManager = {
                handleControlMessage() {},
                async *handle(_ctx, request) {
                  expect(request).toEqual(READ_REQUEST);
                  yield { ok: true };
                },
              };
              return controller.run(vendorExecContext());
            }),
          ).catch(() => undefined);
          return {
            id: "private-run-id",
            onDidChangeStatus: () => () => {},
            wait: async () => ({ status: "finished" }),
            async *stream() {},
            cancel: async () => {},
          };
        },
      } as unknown as SDKAgent;
      await (
        await dispatchPrompt(state, agent, { prompt: "private", images: [] })
      ).completion;
      expect(writes).toEqual([{ ok: true }]);
      const records = lines.map((line) => JSON.parse(line.slice("[bridge-diagnostics] ".length)));
      const sdkRecord = records.findLast((r) => r.event === "sdk-snapshot");
      expect(sdkRecord).toMatchObject({
        coverage: "installed",
        transportCount: 1,
        executionsCompleted: 1,
        recentExecutions: [
          { kind: "readArgs", stage: "completed", id: expect.stringMatching(/^[0-9a-f]{16}$/) },
        ],
      });
      expect(lines.join("")).not.toContain("private");
      expect(lines.join("")).not.toContain("exec-read");
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
      else process.env.ORKESTRATOR_BRIDGE_DEBUG = previous;
    }
  });

  test("a reused controller attributes the second turn and restores its manager", async () => {
    const first = harness("first");
    const second = harness("second");
    const original = {
      handleControlMessage() {},
      async *handle(_ctx: unknown, request: unknown) {
        expect(request).toEqual(READ_REQUEST);
        yield 1;
      },
    };
    class Controller {
      controlledExecManager = original;
      async run() {
        for await (const response of this.controlledExecManager.handle({}, READ_REQUEST)) {
          expect(response).toBe(1);
        }
      }
    }
    const restore = instrumentSdk({
      stallDetectorPrototype: { startTimer() {}, trackActivity() {} },
      execControllerPrototype: Controller.prototype,
    });
    const controller = new Controller();
    try {
      await first.scope.follow(() => controller.run());
      expect(controller.controlledExecManager).toBe(original);
      first.scope.close();
      await second.scope.follow(() => controller.run());
      expect(controller.controlledExecManager).toBe(original);
      expect(second.snapshot()).toMatchObject({
        executionsCompleted: 1,
        recentExecutions: [{ kind: "readArgs", stage: "completed" }],
      });
      const closedCount = first.lines.length;
      first.scope.report("heartbeat");
      expect(first.lines.length).toBe(closedCount);
    } finally {
      restore();
      first.scope.close();
      second.scope.close();
    }
  });

  test("install reports coverage unavailable against a seam-less module", () => {
    resetSdkDiagnosticsForTests({});
    try {
      const h = harness("unavailable");
      expect(h.snapshot()).toMatchObject({
        coverage: "unavailable",
        transportCount: 0,
        executionsStarted: 0,
      });
      h.scope.close();
    } finally {
      resetSdkDiagnosticsForTests();
    }
  });

  test("install reports coverage unavailable when the hook or seam throws", () => {
    resetSdkDiagnosticsForTests({
      __orkestratorDiagnosticsV1: () => {
        throw new Error("hook failed");
      },
    });
    try {
      expect(harness("hook-throws").snapshot().coverage).toBe("unavailable");
    } finally {
      resetSdkDiagnosticsForTests();
    }
    resetSdkDiagnosticsForTests({
      __orkestratorDiagnosticsV1: (install: (seam: SdkDiagnosticSeam) => () => void) =>
        install({
          stallDetectorPrototype: {} as SdkDiagnosticSeam["stallDetectorPrototype"],
          execControllerPrototype: {} as SdkDiagnosticSeam["execControllerPrototype"],
        }),
    });
    try {
      expect(harness("bad-seam").snapshot().coverage).toBe("unavailable");
    } finally {
      resetSdkDiagnosticsForTests();
    }
  });

  test("instrumentSdk rejects a prototype that lacks the expected methods", () => {
    expect(() =>
      instrumentSdk({
        stallDetectorPrototype: {} as SdkDiagnosticSeam["stallDetectorPrototype"],
        execControllerPrototype: {} as SdkDiagnosticSeam["execControllerPrototype"],
      }),
    ).toThrow("Unsupported Cursor diagnostic seam");
  });
});
