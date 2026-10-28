import { afterEach, describe, expect, test } from "bun:test";
import {
  boundedConsoleStats,
  installBoundedConsole,
  type BoundedConsoleStream,
  type InstalledBoundedConsole,
} from "./bounded-console.js";

/** A stream whose flushes the test releases by hand, like a reader that may stall. */
class HeldStream implements BoundedConsoleStream {
  readonly written: string[] = [];
  private readonly callbacks: Array<(error?: Error) => void> = [];

  write(chunk: string, callback: (error?: Error | null) => void): boolean {
    this.written.push(chunk);
    this.callbacks.push((error) => callback(error));
    return this.callbacks.length === 1;
  }

  /** Lets the reader drain everything written so far (and what that triggers). */
  drain(): void {
    while (this.callbacks.length > 0) this.callbacks.shift()!();
  }

  /** Lets the reader drain only the oldest write. */
  releaseOne(error?: Error): void {
    this.callbacks.shift()?.(error);
  }

  get held(): number {
    return this.callbacks.length;
  }
}

function fakeConsole(): Console {
  const calls: unknown[][] = [];
  const record = (...args: unknown[]) => void calls.push(args);
  return { log: record, info: record, debug: record, warn: record, error: record } as never;
}

let installed: InstalledBoundedConsole | null = null;
afterEach(() => {
  installed?.uninstall();
  installed = null;
});

function install(maxPendingBytes = 64) {
  const stdout = new HeldStream();
  const stderr = new HeldStream();
  const target = fakeConsole();
  let clock = Date.parse("2026-10-28T02:22:55.000Z");
  installed = installBoundedConsole({
    stdout,
    stderr,
    console: target,
    maxPendingBytes,
    label: "[Test]",
    now: () => clock,
  });
  return { stdout, stderr, target, advance: (ms: number) => (clock += ms) };
}

