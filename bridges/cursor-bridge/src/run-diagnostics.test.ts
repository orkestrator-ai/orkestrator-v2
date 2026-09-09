import { describe, expect, spyOn, test } from "bun:test";
import type { SDKAgent } from "@cursor/sdk";
import { newSessionState } from "./agent-session.js";
import {
  createRunDiagnostics,
  cursorDebugEnabled,
  CursorRunDiagnostics,
} from "./run-diagnostics.js";
import { dispatchPrompt, followRun, type FollowableRun } from "./prompt.js";

function harness() {
  let now = 1000;
  const lines: string[] = [];
  const state = newSessionState();
  state.status = "running";
  state.promptSequence = 1;
  const diagnostics = new CursorRunDiagnostics(
    state,
    () => now,
    (line) => lines.push(line),
  );
  return {
    state,
    diagnostics,
    lines,
    advance: (ms: number) => {
      now += ms;
    },
    last: () => JSON.parse(lines.at(-1)!.slice("[bridge-diagnostics] ".length)),
  };
}

describe("Cursor stall diagnostics", () => {
  test("disabled by default and when the launcher passes off", () => {
    for (const flag of ["", "0", "false", "off", "true", "secret"])
      expect(cursorDebugEnabled(flag)).toBe(false);
    expect(cursorDebugEnabled("1")).toBe(true);
    const previous = process.env.CURSOR_BRIDGE_DEBUG;
    try {
      delete process.env.CURSOR_BRIDGE_DEBUG;
      expect(createRunDiagnostics(newSessionState())).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CURSOR_BRIDGE_DEBUG;
      else process.env.CURSOR_BRIDGE_DEBUG = previous;
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
      expect(h.lines.length).toBe(before + 1);
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
      expect(h.lines.at(-1)!.length).toBeLessThan(2500);
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
      (line) => lines.push(line),
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
    const previous = process.env.CURSOR_BRIDGE_DEBUG;
    const lines: string[] = [];
    const log = spyOn(console, "info").mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      process.env.CURSOR_BRIDGE_DEBUG = "1";
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
      expect(lines.at(-1)).toContain('"event":"closed"');
      const failing = {
        send: async () => {
          throw new Error("PRIVATE ERROR");
        },
      } as unknown as SDKAgent;
      await expect(dispatchPrompt(state, failing, { prompt: "x", images: [] })).rejects.toThrow(
        "PRIVATE ERROR",
      );
      expect(lines.at(-1)).toContain('"phase":"send-failed"');
      expect(lines.join("\n")).not.toContain("PRIVATE");
      expect(lines.join("\n")).not.toContain("private-id");
      process.env.CURSOR_BRIDGE_DEBUG = "0";
      const count = lines.length;
      await expect(dispatchPrompt(state, failing, { prompt: "x", images: [] })).rejects.toThrow();
      expect(lines.length).toBe(count);
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.CURSOR_BRIDGE_DEBUG;
      else process.env.CURSOR_BRIDGE_DEBUG = previous;
    }
  });
});
