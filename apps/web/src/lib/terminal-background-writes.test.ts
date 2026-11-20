import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import {
  BACKGROUND_SLICE_BYTES,
  createBackgroundWriteScheduler,
  createTerminalWriteGate,
  type IdleDeadlineLike,
  type IdleScheduling,
} from "./terminal-background-writes";

function manualIdle() {
  const pending = new Map<number, (deadline: IdleDeadlineLike) => void>();
  let next = 1;
  const idle: IdleScheduling = {
    request(callback) {
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    idle,
    pending: () => pending.size,
    /** Runs every idle callback requested so far. */
    runIdle() {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const callback of callbacks) callback({ didTimeout: false, timeRemaining: () => 10 });
    },
  };
}

/** A sink that parses only when told to, as xterm parses after `write` returns. */
function deferredSink() {
  const written: number[] = [];
  const pieces: string[] = [];
  const parses: Array<() => void> = [];
  return {
    written,
    pieces,
    sink(data: Uint8Array, parsed: () => void) {
      written.push(...data);
      pieces.push(new TextDecoder().decode(data));
      parses.push(parsed);
    },
    parseAll() {
      for (const parsed of parses.splice(0)) parsed();
    },
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (values: number[]) => new TextDecoder().decode(new Uint8Array(values));

describe("terminal write gate", () => {
  test("a shown tab writes straight through", () => {
    const idle = manualIdle();
    const scheduler = createBackgroundWriteScheduler({ idle: idle.idle });
    const target = deferredSink();
    const gate = createTerminalWriteGate(target.sink, scheduler);
    let parsed = 0;
    gate.write(bytes("abc"), () => (parsed += 1));
    expect(text(target.written)).toBe("abc");
    expect(idle.pending()).toBe(0);
    target.parseAll();
    expect(parsed).toBe(1);
    scheduler.dispose();
  });

  test("a hidden tab waits for idle time, then writes one slice at a time in order", () => {
    const idle = manualIdle();
    const scheduler = createBackgroundWriteScheduler({ idle: idle.idle, sliceBytes: 4 });
    const target = deferredSink();
    const gate = createTerminalWriteGate(target.sink, scheduler, { hidden: true });
    const done: string[] = [];
    gate.write(bytes("abcdef"), () => done.push("first"));
    gate.write(bytes("gh"), () => done.push("second"));
    expect(target.written).toEqual([]);
    expect(gate.queuedBytes()).toBe(8);

    idle.runIdle();
    expect(text(target.written)).toBe("abcd");
    // The next slice waits until xterm has parsed this one.
    expect(idle.pending()).toBe(0);
    target.parseAll();
    expect(done).toEqual([]);
    idle.runIdle();
    expect(text(target.written)).toBe("abcdefgh");
    target.parseAll();
    expect(done).toEqual(["first", "second"]);
    expect(gate.queuedBytes()).toBe(0);
    scheduler.dispose();
  });

  test("revealing the tab flushes everything queued before later writes", () => {
    const idle = manualIdle();
    const scheduler = createBackgroundWriteScheduler({ idle: idle.idle, sliceBytes: 2 });
    const target = deferredSink();
    const gate = createTerminalWriteGate(target.sink, scheduler, { hidden: true });
    const done: string[] = [];
    gate.write(bytes("one"), () => done.push("one"));
    idle.runIdle();
    gate.write(bytes("two"), () => done.push("two"));
    gate.setHidden(false);
    gate.write(bytes("three"), () => done.push("three"));
    expect(text(target.written)).toBe("onetwothree");
    target.parseAll();
    expect(done).toEqual(["one", "two", "three"]);
    scheduler.dispose();
  });

  test("hidden terminals share one slot and take turns", () => {
    const idle = manualIdle();
    const scheduler = createBackgroundWriteScheduler({ idle: idle.idle, sliceBytes: 2 });
    const first = deferredSink();
    const second = deferredSink();
    const a = createTerminalWriteGate(first.sink, scheduler, { hidden: true });
    const b = createTerminalWriteGate(second.sink, scheduler, { hidden: true });
    a.write(bytes("aaaa"));
    b.write(bytes("bbbb"));
    idle.runIdle();
    expect([first.pieces, second.pieces]).toEqual([["aa"], []]);
    first.parseAll();
    idle.runIdle();
    expect([first.pieces, second.pieces]).toEqual([["aa"], ["bb"]]);
    second.parseAll();
    idle.runIdle();
    expect(first.pieces).toEqual(["aa", "aa"]);
    first.parseAll();
    idle.runIdle();
    expect(second.pieces).toEqual(["bb", "bb"]);
    expect(scheduler.metrics.slices).toBe(4);
    scheduler.dispose();
  });

  test("a queue past its bound flushes into the sink instead of growing", () => {
    const idle = manualIdle();
    const scheduler = createBackgroundWriteScheduler({ idle: idle.idle });
    const target = deferredSink();
    const gate = createTerminalWriteGate(target.sink, scheduler, {
      hidden: true,
      maxQueuedBytes: 5,
    });
    gate.write(bytes("abc"));
    expect(target.written).toEqual([]);
    gate.write(bytes("def"));
    expect(text(target.written)).toBe("abcdef");
    expect(gate.queuedBytes()).toBe(0);
    expect(scheduler.metrics.boundFlushes).toBe(1);
    scheduler.dispose();
  });

  test("dispose and flush hand over every queued byte", () => {
    const idle = manualIdle();
    const scheduler = createBackgroundWriteScheduler({ idle: idle.idle, sliceBytes: 1 });
    const target = deferredSink();
    const gate = createTerminalWriteGate(target.sink, scheduler, { hidden: true });
    gate.write(bytes("xy"));
    idle.runIdle();
    gate.flush();
    expect(text(target.written)).toBe("xy");
    gate.write(bytes("z"));
    gate.dispose();
    expect(text(target.written)).toBe("xyz");
    gate.write(bytes("!"));
    expect(text(target.written)).toBe("xyz!");
    scheduler.dispose();
  });

  test("a slice xterm never reports back releases the slot after the watchdog", () => {
    const idle = manualIdle();
    const watchdogs: Array<() => void> = [];
    const scheduler = createBackgroundWriteScheduler({
      idle: idle.idle,
      sliceBytes: 1,
      timers: {
        set: (callback) => watchdogs.push(callback),
        clear: () => undefined,
      },
    });
    const lost = createTerminalWriteGate(() => undefined, scheduler, { hidden: true });
    const target = deferredSink();
    const other = createTerminalWriteGate(target.sink, scheduler, { hidden: true });
    lost.write(bytes("a"));
    other.write(bytes("b"));
    idle.runIdle();
    expect(idle.pending()).toBe(0);
    expect(watchdogs).toHaveLength(1);
    watchdogs[0]!();
    idle.runIdle();
    expect(text(target.written)).toBe("b");
    scheduler.dispose();
  });
  test("a late callback cannot release a newer slice for the same gate", () => {
    const idle = manualIdle();
    const watchdogs = new Map<() => void, () => void>();
    const scheduler = createBackgroundWriteScheduler({
      idle: idle.idle,
      sliceBytes: 1,
      timers: {
        set(callback) {
          watchdogs.set(callback, callback);
          return callback;
        },
        clear(callback) {
          watchdogs.delete(callback as () => void);
        },
      },
    });
    const callbacks: Array<() => void> = [];
    const gate = createTerminalWriteGate((_data, done) => callbacks.push(done), scheduler, {
      hidden: true,
    });
    try {
      gate.write(bytes("abc"));
      idle.runIdle();
      watchdogs.values().next().value!();
      idle.runIdle();
      expect(callbacks).toHaveLength(2);
      callbacks[0]!();
      expect(idle.pending()).toBe(0);
      expect(watchdogs.size).toBe(1);
      callbacks[1]!();
      expect(idle.pending()).toBe(1);
    } finally {
      scheduler.dispose();
    }
  });

  for (const flush of [false, true]) {
    test(`a failed ${flush ? "flush" : "idle slice"} rejects the queued tail and frees the scheduler`, () => {
      const idle = manualIdle();
      const scheduler = createBackgroundWriteScheduler({ idle: idle.idle, sliceBytes: 1 });
      const failure = new Error("sink rejected");
      const failed: unknown[] = [];
      const gate = createTerminalWriteGate(
        () => {
          throw failure;
        },
        scheduler,
        { hidden: true },
      );
      const healthy = deferredSink();
      const other = createTerminalWriteGate(healthy.sink, scheduler, { hidden: true });
      try {
        gate.write(
          bytes("aa"),
          () => {
            throw new Error("incorrect acknowledgment");
          },
          (error) => failed.push(error),
        );
        gate.write(bytes("bb"), undefined, (error) => failed.push(error));
        other.write(bytes("c"));
        if (flush) gate.flush();
        else idle.runIdle();
        expect(failed).toEqual([failure, failure]);
        expect(gate.queuedBytes()).toBe(0);
        idle.runIdle();
        expect(healthy.pieces).toEqual(["c"]);
        healthy.parseAll();
      } finally {
        scheduler.dispose();
      }
    });
  }

  for (const sequence of ["é", "\u001b[31mZ\u001b[0m"]) {
    test(`real xterm preserves ${JSON.stringify(sequence)} across the idle slice boundary`, async () => {
      const idle = manualIdle();
      const scheduler = createBackgroundWriteScheduler({ idle: idle.idle });
      const terminal = new Terminal({ allowProposedApi: true });
      const gate = createTerminalWriteGate(
        (data, parsed) => terminal.write(data, parsed),
        scheduler,
        { hidden: true },
      );
      try {
        // NUL is ignored by xterm, so the sequence starts on the last byte
        // of one 32 KiB slice without filling the on-screen buffer.
        const data = bytes(`${"\0".repeat(BACKGROUND_SLICE_BYTES - 1)}${sequence}!`);
        const completed = new Promise<void>((parsed, failed) => gate.write(data, parsed, failed));
        const firstParsed = new Promise<void>((resolve) => {
          const listener = terminal.onWriteParsed(() => {
            listener.dispose();
            resolve();
          });
        });
        idle.runIdle();
        await firstParsed;
        idle.runIdle();
        await completed;
        const line = terminal.buffer.active.getLine(0)!;
        expect(line.translateToString(true)).toBe(sequence === "é" ? "é!" : "Z!");
        if (sequence !== "é") expect(line.getCell(0)!.getFgColor()).toBe(1);
        expect(scheduler.metrics.slices).toBe(2);
      } finally {
        terminal.dispose();
        scheduler.dispose();
      }
    });
  }
});
