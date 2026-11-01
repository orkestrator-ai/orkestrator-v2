import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  configureLogger,
  createLogger,
  emitLogRecord,
  formatLogError,
  LOG_RECORD_PREFIX,
  parseLogRecordLine,
  renderLogLine,
  resetLogger,
  writeProcessOutputLine,
  type LogFields,
  type LogOutput,
} from "./logger.js";

let outputs: LogOutput[];

beforeEach(() => {
  outputs = [];
  configureLogger({ sink: (output) => void outputs.push(output) });
});

afterEach(resetLogger);

const log = createLogger("updater");
const lines = () => outputs.map((output) => output.line);

describe("levels", () => {
  test("defaults to info, with each level on its own console method", () => {
    log.error("check.failed");
    log.warn("check.failed");
    log.info("check.failed");
    log.debug("check.failed");
    log.trace("check.failed");
    expect(outputs.map((output) => output.method)).toEqual(["error", "warn", "info"]);
  });

  test("an area's own level overrides the default, and a parent covers its children", () => {
    configureLogger({ level: "warn", areaLevels: { desktop: "debug", updater: "error" } });
    createLogger("desktop.dialog").debug("opening");
    createLogger("desktop.startup").debug("ready");
    log.warn("check.failed");
    log.error("check.failed");
    createLogger("preview").info("node.record-failed");
    expect(lines()).toEqual([
      "[desktop.dialog] opening",
      "[DesktopStartup] ready",
      "[updater] check.failed",
    ]);
  });

  test("a child's own level beats its parent's", () => {
    configureLogger({ areaLevels: { desktop: "error", "desktop.dialog": "debug" } });
    expect(createLogger("desktop.dialog").isEnabled("debug")).toBe(true);
    expect(createLogger("desktop").isEnabled("warn")).toBe(false);
  });

  test("a logger follows a later configuration", () => {
    expect(log.isEnabled("debug")).toBe(false);
    configureLogger({ level: "trace" });
    expect(log.isEnabled("trace")).toBe(true);
    configureLogger({ level: "error" });
    expect(log.isEnabled("warn")).toBe(false);
  });

  test("trace goes out as debug, never console.trace", () => {
    configureLogger({ level: "trace" });
    log.trace("check.failed");
    expect(outputs[0]?.method).toBe("debug");
    expect(outputs[0]?.record?.level).toBe("trace");
  });
});

