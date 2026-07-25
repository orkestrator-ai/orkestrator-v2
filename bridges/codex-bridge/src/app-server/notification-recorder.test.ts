import { describe, expect, spyOn, test } from "bun:test";
import {
  NotificationRecorder,
  RECORD_CONFIRM_ENV,
  createRecorderFromEnv,
} from "./notification-recorder.js";

describe("NotificationRecorder", () => {
  test("batches lines, creates the directory once, and reports stats", async () => {
    const writes: string[] = [];
    let mkdirCalls = 0;
    const recorder = new NotificationRecorder({
      directory: "/recordings",
      fileName: "events.jsonl",
      flushIntervalMs: 60_000,
      warnImpl: () => undefined,
      ensureDirImpl: async () => {
        mkdirCalls += 1;
      },
      appendFileImpl: async (_path, contents) => {
        writes.push(contents);
      },
    });
    recorder.record('{"one":1}');
    recorder.record('{"two":2}');
    await recorder.flush();
    recorder.record('{"three":3}');
    await recorder.close();

    expect(writes).toEqual(['{"one":1}\n{"two":2}\n', '{"three":3}\n']);
    expect(mkdirCalls).toBe(1);
    expect(recorder.getStats()).toMatchObject({
      linesRecorded: 3,
      linesDropped: 0,
      capped: false,
      writeErrors: 0,
    });
    recorder.record('{"closed":true}');
    expect(recorder.getStats().linesDropped).toBe(1);
  });

  test("caps before a partial line and emits a replay-safe notice", async () => {
    const writes: string[] = [];
    const recorder = new NotificationRecorder({
      directory: "/recordings",
      fileName: "capped.jsonl",
      maxBytes: 6,
      flushIntervalMs: 60_000,
      warnImpl: () => undefined,
      ensureDirImpl: async () => undefined,
      appendFileImpl: async (_path, contents) => writes.push(contents),
    });
    recorder.record("12345");
    recorder.record("x");
    await recorder.close();

    expect(writes.join("")).toContain("recording stopped: max bytes reached");
    expect(writes.join("")).not.toContain("\nx\n");
    expect(recorder.getStats()).toMatchObject({
      linesRecorded: 1,
      linesDropped: 1,
      capped: true,
    });
  });

  test("write failures are counted, dropped, and do not reject close", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const recorder = new NotificationRecorder({
        directory: "/recordings",
        fileName: "broken.jsonl",
        flushIntervalMs: 60_000,
        warnImpl: () => undefined,
        ensureDirImpl: async () => undefined,
        appendFileImpl: async () => {
          throw new Error("disk full");
        },
      });
      recorder.record("{}");
      await expect(recorder.close()).resolves.toBeUndefined();
      expect(recorder.getStats()).toMatchObject({
        writeErrors: 1,
        linesDropped: 1,
      });
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  test("the scheduled timer flushes without anyone awaiting it", async () => {
    // The read loop only ever calls record(); if the timer path were broken,
    // nothing would reach disk until close(), and a crashed bridge would leave
    // an empty recording.
    const writes: string[] = [];
    const recorder = new NotificationRecorder({
      directory: "/recordings",
      fileName: "timer.jsonl",
      flushIntervalMs: 5,
      warnImpl: () => undefined,
      ensureDirImpl: async () => undefined,
      appendFileImpl: async (_path, contents) => {
        writes.push(contents);
      },
    });

    recorder.record('{"one":1}');
    recorder.record('{"two":2}');
    expect(writes).toEqual([]);
    await Bun.sleep(30);
    expect(writes).toEqual(['{"one":1}\n{"two":2}\n']);

    // The timer is one-shot per batch: a later line schedules a new one.
    recorder.record('{"three":3}');
    await Bun.sleep(30);
    expect(writes).toEqual(['{"one":1}\n{"two":2}\n', '{"three":3}\n']);
    await recorder.close();
    expect(recorder.getStats()).toMatchObject({ linesRecorded: 3, writeErrors: 0 });
  });

  test("overlapping flushes serialize instead of interleaving lines", async () => {
    const order: string[] = [];
    let releaseFirst = () => {};
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let writeCount = 0;
    const recorder = new NotificationRecorder({
      directory: "/recordings",
      fileName: "serial.jsonl",
      flushIntervalMs: 60_000,
      warnImpl: () => undefined,
      ensureDirImpl: async () => undefined,
      appendFileImpl: async (_path, contents) => {
        writeCount += 1;
        order.push(`start:${contents.trim()}`);
        // Hold the first append open while the second flush is issued.
        if (writeCount === 1) await firstWrite;
        order.push(`end:${contents.trim()}`);
      },
    });

    recorder.record("a");
    const first = recorder.flush();
    // Let the first flush claim the buffer and enter the append before the
    // second batch exists; otherwise both lines coalesce into one write and the
    // serialization is never exercised.
    await Bun.sleep(1);
    expect(order).toEqual(["start:a"]);

    recorder.record("b");
    const second = recorder.flush();
    // The second append must not have begun while the first is still in flight.
    await Bun.sleep(10);
    expect(order).toEqual(["start:a"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("a live recording keeps re-announcing itself, not just at startup", async () => {
    // A recording started by a stray `.env` entry outlives the scrollback that
    // mentioned it, so a single startup line is not a signal anyone will see.
    const warnings: string[] = [];
    let clock = 1_000;
    const recorder = new NotificationRecorder({
      directory: "/recordings",
      fileName: "warned.jsonl",
      flushIntervalMs: 60_000,
      warnIntervalMs: 100,
      now: () => clock,
      warnImpl: (message) => warnings.push(message),
      ensureDirImpl: async () => undefined,
      appendFileImpl: async () => undefined,
    });

    recorder.record("a");
    await recorder.flush();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/recordings/warned.jsonl");
    expect(warnings[0]).toContain("Prompts, file contents and absolute paths");

    // Still inside the interval: no repeat.
    clock += 50;
    recorder.record("b");
    await recorder.flush();
    expect(warnings).toHaveLength(1);

    clock += 100;
    recorder.record("c");
    await recorder.flush();
    expect(warnings).toHaveLength(2);

    // An idle recorder has nothing to flush and stays quiet.
    clock += 10_000;
    await recorder.flush();
    expect(warnings).toHaveLength(2);
  });
});

describe("createRecorderFromEnv", () => {
  test("is opt-in and builds deterministic sanitized filenames", () => {
    expect(createRecorderFromEnv({ generation: 1, env: {} })).toBeNull();
    const recorder = createRecorderFromEnv({
      generation: 7,
      env: {
        CODEX_BRIDGE_RECORD_NOTIFICATIONS: " /tmp/recordings ",
        [RECORD_CONFIRM_ENV]: "1",
        CODEX_BRIDGE_RECORD_MAX_BYTES: "123",
      },
      now: () => Date.parse("2026-07-25T12:34:56.789Z"),
      warn: () => undefined,
    });
    expect(recorder?.getStats().fileName).toBe(
      "codex-app-server-2026-07-25T12-34-56-789Z-gen7.jsonl",
    );
  });

  /**
   * Bun auto-loads `.env`, so a directory on its own is one stray checked-in
   * line away from writing every prompt and every file the agent reads to disk,
   * indefinitely and unrotated. The second variable is the acknowledgement.
   */
  test("a directory alone does not start recording", () => {
    const warnings: string[] = [];
    const recorder = createRecorderFromEnv({
      generation: 1,
      env: { CODEX_BRIDGE_RECORD_NOTIFICATIONS: "/tmp/recordings" },
      warn: (message) => warnings.push(message),
    });

    expect(recorder).toBeNull();
    // Silence would be worse than the capture: the developer asked for a
    // recording and has to learn they are not getting one.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(RECORD_CONFIRM_ENV);
    expect(warnings[0]).toContain("Not recording");
  });

  test("only an exact acknowledgement counts", () => {
    for (const confirm of ["", " ", "0", "true", "yes", "01"]) {
      expect(createRecorderFromEnv({
        generation: 1,
        env: {
          CODEX_BRIDGE_RECORD_NOTIFICATIONS: "/tmp/recordings",
          [RECORD_CONFIRM_ENV]: confirm,
        },
        warn: () => undefined,
      })).toBeNull();
    }
    expect(createRecorderFromEnv({
      generation: 1,
      env: {
        CODEX_BRIDGE_RECORD_NOTIFICATIONS: "/tmp/recordings",
        [RECORD_CONFIRM_ENV]: " 1 ",
      },
      warn: () => undefined,
    })).not.toBeNull();
  });

  test("the acknowledgement alone records nothing and says nothing", () => {
    const warnings: string[] = [];
    expect(createRecorderFromEnv({
      generation: 1,
      env: { [RECORD_CONFIRM_ENV]: "1" },
      warn: (message) => warnings.push(message),
    })).toBeNull();
    expect(warnings).toEqual([]);
  });
});
