import { afterEach, describe, expect, test } from "bun:test";
import { configureLogger, resetLogger, type LogRecord } from "@orkestrator/protocol/logger";
import { MAX_RENDERER_ERROR_BATCH } from "@orkestrator/protocol/renderer-errors";
import {
  RENDERER_ERROR_CLIENTS_PER_WINDOW,
  RENDERER_ERROR_ENTRIES_PER_CLIENT,
  RENDERER_ERROR_ENTRIES_PER_WINDOW,
  RENDERER_ERROR_WINDOW_MS,
  RendererErrorRecorder,
} from "./renderer-error-recorder.js";

const entry = {
  errorClass: "TypeError",
  boundary: "message-row",
  route: "window",
  fingerprint: "0a1b2c3d",
  count: 4,
};

function capture() {
  const essential: LogRecord[] = [];
  const lines: string[] = [];
  configureLogger({
    level: "error",
    essentialSink: (record) => essential.push(record),
    sink: (output) => lines.push(output.line),
  });
  return { essential, lines };
}

afterEach(() => resetLogger());

describe("recording renderer errors", () => {
  test("each entry reaches the essential log whatever the level, with its five fields", () => {
    const { essential } = capture();
    const result = new RendererErrorRecorder(() => 0).record([entry]);
    expect(result).toEqual({ accepted: 1, dropped: 0 });
    expect(essential).toHaveLength(1);
    expect(essential[0]?.area).toBe("renderer-errors");
    expect(essential[0]?.event).toBe("error.recorded");
    expect(essential[0]?.fields).toEqual(entry);
  });

  test("a message or stack is refused, so it is never stored", () => {
    const { essential, lines } = capture();
    const recorder = new RendererErrorRecorder(() => 0);
    const secret = "TypeError: cannot read prompt text at /Users/someone/project/file.ts:1:1";
    expect(() => recorder.record([{ ...entry, message: secret }])).toThrow();
    expect(() => recorder.record([{ ...entry, stack: secret }])).toThrow();
    expect(() => recorder.record([{ ...entry, boundary: secret }])).toThrow();
    expect(() => recorder.record("not a list")).toThrow();
    expect(essential).toHaveLength(0);
    expect(lines.join("\n")).not.toContain("someone");
  });

  test("a batch over the bound is refused", () => {
    capture();
    expect(() =>
      new RendererErrorRecorder(() => 0).record(
        Array.from({ length: MAX_RENDERER_ERROR_BATCH + 1 }, () => entry),
      ),
    ).toThrow();
  });

  test("writes are bound per minute; the rest are counted once and dropped", () => {
    const { essential } = capture();
    let now = 0;
    const recorder = new RendererErrorRecorder(() => now, 3);
    expect(recorder.record([entry, entry])).toEqual({ accepted: 2, dropped: 0 });
    expect(recorder.record([entry, entry])).toEqual({ accepted: 1, dropped: 1 });
    expect(recorder.record([entry])).toEqual({ accepted: 0, dropped: 1 });
    expect(essential.filter((record) => record.event === "error.recorded")).toHaveLength(3);
    now += RENDERER_ERROR_WINDOW_MS;
    expect(recorder.record([entry])).toEqual({ accepted: 1, dropped: 0 });
  });

  test("the complete dropped count is reported once when the window rolls over", () => {
    const { lines } = capture();
    configureLogger({ level: "warn" });
    let now = 0;
    const recorder = new RendererErrorRecorder(() => now, 1);
    recorder.record([entry, entry]);
    recorder.record([entry]);
    now += RENDERER_ERROR_WINDOW_MS;
    recorder.record([entry]);
    const reports = lines.filter((line) => line.includes("report.rate-limited"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("dropped=2");
  });
});

describe("each renderer's share of the minute", () => {
  const batch = (length: number) => Array.from({ length }, () => entry);

  test("one noisy tab cannot use the minute another window needs", () => {
    const { essential } = capture();
    let now = 0;
    const recorder = new RendererErrorRecorder(() => now);
    expect(recorder.record(batch(20), "noisy-tab-0001")).toEqual({
      accepted: RENDERER_ERROR_ENTRIES_PER_CLIENT,
      dropped: 20 - RENDERER_ERROR_ENTRIES_PER_CLIENT,
    });
    expect(recorder.record(batch(5), "noisy-tab-0001")).toEqual({ accepted: 0, dropped: 5 });
    expect(recorder.record(batch(3), "desktop-window-1")).toEqual({ accepted: 3, dropped: 0 });
    expect(
      essential.filter((record) => record.event === "error.recorded").map((r) => r.fields),
    ).not.toContainEqual(expect.objectContaining({ client: expect.anything() }));
    now += RENDERER_ERROR_WINDOW_MS;
    expect(recorder.record(batch(4), "noisy-tab-0001")).toEqual({ accepted: 4, dropped: 0 });
  });

  test("the shared total still bounds every share together", () => {
    capture();
    const recorder = new RendererErrorRecorder(() => 0);
    let accepted = 0;
    for (let index = 0; index < 5; index += 1) {
      accepted += recorder.record(
        batch(RENDERER_ERROR_ENTRIES_PER_CLIENT),
        `window-000${index}`,
      ).accepted;
    }
    expect(accepted).toBe(RENDERER_ERROR_ENTRIES_PER_WINDOW);
  });

  test("a write without a client (an older renderer) is bounded by the total alone", () => {
    capture();
    const recorder = new RendererErrorRecorder(() => 0);
    expect(recorder.record(batch(20))).toEqual({ accepted: 20, dropped: 0 });
    expect(recorder.record(batch(20))).toEqual({ accepted: 10, dropped: 10 });
  });

  test("ids past the tracked limit share one slot", () => {
    capture();
    const recorder = new RendererErrorRecorder(() => 0, 1_000_000);
    for (let index = 0; index < RENDERER_ERROR_CLIENTS_PER_WINDOW; index += 1) {
      recorder.record([entry], `client-${String(index).padStart(4, "0")}`);
    }
    let accepted = 0;
    for (let index = 0; index < 20; index += 1) {
      accepted += recorder.record(batch(3), `minted-${String(index).padStart(4, "0")}`).accepted;
    }
    expect(accepted).toBe(RENDERER_ERROR_ENTRIES_PER_CLIENT);
  });

  test("a malformed client id refuses the write", () => {
    const { essential } = capture();
    const recorder = new RendererErrorRecorder(() => 0);
    for (const client of ["short", "has space in it", 42, null, "x".repeat(65)]) {
      expect(() => recorder.record([entry], client)).toThrow();
    }
    expect(essential).toHaveLength(0);
  });
});

test("a quiet window still emits the total from all dropped batches", () => {
  const { lines } = capture();
  configureLogger({ level: "warn" });
  let flush: (() => void) | undefined;
  let scheduled = 0;
  const recorder = new RendererErrorRecorder(
    () => 0,
    1,
    (callback, delay) => {
      flush = callback;
      scheduled++;
      expect(delay).toBe(RENDERER_ERROR_WINDOW_MS);
      return 123 as never;
    },
  );
  recorder.record([entry, entry]);
  recorder.record([entry, entry]);
  expect(scheduled).toBe(1);
  flush!();
  expect(lines.filter((line) => line.includes("report.rate-limited"))).toHaveLength(1);
  expect(lines.join("\n")).toContain("dropped=3");
});