describe("hot paths", () => {
  test("a fields function runs only when the level is on", () => {
    const build = mock(() => ({ attempt: 1 }));
    log.debug("check.failed", build);
    expect(build).not.toHaveBeenCalled();
    log.info("check.failed", build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(lines()).toEqual(["[updater] check.failed attempt=1"]);
  });

  test("a throwing fields function or sink never reaches the caller", () => {
    log.info("check.failed", () => {
      throw new Error("private");
    });
    expect(lines()).toEqual(["[updater] check.failed fieldsFailed=true"]);
    configureLogger({
      sink: () => {
        throw new Error("disk full");
      },
    });
    expect(() => log.error("check.failed")).not.toThrow();
    expect(() => writeProcessOutputLine("stderr", "line")).not.toThrow();
  });
});

describe("restricted fields", () => {
  test("the types refuse anything but scalars and formatted errors", () => {
    log.info("check.failed", {
      text: "ok",
      count: 1,
      flag: true,
      nothing: null,
      missing: undefined,
      error: formatLogError(new Error("x")),
    });
    // @ts-expect-error a raw object cannot be logged.
    log.info("check.failed", { raw: { nested: 1 } });
    // @ts-expect-error a raw error must go through formatLogError.
    log.info("check.failed", { error: new Error("x") });
    // @ts-expect-error an array is not a scalar.
    log.info("check.failed", { list: [1, 2] });
    // @ts-expect-error a field named for command output is refused.
    log.info("check.failed", { stdout: "output" });
    // @ts-expect-error a field named for a credential is refused.
    log.info("check.failed", { token: "abc" });
    // @ts-expect-error the event must be listed for this area.
    log.info("not-an-event");
    // @ts-expect-error another area's event is not listed for this one.
    log.info("opening");
    // @ts-expect-error the area must be listed.
    createLogger("legacy");
    expect(outputs.length).toBeGreaterThan(0);
  });

  test("at runtime a raw object, array, function or symbol becomes a marker", () => {
    const fields = {
      object: { prompt: "private text" },
      list: ["private text"],
      fn: () => "private text",
      symbol: Symbol("private"),
      big: 12n,
    } as unknown as LogFields;
    log.info("check.failed", fields);
    expect(outputs[0]?.record?.fields).toEqual({
      object: "[rejected:object]",
      list: "[rejected:object]",
      fn: "[rejected:function]",
      symbol: "[rejected:symbol]",
      big: "12",
    });
    expect(lines()[0]).not.toContain("private");
  });

  test("at runtime a raw error takes the safe formatter's path", () => {
    const failure = Object.assign(new Error("boom"), { stdout: "private output" });
    log.warn("check.failed", { error: failure } as unknown as LogFields);
    expect(lines()[0]).not.toContain("private output");
    expect(lines()[0]).not.toContain("boom");
    expect(lines()[0]).toContain("error.outputOmitted=true");
  });

  test("a value under a forbidden name never appears, whatever its case", () => {
    log.info("check.failed", {
      STDERR: "private",
      api_key: "private",
      Prompt: "private",
    } as unknown as LogFields);
    expect(outputs[0]?.record?.fields).toEqual({
      STDERR: "[forbidden]",
      api_key: "[forbidden]",
      Prompt: "[forbidden]",
    });
  });

  test("bounds string length and field count, and rejects odd names", () => {
    const fields: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) fields[`f${index}`] = "x";
    fields["bad name"] = "private";
    log.info("check.failed", fields);
    const logged = outputs[0]?.record?.fields ?? {};
    expect(Object.keys(logged)).toHaveLength(33);
    expect(logged.droppedFields).toBe(9);
    expect(JSON.stringify(logged)).not.toContain("private");
    outputs.length = 0;
    log.info("check.failed", { long: "y".repeat(5000) });
    const long = String(outputs[0]?.record?.fields?.long);
    expect(long).toEndWith("...[truncated 2984 chars]");
    expect(long.length).toBeLessThanOrEqual(2048);
  });

  test("an event outside the vocabulary is logged without its text", () => {
    log.info("private dynamic text" as never);
    expect(lines()).toEqual(["[updater] invalid-event"]);
  });

  test("an unknown area is reported without its name or fields", () => {
    createLogger("legacy" as never).info("x" as never, { a: "private" } as never);
    expect(lines()).toEqual(["[logging] unknown-area"]);
  });
});

describe("output", () => {
  test("text keeps the [tag] event form, quoting only what needs it", () => {
    log.warn("check.failed", {
      version: "1.2.3",
      path: "/tmp/a",
      spaced: "two words",
      quote: 'a"b',
      nothing: null,
      count: 0,
      ok: false,
      missing: undefined,
    });
    expect(lines()[0]).toBe(
      '[updater] check.failed version=1.2.3 path=/tmp/a spaced="two words" quote="a\\"b" nothing=null count=0 ok=false',
    );
  });

  test("a tagged area keeps the exact text support recipes search for", () => {
    createLogger("desktop.startup").info("renderer-gone", { reason: "oom" });
    expect(lines()).toEqual(["[DesktopStartup] renderer-gone reason=oom"]);
  });

  test("text flattens a formatted error", () => {
    const error = new Error("offline", { cause: new TypeError("inner") });
    log.warn("check.failed", { error: formatLogError(error, { stack: false }) });
    expect(lines()[0]).toBe(
      "[updater] check.failed error.name=Error error.message=offline error.cause.name=TypeError error.cause.message=inner",
    );
  });

  test("every entry is one line whatever a value holds, in both formats", () => {
    const hostile = "a\nb\r\nc\u2028d\u2029e\u0085f\u001b[31m";
    for (const format of ["text", "json"] as const) {
      outputs.length = 0;
      configureLogger({ format });
      log.warn("check.failed", { text: hostile });
      const line = lines()[0]!;
      // Node's readline, which the relay uses, also ends lines at U+2028/9.
      expect(line.split(/\r\n|\n|\r|\u2028|\u2029/)).toHaveLength(1);
      // oxlint-disable-next-line no-control-regex -- proving no raw escape reaches a terminal
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  });

  test("JSON lines start with the versioned prefix and carry level, area and event", () => {
    configureLogger({ format: "json" });
    log.warn("check.failed", {
      attempt: 2,
      error: formatLogError(new Error("x"), { stack: false }),
    });
    const line = lines()[0]!;
    expect(line.startsWith(LOG_RECORD_PREFIX)).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.ts).toEqual(expect.any(String));
    expect(parsed).toMatchObject({
      orklog: 1,
      level: "warn",
      area: "updater",
      event: "check.failed",
      fields: { attempt: 2, error: { name: "Error", message: "x" } },
    });
  });

  test("renderLogLine gives the writer that cannot use the console the same line", () => {
    expect(renderLogLine("warn", "logging", "entries.dropped", { entries: 2 })).toBe(
      "[logging] entries.dropped entries=2",
    );
  });
});

