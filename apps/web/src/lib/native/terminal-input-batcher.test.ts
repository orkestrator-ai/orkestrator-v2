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

/**
 * Deeper than `tick`. Releasing a parked enqueue resumes it several microtasks
 * after the batch completion that made room, so backpressure assertions need a
 * longer drain than ordinary batching does.
 */
const settle = async () => {
  for (let index = 0; index < 25; index += 1) await Promise.resolve();
};

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
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
    expect(
      sent.every(
        (chunk) => encoder.encode(chunk).byteLength <= TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES,
      ),
    ).toBe(true);
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
    const batcher = new TerminalHttpInputBatcher(
      ({ data }) => {
        sent.push(data);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      50,
      2,
      10,
      1_000,
    );

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

  test("rejects only input too large to ever fit and backpressures the rest in order", async () => {
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    const batcher = new TerminalHttpInputBatcher(
      ({ data }) => {
        sent.push(data);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      50,
      2,
      4,
      1_000,
    );

    const first = batcher.enqueue(request("ab"));
    const pending = batcher.enqueue(request("cd"));
    await tick();
    expect(sent).toEqual(["ab"]);

    // Nine bytes can never fit a four-byte queue, however long the caller waits.
    await expect(batcher.enqueue(request("oversized"))).rejects.toThrow(
      "exceeds the 4-byte terminal queue limit",
    );

    // Two bytes fit once there is room, so they wait rather than being dropped.
    let parkedAccepted = false;
    const parked = batcher.enqueue(request("ef")).then(() => {
      parkedAccepted = true;
    });
    await settle();
    expect(sent).toEqual(["ab"]);
    expect(parkedAccepted).toBe(false);

    releases.shift()?.();
    await settle();
    expect(sent).toEqual(["ab", "cd"]);
    expect(parkedAccepted).toBe(false);

    releases.shift()?.();
    await settle();
    expect(sent).toEqual(["ab", "cd", "ef"]);

    releases.shift()?.();
    await Promise.all([first, pending, parked]);
    expect(parkedAccepted).toBe(true);
  });

  test("keeps parked input ahead of a later keystroke and behind an explicit flush", async () => {
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    const batcher = new TerminalHttpInputBatcher(
      ({ data }) => {
        sent.push(data);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      60_000,
      4,
      4,
      1_000,
    );

    const inFlight = batcher.enqueue(request("abcd"));
    await tick();
    expect(sent).toEqual(["abcd"]);

    // Both park. A one-byte keystroke must not overtake the four-byte paste.
    const paste = batcher.enqueue(request("wxyz"));
    const later = batcher.enqueue(request("!"));

    // The flush covers input that has not been accepted yet, so a lifecycle
    // command sequenced behind it cannot overtake either write.
    let flushed = false;
    const flush = batcher.flush("terminal_write", "session-1").then(() => {
      flushed = true;
    });

    releases.shift()?.();
    await settle();
    expect(sent).toEqual(["abcd", "wxyz"]);
    expect(flushed).toBe(false);

    releases.shift()?.();
    await settle();
    expect(sent).toEqual(["abcd", "wxyz", "!"]);
    expect(flushed).toBe(false);

    releases.shift()?.();
    await Promise.all([inFlight, paste, later, flush]);
    expect(flushed).toBe(true);
  });

  test("preserves issue order across writes that repeatedly hit the ceiling", async () => {
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    const batcher = new TerminalHttpInputBatcher(
      ({ data }) => {
        sent.push(data);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      60_000,
      2,
      4,
      5_000,
    );

    const issued = ["ab", "cd", "ef", "gh", "ij", "kl"];
    const writes = issued.map((data) => batcher.enqueue(request(data)));
    await settle();

    // Inject a fresh write into each drain step so new input races the admission
    // release it overlaps with.
    for (let index = 0; index < 4 && releases.length > 0; index += 1) {
      releases.shift()?.();
      const extra = `x${index}`;
      issued.push(extra);
      writes.push(batcher.enqueue(request(extra)));
      await settle();
    }
    while (releases.length > 0) {
      releases.shift()?.();
      await settle();
    }

    await Promise.all(writes);
    expect(sent.join("")).toBe(issued.join(""));
  });

  test("rejects parked input when its queue fails or is reset before admission", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    const failing = new TerminalHttpInputBatcher(
      ({ data }) =>
        data === "ab"
          ? new Promise<void>((_, reject) => {
              rejectFirst = reject;
            })
          : Promise.resolve(),
      60_000,
      2,
      2,
      1_000,
    );

    const inFlight = rejectionOf(failing.enqueue(request("ab")));
    const parked = rejectionOf(failing.enqueue(request("cd")));
    await tick();
    rejectFirst(new Error("network failed"));
    expect(await inFlight).toEqual(new Error("network failed"));
    expect(await parked).toEqual(new Error("network failed"));

    const reset = new TerminalHttpInputBatcher(
      () => new Promise<void>(() => {}),
      60_000,
      2,
      2,
      1_000,
    );
    const resetInFlight = rejectionOf(reset.enqueue(request("ab")));
    const resetParked = rejectionOf(reset.enqueue(request("cd")));
    await tick();
    reset.resetAll(new Error("gateway replaced"));
    expect(await resetInFlight).toEqual(new Error("gateway replaced"));
    expect(await resetParked).toEqual(new Error("gateway replaced"));
  });

  test("flushes a non-in-flight full batch and accepts the ordered overflow", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(
      async ({ data }) => {
        sent.push(data);
      },
      60_000,
      2,
      4,
    );

    const prefix = batcher.enqueue(request("a"));
    const overflow = batcher.enqueue(request("bc"));
    await Promise.all([prefix, overflow]);

    expect(sent).toEqual(["a", "bc"]);
  });

  test("uses exact UTF-8 byte boundaries for multibyte and maximum-sized batches", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(
      async ({ data }) => {
        sent.push(data);
      },
      50,
      4,
      12,
    );

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
    const batcher = new TerminalHttpInputBatcher(
      ({ data }) => {
        sent.push(data);
        if (!shouldFail) return Promise.resolve();
        return new Promise<void>((_, reject) => {
          rejectFirst = reject;
        });
      },
      50,
      2,
      10,
      1_000,
    );

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
    const batcher = new TerminalHttpInputBatcher(
      ({ data }, signal) => {
        sent.push(data);
        observedSignal = signal;
        return new Promise<void>(() => {});
      },
      50,
      2,
      10,
      5,
    );

    const first = batcher.enqueue(request("ab"));
    const suffix = batcher.enqueue(request("cd"));
    const firstRejection = rejectionOf(first);
    const suffixRejection = rejectionOf(suffix);
    expect(await firstRejection).toEqual(new Error("Terminal HTTP input send timed out after 5ms"));
    expect(await suffixRejection).toEqual(
      new Error("Terminal HTTP input send timed out after 5ms"),
    );

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
    const batcher = new TerminalHttpInputBatcher(
      (_request, signal) => {
        signals.push(signal);
        return new Promise<void>(() => {});
      },
      60_000,
      2,
      10,
      1_000,
    );

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

    await expect(
      batcher.enqueue({ command: "invalid", sessionId: "s", data: "x" } as never),
    ).rejects.toThrow("Invalid terminal input request");
    await expect(
      batcher.enqueue({ command: "terminal_write", sessionId: 1, data: "x" } as never),
    ).rejects.toThrow("Invalid terminal input request");
    await expect(
      batcher.enqueue({ command: "terminal_write", sessionId: "s", data: 1 } as never),
    ).rejects.toThrow("Invalid terminal input request");
  });

  test("ships a printable keystroke that exactly fills a batch without the typing timer", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(
      async ({ data }) => {
        sent.push(data);
      },
      60_000,
      2,
      10,
      1_000,
    );

    const first = batcher.enqueue(request("a"));
    await tick();
    expect(sent).toEqual([]);

    // "b" is a single printable character, so only the full batch can flush it.
    const second = batcher.enqueue(request("b"));
    await Promise.all([first, second]);
    expect(sent).toEqual(["ab"]);
  });

  test("flushAll surfaces a queue that already failed closed", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    const batcher = new TerminalHttpInputBatcher(
      () =>
        new Promise<void>((_, reject) => {
          rejectFirst = reject;
        }),
      50,
      2,
      10,
      1_000,
    );

    const failing = rejectionOf(batcher.enqueue(request("ab", "broken")));
    await tick();
    rejectFirst(new Error("transport down"));
    expect(await failing).toEqual(new Error("transport down"));

    await expect(batcher.flushAll()).rejects.toThrow("transport down");
  });

  test("clearFailure re-arms a failed queue and leaves a healthy one alone", async () => {
    const sent: string[] = [];
    let rejectFirst: (error: Error) => void = () => {};
    let shouldFail = true;
    const batcher = new TerminalHttpInputBatcher(
      ({ data }) => {
        sent.push(data);
        if (!shouldFail) return Promise.resolve();
        return new Promise<void>((_, reject) => {
          rejectFirst = reject;
        });
      },
      50,
      2,
      10,
      1_000,
    );

    expect(batcher.clearFailure("terminal_write", "never-used")).toBe(false);

    const failing = rejectionOf(batcher.enqueue(request("ab")));
    await tick();
    rejectFirst(new Error("network failed"));
    expect(await failing).toEqual(new Error("network failed"));
    await expect(batcher.enqueue(request("cd"))).rejects.toThrow("network failed");

    shouldFail = false;
    expect(batcher.clearFailure("terminal_write", "session-1")).toBe(true);
    await batcher.enqueue(request("ef"));
    expect(sent).toEqual(["ab", "ef"]);

    // A healthy queue is never disturbed, so its accepted input still lands.
    const healthy = batcher.enqueue(request("gh"));
    expect(batcher.clearFailure("terminal_write", "session-1")).toBe(false);
    await healthy;
    expect(sent).toEqual(["ab", "ef", "gh"]);
  });

  test("resetting an unknown queue is a no-op", async () => {
    const send = mock(async () => {});
    const batcher = new TerminalHttpInputBatcher(send, 0);
    expect(() => batcher.reset("terminal_write", "never-used")).not.toThrow();
    await batcher.enqueue(request("x", "never-used"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("uses its documented default reasons for reset, resetAll, and dispose", async () => {
    const batcher = new TerminalHttpInputBatcher(
      () => new Promise<void>(() => {}),
      60_000,
      2,
      10,
      1_000,
    );

    const one = rejectionOf(batcher.enqueue(request("a", "one")));
    batcher.reset("terminal_write", "one");
    expect(await one).toEqual(new Error("Terminal HTTP input queue reset"));

    const two = rejectionOf(batcher.enqueue(request("b", "two")));
    batcher.resetAll();
    expect(await two).toEqual(new Error("Terminal HTTP input queues reset"));

    const three = rejectionOf(batcher.enqueue(request("c", "three")));
    batcher.dispose();
    expect(await three).toEqual(new Error("Terminal HTTP input queues reset"));
  });

  test("ignores a send that settles after its queue was retired", async () => {
    const sent: string[] = [];
    const settlers: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
    const batcher = new TerminalHttpInputBatcher(
      ({ data }) => {
        sent.push(data);
        return new Promise<void>((resolve, reject) => settlers.push({ resolve, reject }));
      },
      60_000,
      4,
      20,
      1_000,
    );

    const retired = rejectionOf(batcher.enqueue(request("ab")));
    await tick();
    batcher.reset("terminal_write", "session-1", new Error("reset"));
    expect(await retired).toEqual(new Error("reset"));

    const fresh = batcher.enqueue(request("cd"));
    await tick();
    expect(sent).toEqual(["ab", "cd"]);

    let freshSettled = false;
    void fresh.then(
      () => {
        freshSettled = true;
      },
      () => {
        freshSettled = true;
      },
    );

    // The abandoned send belongs to the retired queue and must not complete the
    // fresh one that replaced it under the same key.
    settlers[0]?.resolve();
    await tick();
    expect(freshSettled).toBe(false);

    settlers[1]?.resolve();
    await fresh;
    expect(sent).toEqual(["ab", "cd"]);
  });

  test("ignores a rejection that arrives after its queue was retired", async () => {
    const sent: string[] = [];
    const settlers: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
    const batcher = new TerminalHttpInputBatcher(
      ({ data }) => {
        sent.push(data);
        if (sent.length > 2) return Promise.resolve();
        return new Promise<void>((resolve, reject) => settlers.push({ resolve, reject }));
      },
      60_000,
      4,
      20,
      1_000,
    );

    const retired = rejectionOf(batcher.enqueue(request("ab")));
    await tick();
    batcher.reset("terminal_write", "session-1", new Error("reset"));
    expect(await retired).toEqual(new Error("reset"));

    const fresh = batcher.enqueue(request("cd"));
    await tick();
    settlers[0]?.reject(new Error("late failure"));
    await tick();

    // The fresh queue must not inherit the retired queue's failure.
    settlers[1]?.resolve();
    await fresh;
    await batcher.enqueue(request("ef"));
    expect(sent).toEqual(["ab", "cd", "ef"]);
  });

  test("accepts a sender that returns void synchronously", async () => {
    const sent: string[] = [];
    const batcher = new TerminalHttpInputBatcher(({ data }) => {
      sent.push(data);
    }, 5);

    await batcher.enqueue(request("hi"));
    expect(sent).toEqual(["hi"]);
  });

  test("cancels an armed typing timer when the queue fails", async () => {
    const sent: string[] = [];
    let rejectFirst: (error: Error) => void = () => {};
    const batcher = new TerminalHttpInputBatcher(
      ({ data }) => {
        sent.push(data);
        if (sent.length > 1) return Promise.resolve();
        return new Promise<void>((_, reject) => {
          rejectFirst = reject;
        });
      },
      5,
      4,
      20,
      1_000,
    );

    const inFlight = rejectionOf(batcher.enqueue(request("ab")));
    const typed = rejectionOf(batcher.enqueue(request("c")));
    await tick();
    rejectFirst(new Error("network failed"));
    expect(await inFlight).toEqual(new Error("network failed"));
    expect(await typed).toEqual(new Error("network failed"));

    // Let the cancelled 5 ms deadline pass; the failed queue may send nothing.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sent).toEqual(["ab"]);
  });

  test("validates constructor bounds", () => {
    const send = async () => {};
    expect(() => new TerminalHttpInputBatcher(undefined as never)).toThrow(
      "send must be a function",
    );
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
    expect(parseTerminalInputRequest("terminal_write", { sessionId: "s", data: "x" })).toEqual({
      command: "terminal_write",
      sessionId: "s",
      data: "x",
    });
    expect(
      parseTerminalInputRequest("local_terminal_write", { sessionId: "l", data: "y" }),
    ).toEqual({ command: "local_terminal_write", sessionId: "l", data: "y" });
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
