import { describe, expect, mock, test } from "bun:test";
import {
  parseTerminalInputRequest,
  TerminalHttpInputBatcher,
  terminalInputRequiresImmediateFlush,
} from "./terminal-input-batcher";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TerminalHttpInputBatcher", () => {
  test("micro-batches printable typing and preserves exact order", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(async ({ data }) => {
      sent.push(data);
    }, 5);

    const writes = ["h", "e", "l", "l", "o"].map((data) => batcher.enqueue({
      command: "terminal_write",
      sessionId: "session-1",
      data,
    }));
    expect(sent).toEqual([]);
    await Promise.all(writes);
    expect(sent).toEqual(["hello"]);
  });

  test("flushes the printable prefix with Enter, controls, and paste chunks", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(async ({ data }) => {
      sent.push(data);
    }, 50);

    const first = batcher.enqueue({ command: "terminal_write", sessionId: "s", data: "a" });
    const enter = batcher.enqueue({ command: "terminal_write", sessionId: "s", data: "\r" });
    await Promise.all([first, enter]);
    await batcher.enqueue({ command: "terminal_write", sessionId: "s", data: "pasted text" });
    await batcher.enqueue({ command: "terminal_write", sessionId: "s", data: "\u001b[A" });

    expect(sent).toEqual(["a\r", "pasted text", "\u001b[A"]);
  });

  test("bounds accumulated bytes and serializes sends across flushes", async () => {
    const sent: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const send = mock(async ({ data }: { data: string }) => {
      sent.push(data);
      if (sent.length === 1) await firstBlocked;
    });
    const batcher = new TerminalHttpInputBatcher(send, 50, 2);

    const a = batcher.enqueue({ command: "terminal_write", sessionId: "s", data: "a" });
    const b = batcher.enqueue({ command: "terminal_write", sessionId: "s", data: "b" });
    const c = batcher.enqueue({ command: "terminal_write", sessionId: "s", data: "c" });
    await tick();
    expect(sent).toEqual(["ab"]);
    releaseFirst();
    await Promise.all([a, b, c]);
    expect(sent).toEqual(["ab", "c"]);
  });

  test("fails explicitly instead of growing an unbounded queue behind a slow request", async () => {
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const batcher = new TerminalHttpInputBatcher(async () => {
      calls += 1;
      if (calls === 1) await firstBlocked;
    }, 50, 2);
    const request = (data: string) => batcher.enqueue({
      command: "terminal_write",
      sessionId: "s",
      data,
    });

    const first = Promise.all([request("a"), request("b")]);
    const pending = Promise.all([request("c"), request("d")]);
    await expect(request("e")).rejects.toThrow("buffer is full");
    await expect(request("oversized")).rejects.toThrow("exceeds");
    releaseFirst();
    await Promise.all([first, pending]);
    expect(calls).toBe(2);
  });

  test("keeps terminal sessions independent", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(async ({ sessionId, data }) => {
      sent.push(`${sessionId}:${data}`);
    }, 0);
    await Promise.all([
      batcher.enqueue({ command: "terminal_write", sessionId: "a", data: "x" }),
      batcher.enqueue({ command: "terminal_write", sessionId: "b", data: "y" }),
    ]);
    expect(sent.sort()).toEqual(["a:x", "b:y"]);
  });

  test("recognizes only valid terminal invokes and immediate boundaries", () => {
    expect(parseTerminalInputRequest("terminal_write", { sessionId: "s", data: "x" }))
      .toEqual({ command: "terminal_write", sessionId: "s", data: "x" });
    expect(parseTerminalInputRequest("get_projects", {})).toBeNull();
    expect(parseTerminalInputRequest("terminal_write", { sessionId: 1, data: "x" })).toBeNull();
    expect(terminalInputRequiresImmediateFlush("x")).toBe(false);
    expect(terminalInputRequiresImmediateFlush("\t")).toBe(true);
    expect(terminalInputRequiresImmediateFlush("xy")).toBe(true);
  });
});
