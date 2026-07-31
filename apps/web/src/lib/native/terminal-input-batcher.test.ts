import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  parseTerminalInputRequest,
  TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES,
  TerminalHttpInputBatcher,
  terminalInputRequiresImmediateFlush,
  type TerminalInputRequest,
} from "./terminal-input-batcher";

const tick = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> => promise.then(
  () => {
    throw new Error("Expected promise to reject");
  },
  (error) => error,
);

const request = (
  data: string,
  sessionId = "session-1",
  command: TerminalInputRequest["command"] = "terminal_write",
): TerminalInputRequest => ({ command, sessionId, data });

describe("TerminalHttpInputBatcher", () => {
  test("micro-batches printable typing and preserves exact order", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(async ({ data }) => {
      sent.push(data);
    }, 5);

    const writes = ["h", "e", "l", "l", "o"].map((data) => batcher.enqueue(request(data)));
    expect(sent).toEqual([]);
    await Promise.all(writes);
    expect(sent).toEqual(["hello"]);
  });

  test("flushes the printable prefix with Enter, controls, and paste chunks", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(async ({ data }) => {
      sent.push(data);
    }, 50);

    const first = batcher.enqueue(request("a"));
    const enter = batcher.enqueue(request("\r"));
    await Promise.all([first, enter]);
    await batcher.enqueue(request("pasted text"));
    await batcher.enqueue(request("\u001b[A"));

    expect(sent).toEqual(["a\r", "pasted text", "\u001b[A"]);
  });

  test("accepts input larger than 64 KiB and sends UTF-8-safe bounded chunks", async () => {
    const sent: string[] = [];
    const encoder = new TextEncoder();
    const data = `${"a".repeat(TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES - 1)}€tail`;
    const batcher = new TerminalHttpInputBatcher(async ({ data: chunk }) => {
      sent.push(chunk);
    });

    await batcher.enqueue(request(data));

    expect(sent.length).toBe(2);
    expect(sent.join("")).toBe(data);
    expect(sent.every((chunk) => encoder.encode(chunk).byteLength <= TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES))
      .toBe(true);
    expect(sent[0]?.endsWith("�")).toBe(false);
    expect(sent[1]?.startsWith("€")).toBe(true);
  });

  test("encodes a large input once instead of allocating an encoding per code point", async () => {
    const encode = spyOn(TextEncoder.prototype, "encode");
    const data = `${"a".repeat(TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES * 2)}€😀`;
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(async ({ data: chunk }) => {
      sent.push(chunk);
    });

    try {
      await batcher.enqueue(request(data));
      expect(encode).toHaveBeenCalledTimes(1);
      expect(sent.join("")).toBe(data);
    } finally {
      encode.mockRestore();
    }
  });

  test("preserves per-request completion and cross-request order across chunks", async () => {
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    const batcher = new TerminalHttpInputBatcher(({ data }) => {
      sent.push(data);
      return new Promise<void>((resolve) => releases.push(resolve));
    }, 50, 2, 10, 1_000);

    let firstCompleted = false;
    const first = batcher.enqueue(request("abcd")).then(() => {
      firstCompleted = true;
    });
    const second = batcher.enqueue(request("XY"));
    await tick();
    expect(sent).toEqual(["ab"]);
    expect(firstCompleted).toBe(false);

    releases.shift()?.();
    await tick();
    expect(sent).toEqual(["ab", "cd"]);
    expect(firstCompleted).toBe(false);

    releases.shift()?.();
    await first;
    await tick();
    expect(sent).toEqual(["ab", "cd", "XY"]);
    releases.shift()?.();
    await second;
  });

  test("enforces a finite total per-terminal queue while leaving accepted input intact", async () => {
    const sent: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const batcher = new TerminalHttpInputBatcher(async ({ data }) => {
      sent.push(data);
      if (sent.length === 1) await firstBlocked;
    }, 50, 2, 4, 1_000);

    const first = batcher.enqueue(request("ab"));
    const pending = batcher.enqueue(request("cd"));
    await expect(batcher.enqueue(request("e"))).rejects.toThrow("queue is full");
    await expect(batcher.enqueue(request("oversized"))).rejects.toThrow("queue is full");
    releaseFirst();
    await Promise.all([first, pending]);
    expect(sent).toEqual(["ab", "cd"]);
  });

  test("flushes a non-in-flight full batch and accepts the ordered overflow", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(async ({ data }) => {
      sent.push(data);
    }, 60_000, 2, 4);

    const prefix = batcher.enqueue(request("a"));
    const overflow = batcher.enqueue(request("bc"));
    await Promise.all([prefix, overflow]);

    expect(sent).toEqual(["a", "bc"]);
  });

  test("uses exact UTF-8 byte boundaries for multibyte and maximum-sized batches", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(async ({ data }) => {
      sent.push(data);
    }, 50, 4, 12);

    await batcher.enqueue(request("éé😀"));

    expect(sent).toEqual(["éé", "😀"]);
    expect(sent.map((value) => new TextEncoder().encode(value).byteLength)).toEqual([4, 4]);
  });

  test("rejects a code point that cannot fit the configured per-send limit", async () => {
    const batcher = new TerminalHttpInputBatcher(async () => {}, 5, 2, 10);
    await expect(batcher.enqueue(request("😀"))).rejects.toThrow("one UTF-8 code point");
  });

  test("fails closed on rejection, rejects queued waiters, and resumes only after reset", async () => {
    const sent: string[] = [];
    let rejectFirst: (error: Error) => void = () => {};
    let shouldFail = true;
    const batcher = new TerminalHttpInputBatcher(({ data }) => {
      sent.push(data);
      if (!shouldFail) return Promise.resolve();
      return new Promise<void>((_, reject) => {
        rejectFirst = reject;
      });
    }, 50, 2, 10, 1_000);

    const first = batcher.enqueue(request("ab"));
    const suffix = batcher.enqueue(request("cd"));
    const firstRejection = rejectionOf(first);
    const suffixRejection = rejectionOf(suffix);
    await tick();
    rejectFirst(new Error("network failed"));
    expect(await firstRejection).toEqual(new Error("network failed"));
    expect(await suffixRejection).toEqual(new Error("network failed"));
    expect(sent).toEqual(["ab"]);
    await expect(batcher.enqueue(request("ef"))).rejects.toThrow("network failed");

    shouldFail = false;
    batcher.reset("terminal_write", "session-1");
    await batcher.enqueue(request("ef"));
    expect(sent).toEqual(["ab", "ef"]);
  });

  test("turns synchronous sender throws into a failed queue without sending a suffix", async () => {
    const send = mock(() => {
      throw new Error("sync failure");
    });
    const batcher = new TerminalHttpInputBatcher(send, 50, 2, 10, 1_000);
    const first = batcher.enqueue(request("ab"));
    const suffix = batcher.enqueue(request("cd"));
    const firstRejection = rejectionOf(first);
    const suffixRejection = rejectionOf(suffix);

    expect(await firstRejection).toEqual(new Error("sync failure"));
    expect(await suffixRejection).toEqual(new Error("sync failure"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("times out and aborts a stalled send, rejecting its queued suffix", async () => {
    const sent: string[] = [];
    let observedSignal: AbortSignal | undefined;
    const batcher = new TerminalHttpInputBatcher(({ data }, signal) => {
      sent.push(data);
      observedSignal = signal;
      return new Promise<void>(() => {});
    }, 50, 2, 10, 5);

    const first = batcher.enqueue(request("ab"));
    const suffix = batcher.enqueue(request("cd"));
    const firstRejection = rejectionOf(first);
    const suffixRejection = rejectionOf(suffix);
    expect(await firstRejection).toEqual(new Error("Terminal HTTP input send timed out after 5ms"));
    expect(await suffixRejection).toEqual(new Error("Terminal HTTP input send timed out after 5ms"));

    expect(sent).toEqual(["ab"]);
    expect(observedSignal?.aborted).toBe(true);
    await expect(batcher.flush("terminal_write", "session-1")).rejects.toThrow("timed out");
  });

  test("flushes pending typing explicitly for one terminal and for all terminals", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(async ({ command, sessionId, data }) => {
      sent.push(`${command}:${sessionId}:${data}`);
    }, 60_000);

    const one = batcher.enqueue(request("x", "a"));
    await batcher.flush("terminal_write", "a");
    await one;
    expect(sent).toEqual(["terminal_write:a:x"]);
    await batcher.flush("terminal_write", "missing");

    const two = batcher.enqueue(request("y", "b"));
    const local = batcher.enqueue(request("z", "b", "local_terminal_write"));
    await batcher.flushAll();
    await Promise.all([two, local]);
    expect(sent.sort()).toEqual([
      "local_terminal_write:b:z",
      "terminal_write:a:x",
      "terminal_write:b:y",
    ]);
  });

  test("reset and dispose reject pending input, abort in-flight input, and permit a fresh queue", async () => {
    const signals: AbortSignal[] = [];
    const batcher = new TerminalHttpInputBatcher((_request, signal) => {
      signals.push(signal);
      return new Promise<void>(() => {});
    }, 60_000, 2, 10, 1_000);

    const inFlight = batcher.enqueue(request("ab"));
    const pending = batcher.enqueue(request("c"));
    const inFlightRejection = rejectionOf(inFlight);
    const pendingRejection = rejectionOf(pending);
    await tick();
    batcher.reset("terminal_write", "session-1", new Error("reconnected"));
    expect(await inFlightRejection).toEqual(new Error("reconnected"));
    expect(await pendingRejection).toEqual(new Error("reconnected"));
    expect(signals[0]?.aborted).toBe(true);

    const localPending = batcher.enqueue(request("x", "local", "local_terminal_write"));
    const localRejection = rejectionOf(localPending);
    batcher.dispose(new Error("disposed"));
    expect(await localRejection).toEqual(new Error("disposed"));

    const fresh = batcher.enqueue(request("y", "fresh"));
    const freshRejection = rejectionOf(fresh);
    batcher.resetAll(new Error("all reset"));
    expect(await freshRejection).toEqual(new Error("all reset"));
  });

  test("keeps terminal and local-terminal queues with the same session independent", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(async ({ command, data }) => {
      sent.push(`${command}:${data}`);
    }, 0);

    await Promise.all([
      batcher.enqueue(request("x", "same", "terminal_write")),
      batcher.enqueue(request("y", "same", "local_terminal_write")),
    ]);
    expect(sent.sort()).toEqual(["local_terminal_write:y", "terminal_write:x"]);
  });

  test("accepts empty input as a no-op and validates requests at the public boundary", async () => {
    const send = mock(async () => {});
    const batcher = new TerminalHttpInputBatcher(send);
    await batcher.enqueue(request(""));
    expect(send).not.toHaveBeenCalled();

    await expect(batcher.enqueue({ command: "invalid", sessionId: "s", data: "x" } as never))
      .rejects.toThrow("Invalid terminal input request");
    await expect(batcher.enqueue({ command: "terminal_write", sessionId: 1, data: "x" } as never))
      .rejects.toThrow("Invalid terminal input request");
    await expect(batcher.enqueue({ command: "terminal_write", sessionId: "s", data: 1 } as never))
      .rejects.toThrow("Invalid terminal input request");
  });

  test("validates constructor bounds", () => {
    const send = async () => {};
    expect(() => new TerminalHttpInputBatcher(undefined as never)).toThrow("send must be a function");
    for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new TerminalHttpInputBatcher(send, delay)).toThrow("delayMs");
    }
    for (const maximum of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new TerminalHttpInputBatcher(send, 1, maximum)).toThrow("maxBufferBytes");
    }
    for (const maximum of [3, 4.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new TerminalHttpInputBatcher(send, 1, 4, maximum)).toThrow("maxQueuedBytes");
    }
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new TerminalHttpInputBatcher(send, 1, 4, 4, timeout)).toThrow("sendTimeoutMs");
    }
  });
});

