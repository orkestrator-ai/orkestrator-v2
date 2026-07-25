import { describe, expect, spyOn, test } from "bun:test";
import {
  NotificationRecorder,
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
});

describe("createRecorderFromEnv", () => {
  test("is opt-in and builds deterministic sanitized filenames", () => {
    expect(createRecorderFromEnv({ generation: 1, env: {} })).toBeNull();
    const recorder = createRecorderFromEnv({
      generation: 7,
      env: {
        CODEX_BRIDGE_RECORD_NOTIFICATIONS: " /tmp/recordings ",
        CODEX_BRIDGE_RECORD_MAX_BYTES: "123",
      },
      now: () => Date.parse("2026-07-25T12:34:56.789Z"),
    });
    expect(recorder?.getStats().fileName).toBe(
      "codex-app-server-2026-07-25T12-34-56-789Z-gen7.jsonl",
    );
  });
});
