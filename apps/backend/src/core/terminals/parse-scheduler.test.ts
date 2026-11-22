import { describe, expect, test } from "bun:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  HeadlessParseScheduler,
  nextParseSlice,
  type HeadlessParseTarget,
} from "./parse-scheduler.js";

/** A parser that records what it is handed and parses only when the test says so. */
function fakeTarget(name: string, log: string[]) {
  const pending: Array<() => void> = [];
  const target: HeadlessParseTarget & { received: string; parseNext(): void; waiting(): number } = {
    received: "",
    write(data, callback) {
      log.push(`${name}:${data.length}`);
      target.received += data;
      pending.push(() => callback?.());
    },
    parseNext() {
      pending.shift()?.();
    },
    waiting: () => pending.length,
  };
  return target;
}

/** Deferred pump runs, released by the test: one entry per event-loop turn. */
function manualTurns() {
  const turns: Array<() => void> = [];
  return {
    defer: (run: () => void) => turns.push(run),
    next() {
      const run = turns.shift();
      if (!run) throw new Error("no turn scheduled");
      run();
    },
    scheduled: () => turns.length,
  };
}

describe("headless parse scheduler", () => {
  test("cuts slices without separating a surrogate pair", () => {
    const text = `ab😀cd`;
    expect(nextParseSlice(text, 0, 3)).toBe(2);
    expect(nextParseSlice(text, 2, 3)).toBe(5);
    expect(nextParseSlice(text, 0, 100)).toBe(text.length);
    expect(nextParseSlice(text, 2, 1)).toBe(2);
    expect(nextParseSlice("\ud800a", 0, 1)).toBe(1);
  });

  test("hands a parser one bounded slice at a time and resolves after the last", async () => {
    const log: string[] = [];
    const turns = manualTurns();
    const scheduler = new HeadlessParseScheduler(4, 100, turns.defer);
    const target = fakeTarget("a", log);
    let resolved = false;
    const written = scheduler.write(target, "0123456789").then(() => {
      resolved = true;
    });

    expect(log).toEqual(["a:4"]);
    target.parseNext();
    // Not from inside the parser's own callback: the next slice waits a turn.
    expect(log).toEqual(["a:4"]);
    turns.next();
    expect(log).toEqual(["a:4", "a:4"]);
    target.parseNext();
    turns.next();
    target.parseNext();
    await written;
    expect(resolved).toBe(true);
    expect(log).toEqual(["a:4", "a:4", "a:2"]);
    expect(target.received).toBe("0123456789");
    expect(scheduler.stats()).toEqual({ queuedTargets: 0, inFlightTargets: 0, inFlightChars: 0 });
    expect(turns.scheduled()).toBe(0);
  });

  test("bounds output in flight across parsers and takes them in turn", () => {
    const log: string[] = [];
    const turns = manualTurns();
    const scheduler = new HeadlessParseScheduler(4, 8, turns.defer);
    const flood = fakeTarget("flood", log);
    const quiet = fakeTarget("quiet", log);
    const other = fakeTarget("other", log);
    void scheduler.write(flood, "x".repeat(40));
    void scheduler.write(quiet, "yy");
    void scheduler.write(other, "z😀z");
    const late = fakeTarget("late", log);
    void scheduler.write(late, "w");

    // The two remaining units fit only the first character of the other
    // write. The final unit goes to the next target while the pair waits.
    expect(log).toEqual(["flood:4", "quiet:2", "other:1", "late:1"]);
    expect(scheduler.stats().inFlightChars).toBe(8);
    flood.parseNext();
    quiet.parseNext();
    other.parseNext();
    turns.next();
    expect(log.slice(4)).toEqual(["flood:4", "other:3"]);
    expect(scheduler.stats().inFlightChars).toBe(8);
    expect(flood.waiting()).toBe(1);
  });

  test("keeps each parser's writes in order", async () => {
    const terminal = new HeadlessTerminal({ cols: 40, rows: 6, allowProposedApi: true });
    const reference = new HeadlessTerminal({ cols: 40, rows: 6, allowProposedApi: true });
    const serializer = new SerializeAddon();
    const referenceSerializer = new SerializeAddon();
    terminal.loadAddon(serializer as never);
    reference.loadAddon(referenceSerializer as never);
    const scheduler = new HeadlessParseScheduler(64, 256);
    let output = "";
    for (let line = 0; line < 400; line += 1) {
      output += `\x1b[3${line % 7}m${line} 中😀\x1b[0m ${"-".repeat(line % 30)}\r\n`;
    }
    // Cut mid-escape and mid-pair, as coalesced PTY chunks are.
    const chunks = [output.slice(0, 1_001), output.slice(1_001, 7_777), output.slice(7_777)];
    await Promise.all(chunks.map((chunk) => scheduler.write(terminal, chunk)));
    await new Promise<void>((resolve) => reference.write(output, resolve));
    expect(serializer.serialize({ scrollback: 500 })).toBe(
      referenceSerializer.serialize({ scrollback: 500 }),
    );
    terminal.dispose();
    reference.dispose();
  });

  test("fails only the write a parser refuses", async () => {
    const log: string[] = [];
    const scheduler = new HeadlessParseScheduler(4, 100, (run) => run());
    const broken: HeadlessParseTarget = {
      write() {
        throw new Error("disposed");
      },
    };
    const healthy = fakeTarget("healthy", log);
    const failed = scheduler.write(broken, "abcdefgh");
    const fine = scheduler.write(healthy, "ab");
    await expect(failed).rejects.toThrow("disposed");
    healthy.parseNext();
    await fine;
    expect(healthy.received).toBe("ab");
    expect(scheduler.stats()).toEqual({ queuedTargets: 0, inFlightTargets: 0, inFlightChars: 0 });
  });
});
