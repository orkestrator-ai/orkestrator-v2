import { bridgeDiagnosticPayload } from "@orkestrator/protocol/testing/bridge-diagnostic-lines";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { setLiveBridgeDiagnostics } from "@orkestrator/protocol/node/bridge-diagnostics";
import type { SDKAgent } from "@cursor/sdk";
import { newSessionState } from "./agent-session.js";
import { createRunDiagnostics, CursorRunDiagnostics } from "./run-diagnostics.js";
import { resetSdkDiagnosticsForTests } from "./sdk-diagnostics.js";
import { dispatchPrompt, followRun, type FollowableRun } from "./prompt.js";

afterAll(() => {
  resetSdkDiagnosticsForTests();
});

function harness() {
  let now = 1000;
  const lines: string[] = [];
  const state = newSessionState();
  state.status = "running";
  state.promptSequence = 1;
  const diagnostics = new CursorRunDiagnostics(
    state,
    () => now,
    ({ payload }) => lines.push(payload),
  );
  return {
    state,
    diagnostics,
    lines,
    advance: (ms: number) => {
      now += ms;
    },
    last: () => JSON.parse(lines.findLast((line) => !line.includes('"event":"sdk-'))!),
  };
}

describe("Cursor stall diagnostics", () => {
  test("the base constructor can emit before the SDK field exists", () => {
    const lines: string[] = [];
    const diagnostics = new CursorRunDiagnostics(newSessionState(), Date.now, ({ payload }) =>
      lines.push(payload),
    );
    try {
      const records = lines.map((line) => JSON.parse(line));
      expect(records[0]).toMatchObject({ event: "send-started" });
      expect(records[0]).not.toHaveProperty("coverage");
      expect(records.some((record) => record.event === "sdk-snapshot")).toBe(true);
      expect(records.find((record) => record.event === "sdk-snapshot")).toMatchObject({
        event: "sdk-snapshot",
        boundary: "send-started",
      });
    } finally {
      diagnostics.close();
    }
  });

  test("the stream and SDK snapshots are off by default", () => {
    const previousShared = process.env.ORKESTRATOR_BRIDGE_DEBUG;
    try {
      delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
      const lines: string[] = [];
      const previousInfo = console.info;
      console.info = (line: unknown) => lines.push(String(line));
      try {
        const scope = createRunDiagnostics(newSessionState());
        scope.report("heartbeat");
        scope.close();
        // Lifecycle only: no per-minute look and no SDK snapshot.
        expect(lines.map((line) => bridgeDiagnosticPayload(line)?.event)).toEqual([
          "send-started",
          "closed",
        ]);
      } finally {
        console.info = previousInfo;
      }
    } finally {
      if (previousShared === undefined) delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
      else process.env.ORKESTRATOR_BRIDGE_DEBUG = previousShared;
    }
  });

  test("distinguishes partial calls, started tools and nested activity without a renderer", () => {
    const h = harness();
    try {
      h.diagnostics.sent("run-1");
      h.diagnostics.delta({
        type: "partial-tool-call",
        callId: "shell-1",
        toolCall: { type: "shell" },
      });
      h.diagnostics.delta({
        type: "tool-call-started",
        callId: "task-1",
        toolCall: { type: "task" },
      });
      h.advance(30_000);
      h.diagnostics.delta({
        type: "tool-call-delta",
        taskUpdate: { type: "thinking-delta", text: "private" },
      });
      h.diagnostics.streamEvent();
      const before = h.lines.length;
      h.advance(90_000);
      h.diagnostics.report("heartbeat");
      expect(h.lines.length).toBe(before + 2);
      expect(h.last()).toMatchObject({
        phase: "following",
        lastDeltaAgoMs: 90_000,
        lastStreamAgoMs: 90_000,
        lastNestedDeltaAgoMs: 90_000,
        terminal: "pending",
        pendingToolCount: 2,
        tickDelayMs: 60_000,
        pendingTools: [
          { kind: "shell", stage: "partial", ageMs: 120_000 },
          { kind: "task", stage: "started", ageMs: 120_000 },
        ],
      });
      h.diagnostics.delta({
        type: "tool-call-started",
        callId: "shell-1",
        toolCall: { type: "shell" },
      });
      h.diagnostics.delta({
        type: "tool-call-completed",
        callId: "task-1",
        toolCall: { type: "task" },
      });
      h.diagnostics.report("heartbeat");
      expect(h.last()).toMatchObject({
        pendingToolCount: 1,
        completedTools: 1,
        pendingTools: [{ kind: "shell", stage: "started", ageMs: 120_000 }],
      });
    } finally {
      h.diagnostics.close();
    }
  });

  test("bounds pending state and never emits provider content or raw identifiers", () => {
    const h = harness();
    try {
      const secret = "SECRET /private/file command contents credential";
      h.state.id = secret;
      h.diagnostics.sent(secret);
      for (let i = 0; i < 300; i++)
        h.diagnostics.delta({
          type: "tool-call-started",
          callId: `${secret}${i}`,
          toolCall: { type: secret, args: { command: secret }, result: { error: secret } },
        });
      h.diagnostics.delta({ type: secret, text: secret });
      h.diagnostics.delta({ type: "tool-call-started", callId: "x".repeat(100_000) });
      h.diagnostics.report("heartbeat");
      expect(h.last()).toMatchObject({
        pendingToolCount: 128,
        untrackedTools: 173,
        lastUpdate: "tool-call-started",
      });
      expect(h.last().pendingTools).toHaveLength(8);
      expect(h.lines.join("\n")).not.toContain(secret);
      expect(h.last()).not.toHaveProperty("event", "sdk-snapshot");
      expect(h.lines.findLast((line) => !line.includes('"event":"sdk-'))!.length).toBeLessThan(
        2500,
      );
    } finally {
      h.diagnostics.close();
    }
  });

  test("records terminal-with-open-stream and closes its timer when the stream drains", async () => {
    const h = harness();
    let closeStream!: () => void;
    const streamClosed = new Promise<void>((resolve) => {
      closeStream = resolve;
    });
    const run: FollowableRun = {
      wait: async () => ({ status: "finished" }),
      cancel: async () => {},
      async *stream() {
        yield { type: "thinking", text: "private" };
        await streamClosed;
      },
    };
    try {
      h.diagnostics.sent("run-1");
      const completion = followRun(
        h.state,
        run,
        1,
        { prompt: "private", images: [] },
        1000,
        100,
        h.diagnostics,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.diagnostics.report("heartbeat");
      expect(h.last()).toMatchObject({
        phase: "draining",
        terminal: "resolved",
        stream: "pending",
        streamCount: 1,
      });
      closeStream();
      await completion;
      expect(h.last()).toMatchObject({ event: "closed", terminal: "resolved", stream: "resolved" });
      const count = h.lines.length;
      h.diagnostics.report("heartbeat");
      expect(h.lines.length).toBe(count);
    } finally {
      closeStream();
      h.diagnostics.close();
    }
  });

  test("reports stream errors and cancellation rejection without logging error text", async () => {
    const h = harness();
    try {
      await h.diagnostics.cancel(
        {
          cancel: async () => {
            throw new Error("SECRET");
          },
        },
        "user",
      );
      expect(h.last()).toMatchObject({ cancellation: "rejected", cancelReason: "user" });
      await followRun(
        h.state,
        {
          async *stream() {
            yield {};
            throw new Error("SECRET");
          },
          wait: async () => ({ status: "error" }),
          cancel: async () => {},
        },
        1,
        { prompt: "SECRET", images: [] },
        1000,
        100,
        h.diagnostics,
      );
      expect(h.last()).toMatchObject({ event: "closed", stream: "rejected" });
      expect(h.lines.join("\n")).not.toContain("SECRET");
    } finally {
      h.diagnostics.close();
    }
  });

  test("diagnostic sink failure cannot break a turn", () => {
    const diagnostics = new CursorRunDiagnostics(newSessionState(), Date.now, () => {
      throw new Error("sink unavailable");
    });
    expect(() => diagnostics.close()).not.toThrow();
  });

  test("the timer reports a silent run without subscribers and stops after closure", async () => {
    const lines: string[] = [];
    const diagnostics = new CursorRunDiagnostics(
      newSessionState(),
      Date.now,
      ({ payload }) => lines.push(payload),
      5,
    );
    try {
      const deadline = Date.now() + 1000;
      while (!lines.some((line) => line.includes('"event":"heartbeat"'))) {
        if (Date.now() > deadline) throw new Error("No diagnostic heartbeat");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      diagnostics.close();
      const count = lines.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(lines.length).toBe(count);
    } finally {
      diagnostics.close();
    }
  });

  test("dispatch wires the debug gate, interaction updates and send failure cleanup", async () => {
    const previous = process.env.ORKESTRATOR_BRIDGE_DEBUG;
    const lines: string[] = [];
    const log = spyOn(console, "info").mockImplementation((line) => {
      lines.push(JSON.stringify(bridgeDiagnosticPayload(String(line))));
    });
    try {
      process.env.ORKESTRATOR_BRIDGE_DEBUG = "1";
      const state = newSessionState();
      state.status = "running";
      const agent = {
        send: async (_input: unknown, options: { onDelta: (value: unknown) => void }) => {
          options.onDelta({
            update: {
              type: "partial-tool-call",
              callId: "private-id",
              toolCall: { type: "shell", args: { command: "PRIVATE COMMAND" } },
            },
          });
          return {
            id: "run-id",
            onDidChangeStatus: () => () => {},
            wait: async () => ({ status: "finished" }),
            async *stream() {},
            cancel: async () => {},
          };
        },
      } as unknown as SDKAgent;
      const handle = await dispatchPrompt(state, agent, { prompt: "PRIVATE PROMPT", images: [] });
      await handle.completion;
      expect(lines.some((line) => line.includes('"stage":"partial"'))).toBe(true);
      expect(lines.findLast((line) => !line.includes('"event":"sdk-'))).toContain(
        '"event":"closed"',
      );
      const failing = {
        send: async () => {
          throw new Error("PRIVATE ERROR");
        },
      } as unknown as SDKAgent;
      await expect(dispatchPrompt(state, failing, { prompt: "x", images: [] })).rejects.toThrow(
        "PRIVATE ERROR",
      );
      expect(lines.findLast((line) => !line.includes('"event":"sdk-'))).toContain(
        '"phase":"send-failed"',
      );
      expect(lines.join("\n")).not.toContain("PRIVATE");
      expect(lines.join("\n")).not.toContain("private-id");
      process.env.ORKESTRATOR_BRIDGE_DEBUG = "0";
      const count = lines.length;
      await expect(dispatchPrompt(state, failing, { prompt: "x", images: [] })).rejects.toThrow();
      // Off, the failed turn writes its lifecycle and no SDK snapshot.
      expect(lines.slice(count).map((line) => JSON.parse(line)?.event)).toEqual([
        "send-started",
        "closed",
      ]);
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.ORKESTRATOR_BRIDGE_DEBUG;
      else process.env.ORKESTRATOR_BRIDGE_DEBUG = previous;
    }
  });
});

describe("detail turned on while a turn is already running", () => {
  const originalInfo = console.info;
  afterEach(() => {
    console.info = originalInfo;
    setLiveBridgeDiagnostics(undefined);
    resetSdkDiagnosticsForTests();
  });

  test("the running turn's public scope reports at once and the SDK seam installs then", () => {
    const lines: string[] = [];
    console.info = (line: unknown) => lines.push(String(line));
    let installs = 0;
    resetSdkDiagnosticsForTests({
      __orkestratorDiagnosticsV1() {
        installs += 1;
        return () => undefined;
      },
    });
    setLiveBridgeDiagnostics(false);
    const scope = createRunDiagnostics(newSessionState());
    scope.delta({ type: "tool-call-started", callId: "call-1", toolCall: { type: "shell" } });
    const events = () => lines.map((line) => bridgeDiagnosticPayload(line)?.event);
    expect(events()).toEqual(["send-started"]);
    expect(installs).toBe(0);

    setLiveBridgeDiagnostics(true);
    expect(installs).toBe(1);
    const entries = lines.flatMap((line) => bridgeDiagnosticPayload(line) ?? []);
    const publicSnapshot = entries.find((entry) => entry.event === "heartbeat");
    expect(publicSnapshot).toMatchObject({
      event: "heartbeat",
      pendingToolCount: 1,
      deltaCount: 1,
    });
    const sdkSnapshot = entries.find((entry) => entry.event === "sdk-snapshot");
    expect(sdkSnapshot?.coverage).toBe("installed");
    scope.close();
  });
});