describe("bounded console", () => {
  test("formats like console and routes levels to stdout and stderr", () => {
    const { stdout, stderr, target } = install(1024);
    target.log("a %s %d", "b", 3, { c: 1 });
    target.info("info");
    target.debug("debug");
    target.warn("warn");
    target.error(new Error("boom").message);
    expect(stdout.written).toEqual(["a b 3 { c: 1 }\n", "info\n", "debug\n"]);
    expect(stderr.written).toEqual(["warn\n", "boom\n"]);
  });

  test("never waits on the stream: a stalled reader costs bounded memory and drops are counted", () => {
    const { stdout, target } = install(64);
    const line = "x".repeat(19); // 20 bytes with the newline
    for (let index = 0; index < 10; index += 1) target.log(line);

    // Three lines fit under the 64-byte bound; the rest are dropped, not queued.
    expect(stdout.written).toHaveLength(3);
    expect(installed!.stats().stdout).toMatchObject({
      pendingBytes: 60,
      writtenLines: 0,
      droppedLines: 7,
      droppedBytes: 140,
      unreportedDroppedLines: 7,
      stalledSince: "2026-10-28T02:22:55.000Z",
    });
    expect(boundedConsoleStats()?.stdout.droppedLines).toBe(7);
  });

  test("reports the gap once the reader drains, then writes normally again", () => {
    const { stdout, target, advance } = install(64);
    for (let index = 0; index < 5; index += 1) target.log("x".repeat(19));
    advance(24_322_000);
    stdout.drain();

    const marker = stdout.written.at(-1)!;
    expect(marker).toBe(
      "[Test] Dropped 2 log line(s) (40 bytes) from 2026-10-28T02:22:55.000Z to " +
        "2026-10-28T09:08:17.000Z: the log reader was not draining output; this process kept serving.\n",
    );
    expect(installed!.stats().stdout).toMatchObject({
      pendingBytes: 0,
      droppedLines: 2,
      unreportedDroppedLines: 0,
      stalledSince: null,
    });

    target.log("after");
    expect(stdout.written.at(-1)).toBe("after\n");
    stdout.drain();
    expect(stdout.written.filter((chunk) => chunk.includes("Dropped"))).toHaveLength(1);
  });

  test("reports the gap while output keeps arriving, without waiting for an empty backlog", () => {
    const { stdout, target } = install(1_000);
    const line = "y".repeat(199);
    for (let index = 0; index < 6; index += 1) target.log(line);
    expect(installed!.stats().stdout).toMatchObject({ writtenLines: 0, droppedLines: 1 });

    // A slow reader: one write drains, then another line arrives.
    stdout.releaseOne();
    target.log(line);
    stdout.releaseOne();
    target.log(line);
    // Still above half the bound (600 > 500): drops continue instead of
    // alternating with single written lines.
    expect(installed!.stats().stdout).toMatchObject({ pendingBytes: 600, droppedLines: 3 });

    stdout.releaseOne();
    expect(stdout.written.at(-1)).toContain("[Test] Dropped 3 log line(s) (600 bytes)");
    target.log("resumed");
    expect(stdout.written.at(-1)).toBe("resumed\n");
    expect(installed!.stats().stdout.unreportedDroppedLines).toBe(0);
    expect(installed!.stats().stdout.pendingBytes).toBeGreaterThan(0);
  });

  test("writes a line longer than the bound when nothing is pending", () => {
    const { stdout, target } = install(8);
    target.log("a line longer than eight bytes");
    expect(stdout.written).toEqual(["a line longer than eight bytes\n"]);
    target.log("dropped while the long line is pending");
    expect(stdout.written).toHaveLength(1);
  });

  test("flush waits for pending output and gives up at its deadline", async () => {
    const { stdout, target } = install(1024);
    target.log("pending");
    let flushed = false;
    const flush = installed!.flush(5_000).then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false);
    stdout.drain();
    await flush;
    expect(flushed).toBe(true);

    target.log("held forever");
    const started = performance.now();
    await installed!.flush(20);
    expect(stdout.held).toBe(1);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test.each(["throw", "callback", "sync-callback"] as const)(
    "%s failures count lost lines and UTF-8 bytes without marker retries",
    async (mode) => {
      const target = fakeConsole();
      const callbacks: Array<() => void> = [];
      const writes: string[] = [];
      const broken: BoundedConsoleStream = {
        write: (chunk, callback) => {
          writes.push(chunk);
          if (mode === "throw") throw new Error("stream destroyed");
          if (mode === "sync-callback") callback(new Error("stream destroyed"));
          else callbacks.push(() => callback(new Error("stream destroyed")));
          return false;
        },
      };
      installed = installBoundedConsole({ stdout: broken, stderr: broken, console: target });
      target.log("lost é");
      target.error("lost error");
      const flush = installed.flush(5_000);
      for (const callback of callbacks) callback();
      await flush;
      expect(installed.stats().stdout).toMatchObject({
        pendingBytes: 0,
        writtenLines: 0,
        failedLines: 1,
        failedBytes: Buffer.byteLength("lost é\n"),
        droppedLines: 0,
        unreportedDroppedLines: 0,
      });
      expect(installed.stats().stderr).toMatchObject({
        pendingBytes: 0,
        writtenLines: 0,
        failedLines: 1,
        failedBytes: Buffer.byteLength("lost error\n"),
      });
      expect(writes).toEqual(["lost é\n", "lost error\n"]);
    },
  );

  test("pending output is successful only after its callback succeeds", () => {
    const { stdout, target } = install();
    target.log("pending");
    expect(installed!.stats().stdout).toMatchObject({ pendingBytes: 8, writtenLines: 0 });
    stdout.drain();
    expect(installed!.stats().stdout).toMatchObject({
      pendingBytes: 0,
      writtenLines: 1,
      failedLines: 0,
      failedBytes: 0,
    });
  });

  test("failed callbacks settle a flush without attempting a gap marker", async () => {
    const { stdout, target } = install();
    for (let index = 0; index < 5; index += 1) target.log("x".repeat(19));
    const flush = installed!.flush(5_000);
    for (let index = 0; index < 3; index += 1) stdout.releaseOne(new Error("broken"));
    await flush;
    expect(stdout.written).toHaveLength(3);
    expect(installed!.stats().stdout).toMatchObject({
      pendingBytes: 0,
      writtenLines: 0,
      failedLines: 3,
      failedBytes: 60,
      droppedLines: 2,
      unreportedDroppedLines: 2,
    });
  });

  test.each(["throw", "callback"] as const)(
    "a gap marker lost to a %s failure terminates without recursive writes",
    async (mode) => {
      const target = fakeConsole();
      const callbacks: Array<() => void> = [];
      const writes: string[] = [];
      const stream: BoundedConsoleStream = {
        write: (chunk, callback) => {
          writes.push(chunk);
          if (chunk.includes("Dropped")) {
            if (mode === "throw") throw new Error("broken");
            callback(new Error("broken"));
          } else callbacks.push(() => callback());
          return false;
        },
      };
      installed = installBoundedConsole({
        stdout: stream,
        stderr: stream,
        console: target,
        maxPendingBytes: 64,
      });
      for (let index = 0; index < 5; index += 1) target.log("x".repeat(19));
      const flush = installed.flush(5_000);
      for (const callback of callbacks) callback();
      await flush;
      expect(writes).toHaveLength(4);
      expect(writes[3]).toContain("Dropped 2 log line(s) (40 bytes)");
      expect(installed.stats().stdout).toMatchObject({
        pendingBytes: 0,
        writtenLines: 3,
        failedLines: 1,
        failedBytes: Buffer.byteLength(writes[3]!),
        droppedLines: 2,
        unreportedDroppedLines: 0,
      });
    },
  );

  test("a callback followed by a throw settles a write only once", async () => {
    const target = fakeConsole();
    const broken: BoundedConsoleStream = {
      write: (_chunk, callback) => {
        callback(new Error("broken"));
        throw new Error("also throws");
      },
    };
    installed = installBoundedConsole({ stdout: broken, console: target });
    target.log("lost");
    await installed.flush(5_000);
    expect(installed.stats().stdout).toMatchObject({
      pendingBytes: 0,
      writtenLines: 0,
      failedLines: 1,
      failedBytes: 5,
    });
  });

  test("uninstall restores the original methods", () => {
    const target = fakeConsole();
    const original = target.log;
    const handle = installBoundedConsole({
      stdout: new HeldStream(),
      stderr: new HeldStream(),
      console: target,
    });
    expect(target.log).not.toBe(original);
    handle.uninstall();
    expect(target.log).toBe(original);
    expect(boundedConsoleStats()).toBeNull();
  });
});