describe("relay", () => {
  const relayed = () => {
    configureLogger({ format: "json" });
    log.warn("check.failed", {
      attempt: 1,
      error: formatLogError(new Error("offline"), { stack: false }),
    });
    const line = lines()[0]!;
    outputs.length = 0;
    configureLogger({ format: "text" });
    return line;
  };

  test("a record round-trips, level and fields intact, and is re-rendered locally", () => {
    const record = parseLogRecordLine(relayed());
    expect(record).not.toBeNull();
    emitLogRecord(record!);
    expect(outputs[0]?.method).toBe("warn");
    expect(lines()).toEqual([
      "[updater] check.failed attempt=1 error.name=Error error.message=offline",
    ]);
  });

  test("a value cut at the source is not cut again by the relay", () => {
    configureLogger({ format: "json" });
    log.warn("check.failed", {
      long: "y".repeat(5000),
      error: formatLogError(new Error("m".repeat(5000)), { stack: false }),
    });
    const line = lines()[0]!;
    const record = parseLogRecordLine(line)!;
    expect(JSON.stringify(record.fields)).toBe(JSON.stringify(JSON.parse(line).fields));
  });

  test("the relay never filters: the source already applied its level", () => {
    const record = parseLogRecordLine(relayed());
    configureLogger({ level: "error" });
    emitLogRecord(record!);
    expect(outputs).toHaveLength(1);
  });

  test.each([
    ["plain output", "[backend] something"],
    ["a bare JSON object", '{"level":"warn"}'],
    ["a broken record", '{"orklog":1,"level":'],
    [
      "an unknown level",
      '{"orklog":1,"ts":"t","level":"fatal","area":"updater","event":"downloaded"}',
    ],
    [
      "an unknown area",
      '{"orklog":1,"ts":"t","level":"warn","area":"legacy","event":"downloaded"}',
    ],
    ["an unknown event", '{"orklog":1,"ts":"t","level":"warn","area":"updater","event":"nope"}'],
    ["an inherited area", '{"orklog":1,"ts":"t","level":"warn","area":"__proto__","event":"x"}'],
    [
      "an inherited event",
      '{"orklog":1,"ts":"t","level":"warn","area":"updater","event":"toString"}',
    ],
  ])("%s is not a record, so the caller keeps it as output", (_name, line) => {
    expect(parseLogRecordLine(line)).toBeNull();
  });

  test("output imitating a record gets the same field validation as a local call", () => {
    const record = parseLogRecordLine(
      JSON.stringify({
        orklog: 1,
        ts: "t",
        level: "warn",
        area: "updater",
        event: "downloaded",
        fields: {
          stdout: "private",
          nested: { a: "private" },
          long: "y".repeat(5000),
          error: {
            name: "Error",
            message: `token=abcdefghijkl ${"z".repeat(5000)}`,
            extra: "private",
          },
        },
      }),
    )!;
    const text = JSON.stringify(record.fields);
    expect(text).not.toContain("private");
    expect(text).not.toContain("abcdefghijkl");
    expect(record.fields?.stdout).toBe("[forbidden]");
    expect(record.fields?.nested).toBe("[rejected:object]");
    expect(text.length).toBeLessThan(4000);
  });

  test("process output keeps its stream and bypasses levels", () => {
    configureLogger({ level: "error" });
    writeProcessOutputLine("stdout", "[Backend] a");
    writeProcessOutputLine("stderr", "[Backend] b");
    expect(outputs).toEqual([
      { method: "log", line: "[Backend] a" },
      { method: "error", line: "[Backend] b" },
    ]);
  });
});

describe("console sink", () => {
  test("reads the console method at call time, so production logging's tee sees it", () => {
    resetLogger();
    const original = console.warn;
    const replaced = mock((..._args: unknown[]) => undefined);
    console.warn = replaced;
    try {
      log.warn("check.failed");
    } finally {
      console.warn = original;
    }
    expect(replaced).toHaveBeenCalledWith("[updater] check.failed");
  });
});