describe("terminal input request helpers", () => {
  test("recognizes terminal and local terminal requests", () => {
    expect(parseTerminalInputRequest("terminal_write", { sessionId: "s", data: "x" }))
      .toEqual({ command: "terminal_write", sessionId: "s", data: "x" });
    expect(parseTerminalInputRequest("local_terminal_write", { sessionId: "l", data: "y" }))
      .toEqual({ command: "local_terminal_write", sessionId: "l", data: "y" });
  });

  test("rejects unrelated and malformed invokes", () => {
    expect(parseTerminalInputRequest("get_projects", {})).toBeNull();
    expect(parseTerminalInputRequest("terminal_write", undefined)).toBeNull();
    expect(parseTerminalInputRequest("terminal_write", { sessionId: 1, data: "x" })).toBeNull();
    expect(parseTerminalInputRequest("terminal_write", { sessionId: "s", data: 1 })).toBeNull();
  });

  test("identifies printable micro-batches and every immediate boundary", () => {
    expect(terminalInputRequiresImmediateFlush("x")).toBe(false);
    expect(terminalInputRequiresImmediateFlush("é")).toBe(false);
    expect(terminalInputRequiresImmediateFlush("\t")).toBe(true);
    expect(terminalInputRequiresImmediateFlush("\u007f")).toBe(true);
    expect(terminalInputRequiresImmediateFlush("xy")).toBe(true);
    expect(terminalInputRequiresImmediateFlush("😀")).toBe(true);
    expect(terminalInputRequiresImmediateFlush("")).toBe(true);
  });
});
